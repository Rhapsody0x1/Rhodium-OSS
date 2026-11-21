// Exercise the shipped binary and both example plugins in a disposable, account-free instance.
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { createPrivateWindows, windows } from "../src/windows";

const repo = resolve(import.meta.dir, "..");
const ext = windows ? ".exe" : "";
const question = "列出当前目录并确认是否修改";
const reply = "基线回复：已收到请求，没有修改文件。";
const exe = resolve(process.env.RHODIUM_TEST_EXE || join(repo, "dist", "rhodium" + ext));
const hold = join(dirname(exe), "rh-hold" + ext);
const literal = JSON.stringify;

async function digest(file: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function until(ok: () => boolean | Promise<boolean>, what: string) {
  for (const end = Date.now() + 25_000; !(await ok()); await Bun.sleep(60)) {
    if (Date.now() > end) throw new Error("timed out waiting for " + what);
  }
}

async function freePort(port: number) {
  const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response() });
  const available = server.port!;
  await server.stop(true);
  return available;
}

async function demo() {
  const { values } = parseArgs({ options: { port: { type: "string", default: "7800" }, pause: { type: "boolean" } } });
  if (!existsSync(exe) || !existsSync(hold)) throw new Error("Build dist/rhodium and dist/rh-hold first (see README).");
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("expected --port 0..65535");
  if (values.pause && !process.stdin.isTTY) throw new Error("--pause needs an interactive terminal");
  const cancelled = new AbortController();
  const interrupt = () => cancelled.abort(new Error("Demo interrupted"));
  const boardPort = await freePort(port);
  const board = "http://127.0.0.1:" + boardPort;
  const sandbox = mkdtempSync(join(windows ? tmpdir() : "/tmp", "rhodium-test-demo-"));
  const root = windows ? join(sandbox, "private") : sandbox;
  if (windows) createPrivateWindows([root]);
  const baseline = join(root, "rhodium-demo-baseline" + ext);
  const config = join(root, "config.toml");
  const state = join(root, "state");
  const log = join(state, "dev.log");
  const runtime = join(root, "run");
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] =>
    e[1] !== undefined && /^(PATH|PATHEXT|SystemRoot|COMSPEC|WINDIR|TEMP|TMP|LANG|LC_ALL)$/i.test(e[0])));
  Object.assign(env, { HOME: root, USERPROFILE: root, LOCALAPPDATA: root, XDG_RUNTIME_DIR: runtime,
    NODE_ENV: "test", RHODIUM_TEST_DETACHED: "1", RHODIUM_SOCKET: join(runtime, "rh.sock") });
  const batches: { sender: string; channel: string; messageId: string; text: string; at: number }[] = [];
  const posts: { channel: string; message: { text: string } }[] = [];
  const platform = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/updates") {
      const i = Number(url.searchParams.get("cursor"));
      return Response.json({ messages: batches.slice(i), nextCursor: String(batches.length) });
    }
    if (url.pathname === "/send" || url.pathname === "/edit") {
      posts.push(await req.json());
      return Response.json({ status: "sent", messageId: "post-" + posts.length });
    }
    return Response.json({ ok: true });
  } });
  const inject = (text: string) => batches.push({ sender: "demo-owner", channel: "demo-dm-99", messageId: randomUUID(), text, at: Date.now() });
  let dev: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
  let printed = "", errors = "";
  let connected = false;
  const slots: string[] = [];
  const source = join(repo, "examples/plugins");
  async function act(action: object) {
    const res = await fetch(board + "/api/act", { method: "POST", headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" },
      redirect: "error", body: JSON.stringify({ id: randomUUID(), act: action }), signal: AbortSignal.timeout(25_000) });
    const result = await res.json();
    if (!result.ok) throw new Error(result.error || "board action failed");
    return result as { text: string; slot?: string };
  }
  const rh = (...argv: string[]) => act({ kind: "rh", argv });
  async function doctor() {
    const p = Bun.spawn([exe, "rh", "doctor"], { env, cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 40_000 });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    if (code) throw new Error("rh doctor: " + err);
    return out;
  }
  const terminal = async (line: string) => { dev!.stdin.write(line + "\n"); await dev!.stdin.flush(); };
  async function start(extra: string) {
    const address = "127.0.0.1:" + await freePort(0);
    const template = readFileSync(join(import.meta.dir, "config.toml"), "utf8")
      .replace('"rhodium-demo-baseline"', literal(baseline)).replaceAll('"rhodium-demo-unavailable"', literal(join(root, "unavailable" + ext)))
      .replace("port = 7800", "port = " + boardPort).replace('"127.0.0.1:17801"', literal(address));
    const text = [`stateDir = ${literal(state)}`, `socketDir = ${literal(runtime)}`, `holdBin = ${literal(hold)}`,
      `unitPrefix = "${basename(sandbox)}-"`, template, extra].join("\n");
    if (windows) { rmSync(config, { force: true }); createPrivateWindows([config], text); }
    else writeFileSync(config, text, { mode: 0o600 });
    rmSync(log, { force: true });
    printed = errors = "";
    dev = Bun.spawn([exe, "rh", "dev", "--fake", "--config", config], { env, cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const pipe = async (s: ReadableStream<Uint8Array<ArrayBuffer>>, append: (line: string) => void) => {
      for await (const chunk of s.pipeThrough(new TextDecoderStream())) append(chunk);
    };
    void pipe(dev.stdout, chunk => { printed += chunk; });
    void pipe(dev.stderr, chunk => { errors += chunk; });
    await until(() => {
      if (dev!.exitCode !== null) throw new Error("demo startup: " + errors + (existsSync(log) ? readFileSync(log, "utf8").slice(-1500) : ""));
      return existsSync(log) && readFileSync(log, "utf8").split("\n").some(line => line.includes('"msg":"ready"') && JSON.parse(line).board === "127.0.0.1:" + boardPort);
    }, "isolated board");
    connected = true;
  }
  async function stop() {
    if (!dev) return;
    if (connected) {
      for (const id of slots) {
        await rh("stop", id);
        await until(async () => (await (await fetch(board + "/api/slot?id=" + id)).json()).phase === "off", "slot stop");
      }
    }
    connected = false;
    if (dev.exitCode === null) await dev.stdin.end();
    if (await dev.exited) throw new Error("rh dev failed: " + errors + (existsSync(log) ? readFileSync(log, "utf8").slice(-1500) : ""));
    dev = undefined;
  }
  async function pause() {
    cancelled.signal.throwIfAborted();
    if (!values.pause) return;
    const input = createInterface({ input: process.stdin, output: process.stdout });
    input.on("SIGINT", interrupt);
    try { await input.question("Inspect " + board + " then press Enter to continue: ", { signal: cancelled.signal }); }
    finally { input.close(); }
  }
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    mkdirSync(runtime, { recursive: true, mode: 0o700 });
    const build = Bun.spawn([process.execPath, "build", "--compile", join(import.meta.dir, "baseline-agent/index.ts"), "--outfile", baseline],
      { cwd: repo, stdout: "ignore", stderr: "pipe" });
    const buildLog = await new Response(build.stderr).text();
    if (await build.exited) throw new Error(buildLog);
    cancelled.signal.throwIfAborted();
    const before = await digest(exe);
    console.log("Board " + board + " | input: " + question);
    await start("");
    await rh("ws", "course", root);
    slots.push((await rh("new", "course/baseline")).slot!);
    const meta = async () => (await (await fetch(board + "/api/board")).json()).metadata.plugins as { id: string; status: string }[];
    if ((await meta()).length || /插件 (echo-agent|local-im)/.test(await doctor())) throw new Error("baseline unexpectedly has plugins");
    await terminal(question);
    await until(() => printed.includes(reply), "baseline reply");
    console.log("PASS baseline: " + reply);
    await pause();
    await stop();

    const plugins = `[plugins.echo-agent]\npath = ${literal(join(source, "echo-agent"))}\n[plugins.local-im]\npath = ${literal(join(source, "local-im"))}\n[bots.local]\nplatform = "local-im"\nowner = "demo-owner"\ntarget = "course/echo"\nendpoint = ${literal(platform.url.origin)}\n`;
    await start(plugins);
    slots.push((await rh("new", "course/echo", "--agent", "echo-agent")).slot!);
    const report = await doctor();
    for (const id of ["local-im", "echo-agent"]) if (!report.includes(id) || !(await meta()).some(p => p.id === id && p.status === "loaded")) throw new Error("missing plugin: " + id);
    inject(question);
    const detail = async () => (await (await fetch(board + "/api/slot?id=" + slots[1])).json());
    await until(async () => (await detail()).asks.length === 1, "echo approval");
    inject("允许");
    await until(() => posts.some(p => p.channel === "demo-dm-99" && p.message.text.includes("Echo:")), "approved DM reply");
    const blocks = (await (await fetch(board + "/api/messages?slot=" + slots[1])).json()).blocks;
    if (!blocks.some((b: { result?: {text: string} }) => b.result?.text === "allowed")) throw new Error("missing tool result");
    console.log("PASS plugin approval: local-im → echo-agent → demo-dm-99; tool result: allowed");
    await pause();
    inject("/fail");
    await until(async () => {
      const events = await (await fetch(board + "/api/slot-events?id=" + slots[1])).json();
      return events.some((event: { type: string }) => event.type === "agent_crashed")
        && posts.some(p => p.message.text.includes("崩溃"));
    }, "plugin crash event and IM notice");
    await stop();

    mkdirSync(join(root, "broken"));
    writeFileSync(join(root, "broken/plugin.json"), "{");
    await start(plugins.replace("[plugins.echo-agent]", "[plugins.echo-agent]\nenabled = false") + '[plugins.broken]\npath = "broken"\n');
    const states = await meta();
    if (!states.some(p => p.id === "broken" && p.status === "failed") || !states.some(p => p.id === "echo-agent" && p.status === "disabled")) throw new Error("missing failure status");
    const disabled = await act({ kind: "say", slot: slots[1], text: "probe" }).then(r => r.text, err => String(err));
    if (!disabled.includes("已禁用") || !(await doctor()).includes("broken")) throw new Error("missing disabled/broken plugin diagnosis: " + disabled);
    await terminal(question);
    await until(() => printed.includes(reply), "healthy built-in after plugin failure");
    console.log("PASS failure isolation: /fail, disabled agent, broken manifest; baseline still replies");
    if (before !== await digest(exe)) throw new Error("core binary changed");
    console.log("PASS same core SHA-256 " + before);
    await pause();
  } finally {
    try { await stop(); } finally {
      dev?.kill();
      await platform.stop(true);
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
      rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
}
if (import.meta.main) await demo().catch(err => { console.error((err as Error).message); process.exitCode = 1; });
