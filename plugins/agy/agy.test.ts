import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Peer, type Frame, type Options } from "../../scripts/lib/conformance-peer";

const dir = import.meta.dir;
const instances: { peer: Peer; cwd: string }[] = [];

afterEach(async () => {
  for (const { peer, cwd } of instances.splice(0)) {
    try { await peer.clean(); }
    finally { rmSync(cwd, { recursive: true, force: true }); }
  }
});

async function start(options: { session?: Frame; offline?: boolean; program?: string; approval?: boolean } = {}) {
  const manifest = await Bun.file(join(dir, "plugin.json")).json() as Options["manifest"];
  const cwd = mkdtempSync(join(tmpdir(), "rhodium-test-agy "));
  const systemPromptFile = join(cwd, "slot rules.md");
  writeFileSync(systemPromptFile, "Synthetic slot rule");
  const config: Record<string, string> = options.offline === false ? {} : { fixture: "builtin" };
  // Starting bun and the fixture can be slow on a busy Windows runner; turn checks keep a tighter limit.
  const peer = new Peer({ manifest, dir, cwd, config, ms: 15_000 });
  instances.push({ peer, cwd });
  peer.write({ type: "init", proto: 1, conv: "conv-test", session: options.session ?? { new: "placeholder" }, cwd,
    systemPromptFile, program: options.program ?? "agy-not-installed-for-tests", approval: options.approval ?? true, config });
  const ready = await peer.wait(0, () => true, "ready or fatal");
  peer.options.ms = 4000;
  return { peer, ready };
}

function send(peer: Peer, text: string, extra: Frame = {}) {
  const from = peer.frames.length;
  peer.write({ type: "send", id: `input-${from}`, text, human: true, mode: "turn", ...extra });
  return from;
}

const event = (peer: Peer, from: number, type: string) => peer.wait(from, frame => frame.type === type, type);

async function close(peer: Peer) {
  peer.observeChildren();
  peer.write({ type: "close" });
  await peer.exited();
}

test("publishes the downstream ID and streams text, tool results and image prompts", async () => {
  const { peer, ready } = await start();
  expect(ready).toMatchObject({ type: "ready", session: "agy-fixture-session" });
  const from = send(peer, "inspect fixture", { images: [{ mimeType: "image/png", data: "AAA=" }] });
  expect(await event(peer, from, "turn_end")).toMatchObject({ reply: "Fixture reply (1 image)." });
  const turn = peer.frames.slice(from);
  expect(turn.filter(frame => frame.type === "text_delta").map(frame => frame.text).join("")).toBe("Fixture reply (1 image).");
  expect(turn[0]).toMatchObject({ type: "taken", inputId: `input-${from}` });
  expect(turn[1]).toMatchObject({ type: "turn_start", input: `input-${from}` });
  expect(turn).toContainEqual({ type: "tool_start", id: "list-1", name: "List files", input: { path: "." } });
  expect(turn).toContainEqual({ type: "item", item: { kind: "tool", id: "list-1", name: "List files", input: { path: "." }, result: { text: "README.md", error: false } } });
  await close(peer);
});

test("resumes the requested session without forwarding history as a new reply", async () => {
  const { peer, ready } = await start({ session: { resume: "previous-session" } });
  expect(ready).toMatchObject({ type: "ready", session: "previous-session" });
  expect(peer.frames).toEqual([ready]);
  const from = send(peer, "inspect fixture");
  expect(await event(peer, from, "turn_end")).toMatchObject({ reply: "Fixture reply (0 images)." });
  await close(peer);
});

test("forwards duplicate approval answers once and never picks a persistent allow", async () => {
  const { peer } = await start();
  const from = send(peer, "[permission]");
  const ask = await event(peer, from, "ask");
  expect(ask).toMatchObject({ kind: "permission", toolUse: "permission-1" });
  const answer = { type: "answer", requestId: ask.requestId, answer: { kind: "permission", allow: true } };
  peer.write(answer);
  peer.write(answer);
  await event(peer, from, "ask_resolved");
  expect(await event(peer, from, "turn_end")).toMatchObject({ reply: "Permission: once" });
  const next = send(peer, "[permission]");
  const denied = await event(peer, next, "ask");
  expect(denied.requestId).not.toBe(ask.requestId);
  peer.write({ ...answer, requestId: denied.requestId, answer: { kind: "permission", allow: false } });
  expect(await event(peer, next, "turn_end")).toMatchObject({ reply: "Permission: deny" });
  await close(peer);
});

test("maps a form choice back to the original ACP value", async () => {
  const { peer } = await start();
  const from = send(peer, "[question]");
  const ask = await event(peer, from, "ask");
  expect(ask).toMatchObject({ kind: "question", input: { questions: [{ question: "Choose a color", options: [{ label: "Violet" }, { label: "Orange" }] }] } });
  peer.write({ type: "answer", requestId: ask.requestId, answer: { kind: "question", answers: { "Choose a color": "Violet" } } });
  expect(await event(peer, from, "turn_end")).toMatchObject({ reply: "Answer: violet" });
  await close(peer);
});

test("interrupt cancels a pending permission and keeps the session usable", async () => {
  const { peer } = await start();
  const from = send(peer, "[permission]");
  const ask = await event(peer, from, "ask");
  peer.write({ type: "interrupt" });
  expect(await event(peer, from, "ask_cancel")).toMatchObject({ requestId: ask.requestId });
  expect(await event(peer, from, "turn_end")).toEqual({ type: "turn_end" });
  peer.write({ type: "answer", requestId: ask.requestId, answer: { kind: "permission", allow: true } });
  const next = send(peer, "inspect fixture");
  expect(await event(peer, next, "turn_end")).toMatchObject({ reply: "Fixture reply (0 images)." });
  expect(peer.frames.slice(from).filter(frame => frame.type === "turn_end")).toHaveLength(2);
  expect(peer.frames.slice(from).some(frame => frame.type === "ask_resolved")).toBe(false);
  await close(peer);
});

test("a prompt RPC error closes the failed turn without losing the session", async () => {
  const { peer } = await start();
  const from = send(peer, "[error]");
  expect(await event(peer, from, "error")).toMatchObject({ recoverable: true, detail: expect.stringContaining("Synthetic ACP error") });
  await event(peer, from, "turn_end");
  const next = send(peer, "inspect fixture");
  expect(await event(peer, next, "turn_end")).toMatchObject({ reply: "Fixture reply (0 images)." });
  await close(peer);
});

test("a missing real CLI fails setup without falling back to the demo", async () => {
  const { peer, ready } = await start({ offline: false });
  expect(ready).toMatchObject({ type: "fatal", message: expect.stringContaining("Antigravity"), retryable: false });
  expect(await peer.proc.exited).not.toBe(0);
});

test("slot approval off launches agy with its skip-permissions flag, and on without it", async () => {
  for (const approval of [false, true]) {
    const { peer } = await start({ approval });
    const from = send(peer, "[argv]");
    const { reply } = await event(peer, from, "turn_end");
    expect(reply).toBe(approval ? "acp" : "acp --dangerously-skip-permissions");
    await close(peer);
  }
});

test("a form Rhodium cannot show is refused with an ACP error, not declined for the user", async () => {
  const { peer } = await start();
  const from = send(peer, "[number form]");
  expect(await event(peer, from, "turn_end")).toMatchObject({ reply: "Form error -32602" });
  expect(peer.frames.slice(from).some(frame => frame.type === "ask")).toBe(false);
  await close(peer);
});

test("agy crashing with an approval pending cancels the ask and fails with its stderr", async () => {
  const { peer } = await start();
  const from = send(peer, "[crash]");
  const ask = await event(peer, from, "ask");
  expect(await event(peer, from, "ask_cancel")).toMatchObject({ requestId: ask.requestId });
  expect(await event(peer, from, "error")).toMatchObject({ recoverable: false, detail: expect.stringContaining("synthetic agy crash") });
  expect(await peer.proc.exited).not.toBe(0);
});

test("a start slower than the plugin's budget fails with its own reason before the core's limit", async () => {
  const started = Date.now();
  const { ready } = await start({ session: { resume: "slow-session" } });
  expect(ready).toMatchObject({ type: "fatal", message: expect.stringContaining("did not start within 8 s") });
  expect(Date.now() - started).toBeLessThan(10_000);
}, 20_000);
