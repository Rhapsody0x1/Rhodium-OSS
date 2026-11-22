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

/** 进程是否还活着:Linux 上 SIGKILL 后的孤儿在被 init 回收前呈 zombie 状态,kill(pid, 0) 分不出来,读 /proc 状态位。 */
function processAlive(pid: number): boolean {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync("/proc/" + pid + "/stat", "utf8");
      const state = stat.slice(stat.lastIndexOf(")") + 2).trim().split(" ")[0];
      return state !== "Z" && state !== "X";
    } catch {
      return false; // /proc 条目消失 = 已退出并被回收
    }
  }
  try { process.kill(pid, 0); return true; } catch { return false; }
}

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

function runtimeInit(program: string, approval = false): { type: "init"; [k: string]: unknown } {
  return {
    type: "init",
    proto: 1,
    conv: "conv-rt",
    session: { new: "rt-session-1" },
    cwd: makeTempDir(),
    systemPromptFile: "",
    program,
    approval,
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
    let diag = "child gone";
    if (processAlive(childPid)) {
      try {
        const stat = readFileSync("/proc/" + childPid + "/stat", "utf8");
        const cmd = readFileSync("/proc/" + childPid + "/cmdline", "utf8").split("\0").filter(Boolean).join(" ");
        const ppid = stat.slice(stat.lastIndexOf(")") + 2).trim().split(" ")[1];
        diag = "still alive: state=" + stat.slice(stat.lastIndexOf(")") + 2).trim().split(" ")[0] + " ppid=" + ppid + " cmd=" + cmd;
      } catch (e) { diag = "still alive, stat unreadable: " + String(e); }
    }
    expect(processAlive(childPid), diag).toBe(false);

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

  test("等待审批时中断:旧 dsh 退出后才发 turn_end,紧接的下一条消息能正常续接", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-rt-"));
    const lockFile = join(dir, "session.lock");
    const program = writeFakeProgram(dir, { FAKE_DSH_LOCK_FILE: lockFile });
    const io = new Harness(new DshAgentPlugin());
    io.write(runtimeInit(program, true));
    await io.waitFor((f) => f.type === "ready", "ready", 15000);
    io.write({ type: "send", id: "in-1", text: "need approval to delete", human: true, mode: "turn" });
    const ask = await io.waitFor((f) => f.type === "ask", "ask", 15000);
    const oldPid = Number(readFileSync(lockFile, "utf8").trim());

    io.write({ type: "interrupt" });
    await io.waitFor((f) => f.type === "ask_cancel" && f.requestId === ask.requestId, "ask_cancel", 15000);
    await io.waitFor((f) => f.type === "turn_end", "interrupted turn_end", 15000);
    expect(processAlive(oldPid)).toBe(false); // 旧进程(收到 SIGTERM 后 400ms 才退出)已退出

    // 核心收到 turn_end 后立刻投递下一条:新 dsh 的 session/resume 不应被旧进程的会话锁拒绝
    io.write({ type: "send", id: "in-2", text: "next one", human: true, mode: "turn" });
    const end = await io.waitFor((f) => f.type === "turn_end" && typeof f.reply === "string", "resumed turn_end", 15000);
    expect(String(end.reply)).toContain("Echo: next one");
    await cleanup(io);
    rmSync(dir, { recursive: true, force: true });
  }, 25000);

  test("中断时旧 dsh 退出前发来的审批请求被丢弃,不产生过期的 ask", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-rt-"));
    const program = writeFakeProgram(dir, {
      FAKE_DSH_MODE: "hang",
      FAKE_DSH_LOCK_FILE: join(dir, "session.lock"),
      FAKE_DSH_ASK_ON_TERM: "1",
    });
    const io = new Harness(new DshAgentPlugin());
    io.write(runtimeInit(program, true));
    await io.waitFor((f) => f.type === "ready", "ready", 15000);
    io.write({ type: "send", id: "in-1", text: "run forever", human: true, mode: "turn" });
    await io.waitFor((f) => f.type === "turn_start", "turn_start", 15000);
    io.write({ type: "interrupt" });
    await io.waitFor((f) => f.type === "turn_end", "interrupted turn_end", 15000);
    expect(io.outgoing.some((f) => f.type === "ask")).toBe(false);
    await cleanup(io);
    rmSync(dir, { recursive: true, force: true });
  }, 25000);

  test("压缩中 /stop:停掉 dsh,命令报已中断并发 turn_end,不等核心超时", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-rt-"));
    const program = writeFakeProgram(dir, { FAKE_DSH_MODE: "hang" });
    const io = new Harness(new DshAgentPlugin());
    io.write(runtimeInit(program));
    await io.waitFor((f) => f.type === "ready", "ready", 15000);
    io.write({ type: "command", id: "cmd-1", name: "compact", args: "" });
    await Bun.sleep(200); // 等 session/query 发出
    io.write({ type: "interrupt" });
    const result = await io.waitFor((f) => f.type === "command_result" && f.id === "cmd-1", "command_result", 5000);
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("压缩已中断");
    await io.waitFor((f) => f.type === "turn_end", "turn_end", 5000);
    await cleanup(io);
    rmSync(dir, { recursive: true, force: true });
  }, 25000);
});
