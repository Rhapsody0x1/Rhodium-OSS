// Run against an offline plugin or recording. Optional sibling conformance.json describes its test inputs.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { IMPORT_ID_RE, MAX_LINE_BYTES, checkPluginIcon, isImportBlock, compareSemver, isAgentReady, validateImCapabilities, validateManifest, type Capabilities } from "@rhodium-oss/plugin-sdk";
import { Peer, bounded, check, childEnv, nonempty, object, sensitiveKey, type Frame, type Options } from "./lib/conformance-peer";

const ok = (n: number, description: string) => console.log("ok " + n + " - " + description);
const json = (path: string) => JSON.parse(readFileSync(path, "utf8")) as unknown;
const strings = (v: unknown): v is Record<string, string> => object(v) && Object.values(v).every(x => typeof x === "string");

type Fixture = {
  normalText?: string; interruptText?: string; askText?: string; deliveredText?: string; failureText?: string;
  chat?: string; replyTo?: string; failureChat?: string; kept?: Record<string, string>; stateless?: boolean; localPlatform?: boolean;
  importSession?: string;
  wizardInputs?: Record<string, string>;
};

function fixtureAt(dir: string): Fixture {
  const path = join(dir, "conformance.json");
  if (!existsSync(path)) return {};
  const f = json(path);
  check(object(f), "conformance.json must be an object");
  for (const key of ["normalText", "interruptText", "askText", "deliveredText", "failureText", "chat", "replyTo", "failureChat", "importSession"]) {
    check(f[key] === undefined || nonempty(f[key]), "Invalid fixture field: " + key);
  }
  check(f.kept === undefined || strings(f.kept), "Fixture kept must map keys to string values");
  check(f.askText === undefined || nonempty(f.deliveredText), "askText requires a downstream deliveredText marker");
  check(f.stateless === undefined || typeof f.stateless === "boolean", "Invalid stateless fixture flag");
  check(f.localPlatform === undefined || typeof f.localPlatform === "boolean", "Invalid localPlatform fixture flag");
  check(f.wizardInputs === undefined || strings(f.wizardInputs), "Fixture wizardInputs must map labels to string values");
  return f as Fixture;
}

async function verifyEnv(o: Options) {
  const probe = Bun.spawn([process.execPath, "-e", "console.log(JSON.stringify(Object.keys(process.env)))"], {
    cwd: o.cwd, env: childEnv(o.dir), windowsHide: true, stdin: "ignore", stdout: "pipe", stderr: "ignore",
  });
  try {
    const [code, output] = await bounded(Promise.all([probe.exited, new Response(probe.stdout).text()]), o.ms, "child environment probe");
    check(code === 0 && !(JSON.parse(output) as string[]).some(sensitiveKey), "Sensitive keys present in plugin launch environment");
  } finally { if (probe.exitCode === null) probe.kill(); }
}

function agentInit(o: Options) {
  return { type: "init", proto: 1, conv: "conf-conv-1", session: { new: "conf-session-1" }, cwd: o.cwd,
    systemPromptFile: join(o.cwd, "system-prompt.md"), program: o.manifest.kind === "agent" && o.manifest.program,
    approval: false, model: null, effort: null, resumed: false, config: o.config };
}
function checkReady(frame: Frame) {
  check(isAgentReady(frame), "Invalid agent ready handshake");
}

async function ready(p: Peer) {
  p.write(agentInit(p.options));
  checkReady(await p.wait(0, () => true, "agent ready"));
}

function send(p: Peer, id: string, text: string): number {
  const from = p.frames.length;
  p.write({ type: "send", id, text, human: true, mode: "turn" });
  return from;
}
async function normalTurn(p: Peer, text: string) {
  const id = "conf-in-1", from = send(p, id, text);
  const end = await p.wait(from, f => f.type === "turn_end" || f.type === "error", "normal turn_end");
  const turn = p.frames.slice(from, p.frames.indexOf(end) + 1);
  check(end.type === "turn_end" && turn.some(f => f.type === "taken" && f.inputId === id)
    && turn.some(f => f.type === "turn_start" && (f.input === id || f.input === undefined))
    && (nonempty(end.reply) || turn.some(f => f.type === "text_delta" && nonempty(f.text)
      || f.type === "item" && object(f.item) && f.item.kind === "message" && nonempty(f.item.text))), "Incomplete normal agent turn");
}

async function testAnswer(p: Peer, fixture: Fixture) {
  if (!fixture.askText) {
    const from = p.frames.length;
    p.write({ type: "command", id: "unsupported", name: "__conformance_unsupported__", args: "" });
    const r = await p.wait(from, m => m.type === "command_result" && m.id === "unsupported", "unsupported command result");
    check(r.ok === false && nonempty(r.error), "Unsupported command must return ok:false and an error");
    return "unsupported command rejected";
  }
  const from = send(p, "conf-ask", fixture.askText);
  const ask = await p.wait(from, f => f.type === "ask", "offline permission request");
  check(ask.kind === "permission" && nonempty(ask.requestId), "Expected offline permission request with requestId");
  const resolved = (f: Frame) => f.type === "ask_resolved" && f.requestId === ask.requestId;
  check(!p.frames.slice(from).some(resolved), "Permission acknowledged before an answer was sent");
  const answer = { type: "answer", requestId: ask.requestId, answer: { kind: "permission", allow: true } };
  p.write(answer);
  p.write(answer);
  const ack = await p.wait(from, resolved, "ask_resolved");
  await p.wait(from, f => f.type === "turn_end", "answered turn_end");
  const deliveries = p.frames.slice(from).filter(f => f.type === "item" && object(f.item) && f.item.kind === "tool" && object(f.item.result) && f.item.result.text === fixture.deliveredText);
  check(deliveries.length === 1 && p.frames.indexOf(deliveries[0]!) < p.frames.indexOf(ack),
    "Expected exactly one downstream receipt before ask_resolved");
  return "repeated answer, one downstream receipt before acknowledgement";
}

async function failureProbe(o: Options, fixture: Fixture, probe: "malformed" | "oversize" | "failure" | "handshake") {
  const p = new Peer(o);
  try {
    if (probe === "handshake") {
      p.write({ ...agentInit(o), proto: 999 });
      const error = await p.wait(0, () => true, "unsupported protocol version");
      check(error.type === "fatal" && nonempty(error.message), "Unsupported init version must return fatal");
      return;
    }
    await ready(p);
    const from = p.frames.length;
    if (probe === "malformed") p.proc.stdin.write("{bad json}\n");
    else if (probe === "oversize") {
      // A syntactically valid JSON line one byte above the cap: invalid JSON alone cannot pass this probe.
      const chunk = "x".repeat(1024 * 1024);
      const deadline = Date.now() + o.ms;
      const prefix = '{"type":"command","id":"large","name":"status","args":"';
      const suffix = '"}';
      const padding = MAX_LINE_BYTES + 1 - prefix.length - suffix.length;
      p.proc.stdin.write(prefix);
      for (let written = 0; written < padding;) {
        const size = Math.min(chunk.length, padding - written);
        p.proc.stdin.write(chunk.slice(0, size));
        check(Date.now() < deadline, "Timed out writing oversize input");
        await bounded(Promise.resolve(p.proc.stdin.flush()), deadline - Date.now(), "oversize input write");
        written += size;
      }
      p.proc.stdin.write(suffix + "\n");
    } else send(p, "conf-failure", fixture.failureText!);
    const e = await p.wait(from, f => f.type === "error" || f.type === "fatal", probe + " error");
    check(e.type === "fatal" ? nonempty(e.message) : nonempty(e.detail), "Missing diagnostic for " + probe);
  } finally { await p.clean(); }
}

async function testAgent(o: Options, fixture: Fixture) {
  writeFileSync(join(o.cwd, "system-prompt.md"), "Offline conformance test\n");
  await verifyEnv(o);
  ok(2, "sanitized child environment");
  const p = new Peer(o);
  try {
    await ready(p);
    ok(3, "ready handshake");
    await normalTurn(p, fixture.normalText ?? "hello conformance");
    ok(4, "taken, turn_start, reply and turn_end");
    ok(5, await testAnswer(p, fixture));
    const from = send(p, "conf-interrupt", fixture.interruptText ?? "wait for interruption");
    await p.wait(from, f => f.type === "turn_start", "interruptible turn_start");
    check(!p.frames.slice(from).some(f => f.type === "turn_end"), "Offline turn already finished; configure interruptText for a pending turn");
    const cut = p.frames.length;
    p.write({ type: "interrupt" });
    const interrupted = await p.wait(cut, f => f.type === "turn_end", "interrupted turn_end");
    if (fixture.askText && fixture.askText === fixture.interruptText) {
      check(!nonempty(interrupted.reply), "Interrupted permission turn unexpectedly produced a final answer");
    }
    p.observeChildren();
    p.write({ type: "close" });
    await p.exited();
    ok(6, "active turn interrupted, close and child exit");
  } finally { await p.clean(); }
  await failureProbe(o, fixture, "malformed");
  await failureProbe(o, fixture, "oversize");
  await failureProbe(o, fixture, fixture.failureText ? "failure" : "handshake");
  ok(7, fixture.failureText ? "malformed JSON, oversized line and simulated runtime failure" : "malformed JSON, oversized line and failed-version handshake");
  if (o.manifest.kind === "agent" && o.manifest.import) {
    await testImport(o, fixture);
    ok(8, "conversation import query");
  }
}

/** One query per process (spec §3.5): list with dir null, then read importSession if given. */
async function testImport(o: Options, fixture: Fixture) {
  const program = o.manifest.kind === "agent" ? o.manifest.program : null;
  const ask = async (q: Frame) => {
    const p = new Peer(o);
    try {
      p.write({ type: "query", proto: 1, id: "conf-q", program, config: o.config, ...q });
      const r = await p.wait(0, f => f.type === "query_result" && f.id === "conf-q", "query_result");
      check(r.ok === true, "Import query failed: " + String(r.error));
      await p.exited();
      return r;
    } finally { await p.clean(); }
  };
  const list = await ask({ query: "list", dir: null });
  check(Array.isArray(list.conversations) && list.conversations.every(c => object(c) && typeof c.id === "string" && IMPORT_ID_RE.test(c.id)
    && typeof c.dir === "string" && typeof c.title === "string" && Number.isFinite(c.updatedAt)), "Invalid import list");
  if (fixture.importSession) {
    const read = await ask({ query: "read", session: fixture.importSession });
    check(Array.isArray(read.blocks) && read.blocks.length > 0 && read.blocks.every(isImportBlock), "Invalid or empty import read");
  }
}

type Kept = Map<string, string>;

function imPeer(o: Options, kept: Kept, restored: Map<string, string>) {
  const written = new Set<string>();
  return new Peer(o, (m, p) => {
    check(m.jsonrpc === "2.0", "Invalid JSON-RPC version from IM plugin");
    if (!("method" in m)) return;
    const v = m.params;
    check(object(v), "Invalid IM request params");
    if (m.method === "connected") {
      check(typeof v.up === "boolean" && (v.error === undefined || typeof v.error === "string"), "Invalid connected notification");
      return;
    }
    check(typeof m.id === "number" || nonempty(m.id), "IM reverse call requires an id");
    let result: Frame;
    if (m.method === "kept_set") {
      check(typeof v.key === "string" && (typeof v.value === "string" || v.value === null), "Invalid kept_set");
      written.add(v.key);
      if (v.value === null) kept.delete(v.key);
      else kept.set(v.key, v.value);
      result = { ok: true };
    } else if (m.method === "kept_get") {
      check(typeof v.key === "string", "Invalid kept_get");
      const value = kept.get(v.key);
      if (!written.has(v.key) && value !== undefined) restored.set(v.key, value);
      result = { value: value ?? null };
    } else if (m.method === "inbound") {
      check(nonempty(v.chat) && nonempty(v.sender) && nonempty(v.messageId) && typeof v.text === "string" && Number.isFinite(v.at), "Invalid inbound");
      result = { ok: true };
    } else {
      p.write({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Unsupported reverse method" } });
      return;
    }
    p.write({ jsonrpc: "2.0", id: m.id, result });
  });
}

async function imInit(p: Peer): Promise<Capabilities> {
  const r = await p.rpc("init", { proto: 1, botId: "conf-bot-1", botName: p.options.manifest.id, config: p.options.config });
  check(r.proto === 1, "Invalid IM handshake version");
  const c = validateImCapabilities(r.capabilities);
  check(c.ok, "Invalid IM handshake capabilities");
  await p.wait(0, f => f.method === "connected" && object(f.params) && f.params.up === true, "connected(up:true)");
  return c.capabilities;
}
/** The host paces chat writes and attaches a sequence number to outbound posts. */
function chatRpc(p: Peer, caps: Capabilities) {
  let nextAt = 0, seq = 0;
  return async (method: string, params: Frame) => {
    const wait = Math.max(0, nextAt - Date.now(), method === "edit" ? caps.editEvery ?? 0 : 0);
    check(wait <= p.options.ms, "IM rate limit exceeds --timeout");
    if (wait > 0) await Bun.sleep(wait);
    nextAt = Date.now() + 1000 / caps.sendLimit.perChatPerSecond;
    if (method === "send" && object(params.message)) params = { ...params, message: { ...params.message, seq: ++seq } };
    return p.rpc(method, params);
  };
}
function sent(r: Frame): boolean {
  return r.status === "sent" && (r.messageId === undefined || typeof r.messageId === "string") && (r.ref === undefined || typeof r.ref === "string");
}
async function imSend(rpc: Peer["rpc"], chat: string, message: Frame) {
  const r = await rpc("send", { chat, message });
  check(sent(r), "Expected sent receipt");
  return r.messageId;
}
async function imClose(p: Peer) {
  p.observeChildren();
  check((await p.rpc("shutdown", {})).ok === true, "Missing shutdown acknowledgement");
  await p.exited();
}

async function testIm(o: Options, fixture: Fixture) {
  const chat = fixture.chat ?? "conf-user-1";
  const kept: Kept = new Map();
  const reads = new Map<string, string>();
  // This optional loopback service speaks the bundled local-im example's offline test protocol.
  const channels: string[] = [], cursors: string[] = [];
  const server = fixture.localPlatform && !o.config.endpoint ? Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/updates") {
      cursors.push(url.searchParams.get("cursor") ?? "");
      const input = { channel: "dm-99", sender: chat, messageId: "mock-1", at: Date.now(), text: "offline test" };
      return Response.json({ messages: url.searchParams.get("cursor") === "1" ? [] : [input], nextCursor: "1" });
    }
    if (url.pathname === "/send" || url.pathname === "/edit") {
      channels.push((await req.json()).channel);
      return Response.json({ status: "sent", messageId: "offline-post" });
    }
    return Response.json({ ok: true });
  } }) : null;
  if (server) o = { ...o, config: { ...o.config, endpoint: server.url.origin } };
  let p: Peer | undefined;
  try {
    await verifyEnv(o);
    p = imPeer(o, kept, reads);
    const c = await imInit(p);
    ok(2, "sanitized launch, init capabilities and connected notification");
    if (server) {
      const input = await p.wait(0, m => m.method === "inbound" && object(m.params) && m.params.messageId === "mock-1", "offline inbound");
      check(object(input.params) && input.params.sender === chat && input.params.chat === chat, "Incorrectly normalized private chat");
      const cursor = await p.wait(0, m => m.method === "kept_set" && object(m.params) && m.params.key === "sync_buf" && m.params.value === "1", "offline cursor");
      check(p.frames.indexOf(cursor) > p.frames.indexOf(input), "Cursor advanced before inbound");
    }
    const normal = fixture.normalText ?? "hello conformance".slice(0, c.maxTextLength);
    check(normal.length <= c.maxTextLength, "Fixture normalText exceeds negotiated limit");
    const rpc = chatRpc(p, c);
    const messageId = await imSend(rpc, chat, { text: normal });
    // The core owns splitting. Send its two wire segments, including the exact advertised boundary.
    const size = Math.min(c.maxTextLength, MAX_LINE_BYTES - 1024);
    check(size > 0, "IM must accept nonempty text");
    const text = "x".repeat(size) + "!";
    await imSend(rpc, chat, { text: text.slice(0, size) });
    await imSend(rpc, chat, c.markdown === null ? { text: "!" } : { text: "!", markdown: size >= 5 ? "**!**" : "!" });
    ok(3, "normal text, split boundary and negotiated Markdown");
    if (c.stream || (c.progress === "edit" && c.draftTtl)) {
      const inbound = p.frames.find(f => f.method === "inbound" && object(f.params) && f.params.chat === chat)?.params;
      const replyTo = fixture.replyTo ?? (object(inbound) ? inbound.messageId : undefined);
      let id = await imSend(rpc, chat, { text: "a", ...(nonempty(replyTo) && { replyTo }), ...(c.stream ? { stream: true } : { draft: true }) });
      check(nonempty(id), "Missing stream or draft id");
      for (const [text, final] of [["ab", false], ["abc", true]] as const) {
        const r = await rpc("edit", { chat, messageId: id, message: { text: text.slice(0, size), ...(final && { final: true }) } });
        check(sent(r), final ? "Finalizing progress failed" : "Editing progress failed");
        if (typeof r.messageId === "string") id = r.messageId;
      }
    } else if (c.progress === "edit") {
      check(nonempty(messageId), "Editable offline send needs a message id");
      check(sent(await rpc("edit", { chat, messageId, message: { text: "edited".slice(0, size), ...(c.finalEdit && { final: true }) } })), "edit failed");
    }
    if (c.buttons) {
      const text = "button".slice(0, size);
      const id = await imSend(rpc, chat, { text, ...(c.buttons === "markdown" && { markdown: text }), buttons: [{ label: "Status", data: "/status" }] });
      check(nonempty(id), "Button message needs an id");
      const r = await rpc("drop_buttons", { chat, messageId: id });
      // Append-only platforms may explicitly refuse to change buttons on a posted message.
      check(sent(r) || (c.progress === "append" && r.status === "failed" && nonempty(r.error)), "drop_buttons failed");
    }
    if (c.menu.maxItems > 0) {
      const target = c.menu.scope === "per_chat" ? { chat } : {};
      check((await rpc("set_menu", { ...target, items: [{ command: "/status", description: "Status" }] })).ok === true, "set_menu failed");
    }
    if (c.menu.row) {
      const target = c.menu.scope === "per_chat" ? { chat } : {};
      check((await rpc("set_row", { ...target, row: [{ label: "Status", command: "/status" }] })).ok === true, "set_row failed");
    }
    ok(4, "declared edit, buttons and menu capabilities only");
    const expected = Object.entries(fixture.kept ?? Object.fromEntries(kept));
    check(expected.length > 0 || fixture.stateless === true, "Provide a stateful offline fixture or explicitly declare stateless");
    for (const [key, value] of expected) check(kept.get(key) === value, "Missing or incorrect persisted fixture key: " + key);
    await imClose(p);
    await p.clean();
    reads.clear();
    const postsBeforeRestart = channels.length, pollsBeforeRestart = cursors.length;
    p = imPeer(o, kept, reads);
    const restoredCaps = await imInit(p);
    const restoredRpc = chatRpc(p, restoredCaps);
    await imSend(restoredRpc, chat, { text: "after restart".slice(0, restoredCaps.maxTextLength) });
    for (const [key, value] of expected) {
      if (reads.get(key) !== value) await p.wait(0, () => reads.get(key) === value, "plugin did not read persisted fixture key after restart: " + key);
    }
    if (server) {
      check(channels.length === postsBeforeRestart + 1 && channels.every(id => id === "dm-99"), "Private channel not restored on the platform");
      check(cursors[pollsBeforeRestart] === "1", "Platform polled with stale cursor after restart");
    }
    ok(5, expected.length ? "kept writes and reads across restart" : "stateless IM: no checkpoint required");
    const refused = await restoredRpc("send", { chat: fixture.failureChat ?? "conf-missing-context", message: { text: fixture.failureText ?? "no context".slice(0, restoredCaps.maxTextLength) } });
    check(refused.status === "failed" && nonempty(refused.error), "Provide a fixture that explicitly refuses a send or lacks chat context");
    ok(6, "explicit sending failure reported without exiting");
    await imClose(p);
    ok(7, "shutdown acknowledged and child processes exited");
  } finally {
    try { await p?.clean(); } finally { await server?.stop(true); }
  }
  if (o.manifest.kind === "im" && o.manifest.wizard) {
    await testWizard(o, fixture);
    ok(8, "bot wizard steps, inputs, done fields and shutdown");
  }
}

/** The bot wizard (spec §3.6): each wizard_input answered from wizardInputs by label, every step valid,
 *  done fields the core would write; then a second run shut down after its first step. */
async function testWizard(o: Options, fixture: Fixture) {
  const peer = () => new Peer(o, (m, p) => {
    const v = m.params;
    if (m.method === "wizard_step") {
      check(object(v) && (v.text === undefined || typeof v.text === "string")
        && (v.kind === "qr" ? typeof v.data === "string" : v.kind === "link" ? typeof v.url === "string" : v.kind === "waiting" && typeof v.text === "string"), "Invalid wizard_step");
    } else if (m.method === "wizard_input") {
      check(object(v) && nonempty(v.label) && (v.secret === undefined || typeof v.secret === "boolean"), "Invalid wizard_input");
      const value = fixture.wizardInputs?.[v.label];
      check(value !== undefined, "No wizardInputs value for: " + v.label);
      p.write({ jsonrpc: "2.0", id: m.id, result: { value } });
    } else if (m.method !== undefined && m.id !== undefined) p.write({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Unsupported reverse method" } });
  });
  const start = async (p: Peer) => {
    p.write({ jsonrpc: "2.0", id: 1, method: "wizard", params: { proto: 1, botName: o.manifest.id, config: o.config } });
    await p.wait(0, f => f.method === "wizard_step" || f.method === "wizard_input", "first wizard step");
  };
  let p = peer();
  try {
    await start(p);
    const done = await p.wait(0, f => f.id === 1 && !("method" in f), "wizard done");
    check(object(done.result) && strings(done.result.config) && (done.result.text === undefined || typeof done.result.text === "string"), "Invalid wizard done: " + JSON.stringify(done.error ?? done.result));
    const fields = done.result.config, declared = [...o.manifest.requiredConfig ?? [], ...o.manifest.optionalConfig ?? []];
    for (const key of Object.keys(fields)) check(!["platform", "target", "owner"].includes(key) && declared.includes(key), "Wizard done field not allowed: " + key);
    for (const key of o.manifest.requiredConfig ?? []) check(nonempty(fields[key]) || nonempty(o.config[key]), "Wizard done misses requiredConfig key: " + key);
    await p.exited();
    await p.clean();
    p = peer();
    await start(p);
    p.observeChildren();
    p.write({ jsonrpc: "2.0", id: 2, method: "shutdown", params: {} });
    await p.exited();
  } finally { await p.clean(); }
}

/** Check the actual published manifest and wire conversations, so a stale copy in a test cannot pass. */
export function checkExamples(markdown: string) {
  const blocks = [...markdown.replaceAll("\r\n", "\n").matchAll(/^```json\n([\s\S]*?)\n```$/gm)].map(m => m[1]!.trim());
  const sample = (start: string) => {
    const block = blocks.find(b => b.startsWith(start));
    check(block, "Missing documented JSON example: " + start);
    return block;
  };
  const manifest = validateManifest(JSON.parse(sample('{\n  "manifestVersion"')));
  check(manifest.ok && manifest.manifest.kind === "agent", "Invalid documented agent manifest");
  const agent: Frame[] = sample('{"type":"init"').split("\n").map(line => JSON.parse(line));
  const ready = agent.find(f => f.type === "ready");
  check(agent[0]?.proto === 1 && agent[0].program === manifest.manifest.program && ready, "Invalid documented agent init/ready");
  checkReady(ready);
  const req = agent.find(f => f.type === "ask");
  check(req && nonempty(req.requestId) && agent.some(f => f.type === "answer" && f.requestId === req.requestId)
    && agent.some(f => f.type === "ask_resolved" && f.requestId === req.requestId), "Unmatched documented permission request");
  const im: Frame[] = sample('{"jsonrpc":"2.0"').split("\n").map(line => JSON.parse(line));
  check(im.every(f => f.jsonrpc === "2.0") && im[0]?.method === "init" && object(im[0].params) && im[0].params.proto === 1, "Invalid documented IM init");
  const handshake = im.find(f => f.id === im[0]!.id && object(f.result))?.result;
  check(object(handshake) && handshake.proto === 1 && validateImCapabilities(handshake.capabilities).ok, "Invalid documented IM handshake");
  for (const r of im.filter(f => f.method && f.id !== undefined)) {
    const result = im.find(f => f.id === r.id && object(f.result))?.result;
    check(object(result) && (r.method === "init" || (r.method === "send" ? result.status === "sent" : result.ok === true)), "Unmatched documented " + r.method);
  }
}

async function main() {
  const { values } = parseArgs({ args: Bun.argv.slice(2), options: {
    help: { type: "boolean" }, "check-docs": { type: "boolean" }, manifest: { type: "string" }, config: { type: "string", default: "{}" }, timeout: { type: "string", default: "10000" },
  } });
  if (values.help) {
    console.log([
      "bun scripts/plugin-conformance.ts --manifest <plugin.json> [--config <JSON>] [--timeout <ms>]",
      "bun scripts/plugin-conformance.ts --check-docs",
      "Use an offline plugin configuration. An optional conformance.json beside plugin.json describes test inputs:",
      "  Agent: normalText, interruptText (a turn that stays pending), failureText (reported downstream error).",
      "         importSession: a conversation id an import-capable plugin's read query returns blocks for.",
      "         askText + deliveredText test duplicate permission answers using one observable downstream tool receipt;",
      "         without askText the checker requests an unsupported command instead.",
      "  IM: chat, normalText, replyTo (inbound message id for stream/draft), failureChat/failureText (a known refusal).",
      "      kept maps expected keys to values",
      "      that must be written and then read after restart, including DM, cursor or context keys as applicable.",
      "      Declare stateless:true only for platforms that use no persisted keys. localPlatform:true enables the",
      "      bundled example's loopback HTTP fixture if --config does not already specify an endpoint.",
      "      wizardInputs maps each wizard_input label to the value typed, for a plugin that declares wizard.",
    ].join("\n"));
    return;
  }
  if (values["check-docs"]) {
    checkExamples(readFileSync(join(import.meta.dir, "../docs/spec/plugins.md"), "utf8"));
    console.log("PASS documented plugin examples");
    if (!values.manifest) return;
  }
  check(values.manifest, "Usage: bun scripts/plugin-conformance.ts --manifest <path> [--config <json>] [--timeout 10000]");
  const path = resolve(values.manifest), dir = dirname(path);
  const validated = validateManifest(json(path));
  check(validated.ok, "Manifest validation failed" + (validated.ok ? "" : ": " + validated.error));
  const manifest = validated.manifest;
  if (manifest.icon !== undefined) {
    const icon = checkPluginIcon(dir, manifest.icon);
    check(icon.ok, "Unusable icon" + (icon.ok ? "" : ": " + icon.error));
  }
  const { version } = JSON.parse(readFileSync(join(import.meta.dir, "../package.json"), "utf8"));
  check(compareSemver(version, manifest.minRhodium) >= 0, "Manifest needs a newer Rhodium version");
  const cfg: unknown = JSON.parse(values.config);
  check(object(cfg), "Expected --config JSON object");
  const config = Object.fromEntries(Object.entries(cfg).map(([key, val]) => [key, typeof val === "string" ? val : JSON.stringify(val)]));
  for (const key of manifest.requiredConfig ?? []) check(nonempty(config[key]), "Missing requiredConfig key: " + key);
  const ms = Number(values.timeout);
  check(Number.isFinite(ms) && ms > 0, "Invalid --timeout");
  const fixture = fixtureAt(dir);
  ok(1, "manifest, icon, static compliance and required configuration");
  const cwd = mkdtempSync(join(tmpdir(), "rhodium conformance "));
  try {
    const o = { manifest, config, dir, cwd, ms };
    if (manifest.kind === "agent") await testAgent(o, fixture);
    else await testIm(o, fixture);
    console.log("PASS " + manifest.kind + " plugin conformance: " + manifest.id);
  } finally {
    // A leaked child (the very thing a check may report) still holds this directory on Windows (EBUSY);
    // don't let the cleanup error replace the real one. ponytail: leaves a temp dir behind in that case.
    try { rmSync(cwd, { recursive: true, force: true }); } catch {}
  }
}

if (import.meta.main) main().catch(err => {
  console.error("FAIL plugin conformance: " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
