import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { startMock } from "./mock-weixin-server";

const root = resolve(import.meta.dir, "../..");
if (process.platform !== "linux") throw new Error("The terminal pairing demo requires Linux with systemd --user");
const exe = resolve(process.env.RHODIUM_TEST_EXE ?? join(root, "dist", "rhodium"));
const hold = resolve(process.env.RHODIUM_TEST_HOLD ?? join(dirname(exe), "rh-hold"));
const scratch = mkdtempSync(join(tmpdir(), "rhodium-test-weixin-"));
const privateDir = scratch;
const config = join(privateDir, "config.toml");
const mock = startMock();
const pickPort = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const board = pickPort.url.origin;
const port = pickPort.port;
await pickPort.stop(true);

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(PATH|PATHEXT|SystemRoot|SystemDrive|ComSpec|WINDIR|ProgramFiles(?:\(x86\))?|ProgramW6432|ProgramData|PROCESSOR_ARCHITECTURE|USERDOMAIN|USERNAME|COMPUTERNAME|TEMP|TMP|LANG|LC_ALL|XDG_RUNTIME_DIR)$/i.test(key)));
Object.assign(env, { HOME: privateDir, USERPROFILE: privateDir, APPDATA: privateDir, LOCALAPPDATA: privateDir,
  NO_PROXY: "127.0.0.1,localhost",
  RHODIUM_SOCKET: join(privateDir, "run", "rh.sock") });
const quote = JSON.stringify;
const missing = quote(join(privateDir, "unavailable"));
const settings = [
  `stateDir = ${quote(join(privateDir, "state"))}`,
  `socketDir = ${quote(join(privateDir, "run"))}`, `holdBin = ${quote(hold)}`,
  `unitPrefix = "${basename(scratch)}-"`,
  "[programs]", `claude = ${missing}`, `codex = ${missing}`, `pi = ${missing}`, `herdr = ${missing}`,
  "[herdr]", 'session = "rhodium-test"',
  "[board]", 'bind = "127.0.0.1"', `port = ${port}`, 'auth = "none"',
  "[plugins.echo-agent]", `path = ${quote(join(root, "examples/plugins/echo-agent"))}`,
  "[plugins.weixin]", `path = ${quote(import.meta.dir)}`,
  "[bots.demo-weixin]", 'platform = "weixin"', 'target = "demo/echo"',
  ...Object.entries(mock.config).map(([key, value]) => `${key} = ${quote(value)}`),
].join("\n") + "\n";
writeFileSync(config, settings, { mode: 0o600 });

let daemon: Bun.Subprocess<"ignore", "ignore", "pipe"> | undefined;
let log = "";
let messageId = 0;
let slot: string | undefined;
const inject = (text: string, sender = mock.chat) => mock.queue([{ id: ++messageId, text, sender }]);
const output = (from: number, text: string) =>
  mock.sent.slice(from).some(post => post.to_user_id === mock.chat &&
    post.item_list.some(item => item.text_item?.text?.includes(text)));

async function waitFor(check: () => boolean | Promise<boolean>, label: string) {
  const end = Date.now() + 20_000;
  while (!await check()) {
    if (daemon?.exitCode != null || Date.now() >= end) throw new Error(`Waiting for ${label}\n${log.slice(-3000)}`);
    await Bun.sleep(80);
  }
}

async function start() {
  log = "";
  daemon = Bun.spawn([exe, "--config", config], { cwd: privateDir, env, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  void (async (stderr) => {
    for await (const chunk of stderr.pipeThrough(new TextDecoderStream())) log += chunk;
  })(daemon.stderr);
  const pid = daemon.pid;
  await waitFor(async () => {
    try {
      const res = await fetch(board + "/api/rhodium", { signal: AbortSignal.timeout(600) });
      return res.ok && (await res.json()).pid === pid;
    } catch { return false; }
  }, "isolated daemon");
}

async function stop() {
  const proc = daemon;
  if (!proc) return;
  daemon = undefined;
  if (proc.exitCode === null) proc.kill();
  await proc.exited;
}

async function rh(...argv: string[]) {
  const res = await fetch(board + "/api/act", { method: "POST", headers: {
    "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin",
  }, body: JSON.stringify({ id: randomUUID(), act: { kind: "rh", argv } }), signal: AbortSignal.timeout(25_000) });
  const result = await res.json() as { ok: boolean; text: string; slot?: string; error?: string };
  if (!result.ok) throw new Error(`rh ${argv[0]}: ${result.error}`);
  return result;
}

async function terminal(...args: string[]) {
  const command = [exe, "rh", ...args].map(word => "'" + word.replaceAll("'", "'\\''") + "'").join(" ");
  const child = Bun.spawn(["script", "-qec", command, "/dev/null"], {
    cwd: privateDir, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 30_000,
  });
  const [out, error, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (code) throw new Error(`rh ${args[0]}: ${out}${error}`);
  return out;
}

try {
  await start();
  await rh("ws", "demo", privateDir);
  slot = (await rh("new", "demo/echo", "--agent", "echo-agent")).slot!;
  const code = /配对码：(\S+)/.exec(await terminal("pair", "demo-weixin"))?.[1];
  if (!code) throw new Error("Core did not issue a pairing code");
  inject(code);
  await waitFor(() => output(0, "已配对"), "first pairing receipt");
  const paired = Bun.TOML.parse(readFileSync(config, "utf8")) as { mainChat?: string };
  if (paired.mainChat !== `demo-weixin/${mock.chat}`) throw new Error("First owner did not become the main chat");

  let from = mock.sent.length;
  inject("/rh_use");
  await waitFor(() => output(from, "1."), "numbered choices");
  from = mock.sent.length;
  inject("1");
  await waitFor(() => output(from, "demo/echo"), "choice receipt");

  for (const [answer, receipt] of [["允许", "已允许"], ["拒绝", "已拒绝"]] as const) {
    from = mock.sent.length;
    inject("[ask]");
    await waitFor(() => output(from, "允许") && output(from, "拒绝"), "plain-text approval prompt");
    from = mock.sent.length;
    inject(answer);
    await waitFor(() => output(from, receipt), "approval receipt");
    await waitFor(() => output(from, "Echo:"), "agent reply");
  }
  await rh("stop", slot);
  await waitFor(async () => {
    const status = await (await fetch(board + "/api/slot?id=" + slot)).json();
    return !status.live && status.phase === "off";
  }, "test holder shutdown");
  slot = undefined;

  const cursor = String(messageId);
  await waitFor(() => mock.cursors.includes(cursor), "persisted cursor");
  await stop();
  const polls = mock.cursors.length;
  await start();
  await waitFor(() => mock.cursors.length > polls, "restored poll");
  if (mock.cursors[polls] !== cursor) throw new Error("Cursor did not survive restart");
  from = mock.sent.length;
  await terminal("send", "me", "restart push");
  await waitFor(() => output(from, "restart push"), "proactive message after restart");
  console.log("PASS first pairing, main chat, numbered choice, allow/deny, cursor and proactive push");
} finally {
  if (slot && daemon?.exitCode === null) await rh("stop", slot).catch(() => {});
  await stop();
  await mock.server.stop(true);
  rmSync(scratch, { recursive: true, force: true });
}
