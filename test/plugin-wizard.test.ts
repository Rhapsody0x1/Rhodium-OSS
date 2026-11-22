// rh bot <name> <plugin platform> (spec plugins §3.6): the plugin reports the wizard's steps, rhodium
// shows them at the terminal, reads input, checks the done fields, writes [bots.<name>] and pairs.
// local-im is the bundled example; the failure cases use a raw rh-im/1 probe written per test.
import { afterEach, expect, test } from "bun:test";
import { closeSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "../src/config";
import { newInstance, pty, terminal, until, type Instance } from "./instance";

const LOCAL_IM = resolve(import.meta.dir, "../examples/plugins/local-im");
const MAIN = join(import.meta.dir, "../src/main.ts");
const TOKEN = "local-token-never-shown";

let r: Instance | undefined;
let http: ReturnType<typeof Bun.serve> | undefined;
afterEach(async () => {
  await r?.cleanup();
  http?.stop(true);
  [r, http] = [undefined, undefined];
});

test("local-im's wizard: QR, link and waiting show in order, the secret input is not echoed, the bot is written with its declared keys only, then pairs", async () => {
  const batches: object[][] = [];
  http = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/updates") {
        const i = Number(url.searchParams.get("cursor") ?? "");
        return Response.json({ messages: batches[i] ?? [], nextCursor: batches[i] ? String(i + 1) : String(i) });
      }
      return Response.json({ status: "sent", messageId: "m" });
    },
  });
  r = newInstance({ toml: ["[plugins.local-im]", `path = ${JSON.stringify(LOCAL_IM)}`, "[plugins.local-im.config]", `endpoint = ${JSON.stringify(http.url.origin)}`].join("\n") });
  const daemon = await r.start();
  await r.slots("a");
  const res = await r.rh(["bot", "w", "local-im", "w/a"], { type: `${TOKEN}\n` });
  expect({ code: res.code, err: res.err }).toMatchObject({ code: 0 });
  const link = res.out.indexOf("http://localhost/bind/w");
  const waiting = res.out.indexOf("等待本地平台确认");
  expect(res.out).toMatch(/[▄▀█]/); // the QR code, drawn
  expect(res.out.indexOf("用本地平台扫码")).toBeLessThan(link);
  expect(link).toBeLessThan(waiting);
  expect(waiting).toBeGreaterThan(0);
  expect(res.err).toContain("本地平台的 token");
  expect(res.screen).toBe("");
  expect(res.out + res.err).not.toContain(TOKEN);
  expect(JSON.stringify(daemon.logs)).not.toContain(TOKEN);
  expect(loadConfig(r.config).bots.w).toEqual({ platform: "local-im", token: TOKEN, target: "w/a" });
  const code = res.out.match(/配对码：(\S+)/)?.[1];
  expect(code).toBeString();
  batches.push([{ sender: "user-1", channel: "dm-1", messageId: "p1", text: code, at: Date.now() }]);
  await until(async () => (await r!.ok("pair", "w", "--list")).includes("user-1"), 15_000);
}, 60_000);

/** A raw rh-im/1 plugin "probe" in the instance's directory; the mode file beside it picks what its wizard does. */
function probe(extraToml = "") {
  const inst = newInstance({ toml: ["[plugins.probe]", 'path = "."', extraToml].join("\n") });
  const manifest = JSON.parse(readFileSync(join(LOCAL_IM, "plugin.json"), "utf8"));
  writeFileSync(join(inst.dir, "plugin.json"), JSON.stringify({ ...manifest, id: "probe", icon: undefined, requiredConfig: ["token"], optionalConfig: ["region"], command: [process.execPath, "${PLUGIN_DIR}/probe.ts"] }));
  writeFileSync(join(inst.dir, "probe.ts"), `
    import { readFileSync, writeFileSync } from "node:fs";
    const out = (m: object) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
    const done = (config: object) => out({ id: 1, result: { config } });
    let buf = "";
    process.stdin.on("data", (c) => {
      buf += c;
      for (let nl; (nl = buf.indexOf("\\n")) >= 0; ) {
        const m = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (m.method === "shutdown") { out({ id: m.id, result: { ok: true } }); process.exit(0); }
        if (m.id === 7) done({ token: m.result.value });
        if (m.method !== "wizard") continue;
        switch (readFileSync(process.env.RHODIUM_PLUGIN_DIR + "/mode", "utf8")) {
          case "silent": break;
          case "error": out({ id: 1, error: { code: -32000, message: "平台拒绝了" } }); process.exit(1);
          case "exit": process.stderr.write("boom\\n"); process.exit(3);
          case "input-first": out({ id: 7, method: "wizard_input", params: { label: "Code" } }); break;
          case "extra": done({ token: "t", nope: "x" }); break;
          case "owner": done({ token: "t", owner: "me" }); break;
          case "missing": done({ region: "x" }); break;
          case "bad-step": out({ method: "wizard_step", params: { kind: "weird" } }); break;
          case "hang": writeFileSync(process.env.RHODIUM_PLUGIN_DIR + "/pid", String(process.pid)); out({ method: "wizard_step", params: { kind: "waiting", text: "hanging" } }); break;
        }
      }
    });
  `);
  return inst;
}
const mode = (inst: Instance, m: string) => writeFileSync(join(inst.dir, "mode"), m);

test("a wizard that fails, exits, sends a bad step, or is done with fields its manifest does not allow leaves the config as it was", async () => {
  r = probe("[durations]\npluginHandshake = \"1s\"");
  await r.start();
  await r.slots("a");
  for (const [m, why] of [
    ["silent", "rh: 插件 probe 的向导没有响应。"],
    ["error", "rh: 平台拒绝了"],
    ["exit", "rh: 插件 probe 的向导中途退出（退出码 3）：boom"],
    ["bad-step", "rh: 插件 probe 的向导报了看不懂的一步。"],
    ["extra", "nope"],
    ["owner", "owner"],
    ["missing", "token"],
  ] as const) {
    mode(r, m);
    const before = readFileSync(r.config, "utf8");
    const res = await r.rh(["bot", "p", "probe", "w/a"]);
    expect({ m, code: res.code }).toEqual({ m, code: 1 });
    expect(res.err).toContain(why);
    expect(readFileSync(r.config, "utf8")).toBe(before);
  }
}, 120_000);

test("an input as the first step stops the first-step timer: a user slower than pluginHandshake still finishes", async () => {
  r = probe("[durations]\npluginHandshake = \"1s\"");
  mode(r, "input-first");
  await r.start();
  await r.slots("a");
  const own = pty();
  const proc = Bun.spawn([process.execPath, MAIN, "rh", "bot", "p", "probe", "w/a"], { env: r.env, cwd: r.dir, stdin: own.slave, stdout: "pipe", stderr: "pipe" });
  let err = "";
  for await (const chunk of proc.stderr.pipeThrough(new TextDecoderStream())) {
    err += chunk;
    if (err.includes("Code")) break;
  }
  await Bun.sleep(2500);
  writeSync(own.master, "slow-code\n");
  const out = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  closeSync(own.slave);
  closeSync(own.master);
  expect(out).toContain("配对码");
  expect(loadConfig(r.config).bots.p).toEqual({ platform: "probe", token: "slow-code", target: "w/a" });
}, 30_000);

test("Ctrl-C at rh bot shuts the plugin's wizard down: its process exits and the config is as it was", async () => {
  r = probe();
  mode(r, "hang");
  await r.start();
  await r.slots("a");
  const before = readFileSync(r.config, "utf8");
  const proc = Bun.spawn([process.execPath, MAIN, "rh", "bot", "p", "probe", "w/a"], { env: r.env, cwd: r.dir, stdin: terminal(), stdout: "pipe", stderr: "pipe" });
  let out = "";
  for await (const chunk of proc.stdout.pipeThrough(new TextDecoderStream())) {
    out += chunk;
    if (out.includes("hanging")) break;
  }
  const pid = Number(readFileSync(join(r.dir, "pid"), "utf8"));
  proc.kill("SIGINT");
  expect(await proc.exited).toBe(130);
  const alive = () => {
    try {
      return process.kill(pid, 0);
    } catch {
      return false;
    }
  };
  await until(() => !alive(), 15_000);
  expect(readFileSync(r.config, "utf8")).toBe(before);
}, 30_000);

test("a plugin platform without wizard is refused with a hint to write the table; --paste and --api-root are refused for plugins", async () => {
  r = newInstance({ toml: ["[plugins.local-im]", `path = ${JSON.stringify(LOCAL_IM)}`, "[plugins.plain]", 'path = "."'].join("\n") });
  const manifest = JSON.parse(readFileSync(join(LOCAL_IM, "plugin.json"), "utf8"));
  writeFileSync(join(r.dir, "plugin.json"), JSON.stringify({ ...manifest, id: "plain", icon: undefined, wizard: undefined, command: [process.execPath, join(LOCAL_IM, "index.ts")] }));
  await r.start();
  await r.slots("a");
  const plain = await r.rh(["bot", "x", "plain", "w/a"]);
  expect(plain.code).toBe(1);
  expect(plain.err).toContain("[bots.x]");
  for (const flag of [["--paste"], ["--api-root", "http://127.0.0.1:1"]]) {
    const res = await r.rh(["bot", "x", "local-im", "w/a", ...flag]);
    expect(res.code).toBe(1);
    expect(res.err).toContain("[plugins.local-im.config]");
  }
}, 30_000);
