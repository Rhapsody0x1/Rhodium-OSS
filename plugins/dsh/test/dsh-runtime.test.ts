// dsh 真实传输层的测试:用一个假 dsh 脚本当 init.program,覆盖版本校验、找不到程序、
// 中断时的整树清理、回合中途崩溃与 turn/end 错误原因透出(审查意见 1/3/4/7)。
// 每个用例几百毫秒,CI 上不需要安装 dsh,也不需要 Key。
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { LOCKED_DSH_VERSION } from "../dsh-protocol";
import { DshAgentPlugin } from "../index";
import { cleanupTempDirs, Harness, makeTempDir, type Frame } from "./harness";

const FAKE_TS = resolve(import.meta.dir, "fake-dsh.ts");

afterEach(() => cleanupTempDirs());

/** 生成本平台的包装脚本:bun 执行假 dsh(复制到临时目录,避免中文仓库路径被 cmd.exe 按 GBK 解析),并注入行为环境变量。 */
function writeFakeProgram(dir: string, env: Record<string, string>): string {
  const exec = process.execPath; // bun 的绝对路径
  const fakeTs = join(dir, "fake-dsh.ts");
  writeFileSync(fakeTs, readFileSync(FAKE_TS));
  if (process.platform === "win32") {
    const p = join(dir, "fake-dsh.cmd");
    const lines = ["@echo off"];
    for (const [key, value] of Object.entries(env)) lines.push(`set ${key}=${value}`);
    lines.push(`"${exec}" "${fakeTs}" %*`);
    writeFileSync(p, lines.join("\r\n") + "\r\n");
    return p;
  }
  const p = join(dir, "fake-dsh.sh");
  const injected = Object.entries(env).map(([key, value]) => `${key}="${value}"`).join(" ");
  writeFileSync(p, `#!/bin/sh\n${injected} exec "${exec}" "${fakeTs}" "$@"\n`);
  chmodSync(p, 0o755);
  return p;
}

function runtimeInit(program: string): { type: "init"; [k: string]: unknown } {
  return {
    type: "init",
    proto: 1,
    conv: "conv-rt",
    session: { new: "rt-session-1" },
    cwd: makeTempDir(),
    systemPromptFile: "",
    program,
    approval: false,
    model: "deepseek-chat",
    effort: null,
    resumed: false,
    config: {},
  };
}

async function cleanup(io: Harness): Promise<void> {
  io.write({ type: "close" });
  await io.expectCleanExit();
}

describe("dsh 真实传输层(假 dsh)", () => {
  test("正常回合:版本校验、握手、工具与回复、优雅关闭", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-rt-"));
    const program = writeFakeProgram(dir, {});
    const io = new Harness(new DshAgentPlugin());
    io.write(runtimeInit(program));
    const ready = await io.waitFor((f) => f.type === "ready", "ready", 15000);
    expect(ready.version).toBe(LOCKED_DSH_VERSION);

    io.write({ type: "send", id: "in-1", text: "hello fake", human: true, mode: "turn" });
    const end = await io.waitFor((f) => f.type === "turn_end", "turn_end", 15000);
    expect(String(end.reply)).toContain("Echo: hello fake");
    await cleanup(io);
    rmSync(dir, { recursive: true, force: true });
  }, 25000);

  test("版本不符 → fatal 且两个版本号都在消息里", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-rt-"));
    const program = writeFakeProgram(dir, { FAKE_DSH_VERSION: "0.0.9" });
    const io = new Harness(new DshAgentPlugin());
    io.write(runtimeInit(program));
    const fatal = await io.waitFor((f) => f.type === "fatal", "fatal", 15000);
    expect(fatal.retryable).toBe(false);
    expect(String(fatal.message)).toContain(LOCKED_DSH_VERSION);
    expect(String(fatal.message)).toContain("0.0.9");
    rmSync(dir, { recursive: true, force: true });
  }, 20000);

  test("找不到程序 → fatal(retryable: false)", async () => {
    const io = new Harness(new DshAgentPlugin());
    io.write(runtimeInit(process.platform === "win32" ? "Z:/definitely/not/here/dsh.cmd" : "/definitely/not/here/dsh"));
    const fatal = await io.waitFor((f) => f.type === "fatal", "fatal", 15000);
    expect(fatal.retryable).toBe(false);
    expect(String(fatal.message)).toContain("无法启动");
  }, 20000);

  test("中断:整棵进程树被清理,turn_end 不带 reply", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-rt-"));
    const pidFile = join(dir, "child.pid");
    const program = writeFakeProgram(dir, { FAKE_DSH_MODE: "hang", FAKE_DSH_PID_FILE: pidFile });
    const io = new Harness(new DshAgentPlugin());
    io.write(runtimeInit(program));
    await io.waitFor((f) => f.type === "ready", "ready", 15000);
    io.write({ type: "send", id: "in-1", text: "hang please", human: true, mode: "turn" });
    await io.waitFor((f) => f.type === "turn_start", "turn_start", 15000);
    // 等假 dsh 把子孙进程 PID 写出来
    const deadline = Date.now() + 5000;
    while (!existsSync(pidFile) && Date.now() < deadline) await Bun.sleep(20);
    expect(existsSync(pidFile)).toBe(true);
    const childPid = Number(readFileSync(pidFile, "utf8").trim());

    io.write({ type: "interrupt" });
    const end = await io.waitFor((f) => f.type === "turn_end", "interrupted turn_end", 15000);
    expect(end.reply).toBeUndefined();

    // 子进程属于 dsh 进程树的一部分,整树清理后应当已退出(审查意见 3)
    let childAlive = true;
    try { process.kill(childPid, 0); } catch { childAlive = false; }
    expect(childAlive).toBe(false);

    io.write({ type: "close" });
    await io.expectCleanExit();
    rmSync(dir, { recursive: true, force: true });
  }, 25000);

  test("回合中途崩溃 → error(不可恢复),插件退出等待核心续接", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-rt-"));
    const program = writeFakeProgram(dir, { FAKE_DSH_MODE: "crash" });
    const io = new Harness(new DshAgentPlugin());
    io.write(runtimeInit(program));
    await io.waitFor((f) => f.type === "ready", "ready", 15000);
    io.write({ type: "send", id: "in-1", text: "crash please", human: true, mode: "turn" });
    await io.waitFor((f) => f.type === "turn_start", "turn_start", 15000);
    const error = await io.waitFor((f) => f.type === "error", "error", 15000);
    expect(error.recoverable).toBe(false);
    const code = await Promise.race([io.done, Bun.sleep(8000).then(() => -999)]);
    expect(code).toBe(1);
    expect(io.outgoing.some((f: Frame) => f.type === "turn_end")).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  }, 25000);

  test("turn/end 错误原因透出:error + reply(真实传输)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-rt-"));
    const program = writeFakeProgram(dir, { FAKE_DSH_MODE: "error" });
    const io = new Harness(new DshAgentPlugin());
    io.write(runtimeInit(program));
    await io.waitFor((f) => f.type === "ready", "ready", 15000);
    io.write({ type: "send", id: "in-1", text: "error please", human: true, mode: "turn" });
    await io.waitFor((f) => f.type === "turn_start", "turn_start", 15000);
    const error = await io.waitFor((f) => f.type === "error", "error", 15000);
    expect(String(error.detail)).toContain("invalid api key (fake)");
    const end = await io.waitFor((f) => f.type === "turn_end", "turn_end", 15000);
    expect(String(end.reply)).toContain("dsh 出错");
    await cleanup(io);
    rmSync(dir, { recursive: true, force: true });
  }, 25000);
});
