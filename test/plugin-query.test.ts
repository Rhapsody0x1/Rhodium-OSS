// The one-shot import query (spec plugins §3.5): rhodium starts the plugin, writes one query, waits
// for its query_result within durations.pluginRpc, and reaps it either way.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config";
import type { LoadedPlugin } from "../src/plugin-loader";
import { listPluginConversations, readPluginConversation } from "../src/plugin-query";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** A plugin whose whole program is body, run with bun; and a config that waits ms for its answer. */
function plugin(body: string, ms = 2_000): { p: LoadedPlugin; cfg: Config; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "rhodium-test-query-"));
  dirs.push(dir);
  writeFileSync(join(dir, "p.js"), body);
  const manifest = { manifestVersion: 1, kind: "agent", id: "qp", name: "Q", statusName: "Q", version: "0.1.0", minRhodium: "0.0.1", protocol: "rh-agent/1", program: "qp", command: ["x"], capabilities: {}, import: true };
  const p = { id: "qp", dir, manifest, command: [process.execPath, join(dir, "p.js")] } as unknown as LoadedPlugin;
  const cfg = { stateDir: dir, agentPath: process.env.PATH ?? "", durations: { pluginRpc: ms, stopGrace: 100 }, plugins: { qp: { config: { token: "s3cret" } } }, programs: {} } as unknown as Config;
  return { p, cfg, dir };
}
const READ = `const line = await new Promise(r => process.stdin.once("data", d => r(String(d))));
const q = JSON.parse(line);
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
`;

test("list returns the conversations, drops those with a bad id or no absolute dir, and sends dir, program and config", async () => {
  const { p, cfg, dir } = plugin(`${READ}
require("node:fs").writeFileSync(process.env.RHODIUM_PLUGIN_DIR + "/q.json", JSON.stringify({ q, env: Object.keys(process.env), cwd: process.cwd() }));
out({ type: "query_result", id: q.id, ok: true, conversations: [
  { id: "conv_a1", dir: "/p", title: "t", updatedAt: 5 },
  { id: "w1:p1", dir: "/p", title: "pane-like", updatedAt: 4 },
  { id: "a.b", dir: "/p", title: "dot", updatedAt: 3 },
  { id: "rel", dir: "p", title: "relative", updatedAt: 2 },
  { id: "busy-1", dir: "/p", title: "b", updatedAt: 1, busy: true, count: 3 },
] });
process.exit(0);`);
  const list = await listPluginConversations(p, cfg, dir);
  expect(list).toEqual([
    { id: "conv_a1", dir: "/p", title: "t", updatedAt: 5 },
    { id: "busy-1", dir: "/p", title: "b", updatedAt: 1, busy: true, count: 3 },
  ]);
  const seen = JSON.parse(readFileSync(join(dir, "q.json"), "utf8"));
  expect(seen.q).toMatchObject({ type: "query", proto: 1, query: "list", dir, program: "qp", config: { token: "s3cret" } });
  expect(seen.cwd).toBe(realpathSync(dir));
  expect(seen.env).toContain("RHODIUM_PLUGIN_DIR");
  expect(seen.env.filter((k: string) => /^RHODIUM_(SOCKET|SLOT|TOKEN)$/.test(k))).toEqual([]);
});

test("read returns the blocks", async () => {
  const { p, cfg } = plugin(`${READ}
out({ type: "query_result", id: q.id, ok: true, blocks: [{ kind: "user", text: q.session }, { kind: "tool", name: "t", input: {}, result: { text: "r" } }, { kind: "assistant", text: "a", at: 1 }] });`);
  expect(await readPluginConversation(p, cfg, "s1")).toEqual([{ kind: "user", text: "s1" }, { kind: "tool", name: "t", input: {}, result: { text: "r" } }, { kind: "assistant", text: "a", at: 1 }]);
});

test("ok:false is the plugin's own reason, its config values hidden", async () => {
  const { p, cfg } = plugin(`${READ} out({ type: "query_result", id: q.id, ok: false, error: "bad token s3cret" });`);
  await expect(listPluginConversations(p, cfg, null)).rejects.toThrow("bad token [redacted]");
});

test("a plugin that never answers is reaped after the timeout and the failure says so", async () => {
  const { p, cfg, dir } = plugin(`process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(process.env.RHODIUM_PLUGIN_DIR + "/pid", String(process.pid)); setInterval(() => {}, 1000);`, 300);
  const at = Date.now();
  await expect(listPluginConversations(p, cfg, null)).rejects.toThrow("超时");
  expect(Date.now() - at).toBeLessThan(2_000);
  const pid = Number(readFileSync(join(dir, "pid"), "utf8"));
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const until = Date.now() + 2_000;
  while (alive() && Date.now() < until) await Bun.sleep(20);
  expect(alive()).toBe(false);
});

test("a plugin that exits first fails with the last line of its stderr", async () => {
  const { p, cfg } = plugin(`console.error("starting"); console.error("cannot open the store"); process.exit(3);`);
  await expect(listPluginConversations(p, cfg, null)).rejects.toThrow("cannot open the store");
});

test("a directory that is gone is a failure, not a crash", async () => {
  const { p, cfg, dir } = plugin(`${READ} out({ type: "query_result", id: q.id, ok: true, conversations: [] });`);
  await expect(listPluginConversations(p, cfg, join(dir, "gone"))).rejects.toThrow("启动不了插件");
});

test("an invalid query_result is a failure", async () => {
  const { p, cfg } = plugin(`${READ} out({ type: "query_result", id: q.id, ok: true, conversations: "nope" });`);
  await expect(listPluginConversations(p, cfg, null)).rejects.toThrow();
  const r = plugin(`${READ} out({ type: "query_result", id: q.id, ok: true, blocks: [{ kind: "picture" }] });`);
  await expect(readPluginConversation(r.p, r.cfg, "s")).rejects.toThrow();
});
