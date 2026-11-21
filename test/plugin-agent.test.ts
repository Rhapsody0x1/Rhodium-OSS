import { expect, test } from "bun:test";
import type { AgentEmit, AgentEvent, AgentLink, AgentDriver } from "../src/contracts";
import type { LoadedPlugin } from "../src/plugin-loader";
import { PluginAgentDriver } from "../src/plugin-agent";
import { until } from "./instance";

const plugin: LoadedPlugin = {
  id: "echo-agent", dir: "/plugins/echo sample", command: ["bun", "/plugins/echo sample/index.ts"],
  manifest: {
    manifestVersion: 1, kind: "agent", id: "echo-agent", name: "Echo", statusName: "Echo", version: "1.0.0",
    protocol: "rh-agent/1", minRhodium: "1.0.0", program: "downstream", command: ["bun", "${PLUGIN_DIR}/index.ts"],
    capabilities: { steer: true, liveApproval: true, commands: ["status", "model"] },
  },
};
const launch: Parameters<AgentDriver["spawn"]>[0] = {
  session: { new: "proposed" }, program: "/missing/offline downstream", cwd: "/work/slot dir",
  env: { PATH: "/bin", ANTHROPIC_API_KEY: "bait", CLAUDE_CODE_OAUTH_TOKEN: "bait", HERDR_ENV: "1", RHODIUM_SLOT: "w/test" },
  systemPromptFile: "/state/prompt", approval: true, effort: "low", model: "tiny",
};
const input = { id: "i", text: "hello", human: true };
const ready = { type: "ready", proto: 1, session: null, selfStarted: false, capabilities: { steer: true, liveApproval: true, commands: ["status", "usage"] } };
const ask = { type: "ask", requestId: "a", tool: "read", input: { path: "file" }, kind: "permission", toolUse: "c" };
class Link implements AgentLink {
  readonly done = Promise.withResolvers<void>();
  readonly exited = this.done.promise;
  lines: { id: string; msg: any }[] = [];
  stops: string[] = [];
  async write(id: string, line: string) { this.lines.push({ id, msg: JSON.parse(line) }); }
  async eof() { this.stops.push("eof"); }
  async signal(s: "TERM" | "KILL") { this.stops.push(s); if (s === "KILL") this.done.resolve(); }
}
function setup(handshakeMs = 2000) {
  const events: AgentEvent[] = [];
  const emit: AgentEmit = (e) => events.push(e);
  const driver = new PluginAgentDriver({ conv: "conv", boot: 7, emit, kind: plugin.id, plugin, config: { fixture: "sample" }, handshakeMs, interruptMs: 15, stopGrace: 5 });
  const link = new Link();
  const feed = (m: unknown, replay = false) => driver.feed(Buffer.from(JSON.stringify(m)), 1, replay);
  return { driver, link, events, feed };
}

test("plugin agent waits for ready, uses its own program and reports only declared commands", async () => {
  const { driver, link, events, feed } = setup();
  const spec = driver.spawn(launch);
  expect(spec.argv).toEqual(plugin.command);
  expect(spec.cwd).toBe(launch.cwd);
  expect(spec.env.RHODIUM_PLUGIN_DIR).toBe(plugin.dir);
  expect(spec.env.RHODIUM_SLOT).toBe("w/test");
  for (const key of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "HERDR_ENV"]) expect(spec.env[key]).toBeUndefined();
  driver.attach(link, 1);
  driver.replayed();
  const first = driver.send(input, "turn");
  expect(link.lines.map((l) => l.msg.type)).toEqual(["init"]);
  expect(link.lines[0]!.msg).toMatchObject({ proto: 1, conv: "conv", program: launch.program, session: launch.session, cwd: launch.cwd, config: { fixture: "sample" } });
  feed(ready);
  await first;
  expect(link.lines.at(-1)).toMatchObject({ id: "i", msg: { type: "send", ...input, mode: "turn" } });
  feed({ type: "taken", inputId: "i" });
  feed({ type: "turn_start", input: "i" });
  await driver.send({ ...input, id: "j" }, "turn");
  expect(link.lines.at(-1)!.msg.mode).toBe("steer");
  feed(ask);
  await driver.answer("a", { kind: "permission", allow: true });
  expect(link.lines.at(-1)!.msg).toMatchObject({ type: "answer", requestId: "a" });
  feed({ type: "ask_resolved", requestId: "a" });
  feed({ type: "usage", inputTokens: 10, contextTokens: 20 });
  feed({ type: "turn_end", reply: "done", session: "real-session" });
  expect(driver.info.session).toBe("real-session");
  expect(driver.redact("error using sample")).toBe("error using [redacted]");
  expect(events).toContainEqual({ conv: "conv", proc: 1, type: "taken", inputId: "i" });
  expect(events).toContainEqual({ conv: "conv", proc: 1, type: "usage", inputTokens: 10, contextTokens: 20 });
  expect(events).toContainEqual({ conv: "conv", proc: 1, type: "turn_end", reply: "done" });
  for (const name of ["usage", "model"] as const) await expect(driver.command(name, "")).rejects.toThrow();
  const command = driver.command("status", "");
  await until(() => link.lines.at(-1)!.msg.type === "command");
  feed({ type: "command_result", ok: true, id: link.lines.at(-1)!.msg.id, result: { command: "status", model: "tiny", context: null } });
  expect(await command).toMatchObject({ command: "status", model: "tiny" });
  await driver.approval(false);
  expect(link.lines.at(-1)!.msg).toEqual({ type: "approval", on: false });
  link.done.resolve();
});

test("taking over a plugin replays the session and only outstanding asks without sending init or reemitting replies", async () => {
  const { driver, link, events, feed } = setup();
  driver.attach(link, 1);
  feed(ready, true);
  feed({ type: "session", session: "saved" }, true);
  feed({ type: "turn_start" }, true);
  for (const a of ["closed", "resolved", "done", "pending"]) feed({ ...ask, requestId: a, toolUse: a }, true);
  feed({ type: "ask_cancel", requestId: "closed" }, true);
  feed({ type: "ask_resolved", requestId: "resolved" }, true);
  feed({ type: "item", item: { kind: "tool", id: "done", name: "read", input: {} } }, true);
  feed({ type: "text_delta", text: "hello" }, true);
  driver.replayed();
  expect(link.lines).toEqual([]);
  expect(driver.info.session).toBe("saved");
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ type: "pending_asks", asks: [{ requestId: "pending" }] });
  link.done.resolve();
});

test("a removed plugin can replay and close its existing process without a manifest", async () => {
  const driver = new PluginAgentDriver({ conv: "existing", kind: plugin.id, config: {}, boot: 2, emit: () => {},
    handshakeMs: 2000, interruptMs: 15, stopGrace: 5 });
  const link = new Link();
  expect(() => driver.spawn(launch)).toThrow();
  driver.attach(link, 1);
  driver.feed(Buffer.from(JSON.stringify(ready)), 1, true);
  const said = { type: "item", item: { kind: "message", text: "last words" } } as const;
  expect(driver.feed(Buffer.from(JSON.stringify(said)), 1)).toEqual(said);
  expect(driver.info.capabilities).toMatchObject({ steer: false, liveApproval: false, commands: [] });
  expect(driver.canSend).toBe(false);
  await expect(driver.send(input, "turn")).rejects.toThrow();
  const closed = driver.close();
  expect(driver.feed(Buffer.from(JSON.stringify(said)), 1)).toEqual(said);
  await closed;
  expect(link.lines.map((l) => l.msg.type)).toEqual(["close"]);
});

test("non-steering handshake downgrade keeps the next send queued until the turn ends", async () => {
  const { driver, link, feed } = setup();
  driver.spawn(launch);
  driver.attach(link, 1);
  driver.replayed();
  feed({ ...ready, capabilities: {} });
  await driver.send(input, "turn");
  expect(driver.canSend).toBe(false);
  feed({ type: "turn_end" });
  expect(driver.canSend).toBe(true);
  await expect(driver.approval(true)).rejects.toThrow();
  link.done.resolve();
});

test("plugin interrupt waits for turn_end, or escalates through close, EOF, TERM and KILL", async () => {
  const { driver, link, feed } = setup();
  driver.spawn(launch);
  driver.attach(link, 1);
  feed(ready);
  await driver.send(input, "turn");
  await driver.interrupt();
  feed({ type: "turn_end" });
  await Bun.sleep(30);
  expect(link.stops).toEqual([]);
  expect(driver.interruptExpired).toBe(false);
  await driver.send(input, "turn");
  await driver.interrupt();
  await until(() => link.stops.includes("KILL"));
  expect(link.lines.at(-1)!.msg.type).toBe("close");
  expect(link.stops).toEqual(["eof", "TERM", "KILL"]);
  expect(driver.interruptExpired).toBe(true);
});

test("a handshake timeout, fatal or malformed handshake closes the plugin and fails waiting sends", async () => {
  for (const failure of ["timeout", "fatal", "proto", "invalid"] as const) {
    const { driver, link, events, feed } = setup(15);
    driver.spawn(launch);
    driver.attach(link, 1);
    const pending = driver.send(input, "turn");
    if (failure === "fatal") feed({ type: "fatal", message: "downstream not installed", retryable: false });
    if (failure === "proto") feed({ ...ready, proto: 2 });
    if (failure === "invalid") driver.feed(Buffer.from("bad json"), 1);
    await expect(pending).rejects.toThrow();
    expect(driver.info.why).toBeTruthy();
    if (failure === "fatal") expect(driver.info.retryable).toBe(false);
    if (failure === "invalid" || failure === "proto") expect(events.some((e) => e.type === "protocol_error")).toBe(true);
    await until(() => link.stops.includes("KILL"));
    expect(link.lines.some((l) => l.msg.type === "send")).toBe(false);
  }
});

test("a plugin cannot produce a turn or ask before the handshake", async () => {
  const { driver, link, events, feed } = setup();
  driver.spawn(launch);
  driver.attach(link, 1);
  expect(feed(ask)).toBeUndefined();
  expect(events.map((e) => e.type)).toEqual(["protocol_error"]);
  await until(() => link.stops.includes("KILL"));
});

test("a command cannot return a status card with malformed quota rows", async () => {
  const { driver, link, feed } = setup();
  driver.spawn(launch);
  driver.attach(link, 1);
  feed(ready);
  const reply = driver.command("status", "");
  await until(() => link.lines.at(-1)!.msg.type === "command");
  feed({ type: "command_result", id: link.lines.at(-1)!.msg.id, ok: true, result: { command: "status", model: null, context: null, limits: [null] } });
  await expect(reply).rejects.toThrow();
  link.done.resolve();
});

test("a stuck plugin cannot hold shutdown up by leaving the close write unacked", async () => {
  const { driver, link, feed } = setup();
  driver.spawn(launch);
  driver.attach(link, 1);
  feed(ready);
  link.write = async () => new Promise<void>(() => {});
  const done = driver.close();
  await until(() => link.stops.includes("KILL"), 300);
  await done;
});
