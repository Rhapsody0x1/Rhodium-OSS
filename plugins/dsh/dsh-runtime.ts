// 真实模式传输:拉起 `dsh --profile sdk` 子进程,在它的 stdio 上讲 dsh 原生 SDK JSON-RPC(§9.1)。
//
// - dsh 的 stdout 只放协议帧(一行一帧,\n 结尾),诊断写 stderr;插件把 stderr 转进自己的 stderr。
// - 版本锁定:每次拉起前先跑 `dsh --version`,与 LOCKED_DSH_VERSION 不同就报 fatal(retryable: false)。
// - 中断:dsh 的 SDK 协议没有取消方法,客户端放弃回合的办法是停掉进程(SIGTERM → 2s → 强杀)。
// - 关闭:发 shutdown,dsh 回 {} 后自行退出;没回就关 stdin(EOF = 正常关闭)。

import { readdirSync, readFileSync } from "node:fs";
import { readJsonLines } from "@rhodium-oss/plugin-sdk";
import {
  parseDshVersionOutput,
  type DshInboundFrame,
  type DshOutboundFrame,
  type DshTransport,
  type JsonRpcId,
} from "./dsh-protocol";

export class DshLaunchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DshLaunchError";
  }
}

function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} 超时(${ms}ms)`)), ms);
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/** 跑 `dsh --version` 并解析出版本号;找不到程序或无法解析时给出带原因的错误。 */
export async function probeDshVersion(program: string, cwd: string): Promise<string> {
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn([program, "--version"], { cwd, windowsHide: true, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (err) {
    throw new DshLaunchError(`无法启动 ${program}:${(err as Error).message}`);
  }
  const [out, errText, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new DshLaunchError(`\`${program} --version\` 退出码 ${code}${errText.trim() ? `:${errText.trim().slice(0, 400)}` : ""}`);
  const version = parseDshVersionOutput(out);
  if (!version) throw new DshLaunchError(`无法从 \`${program} --version\` 输出解析版本号:${out.trim().slice(0, 200) || "(无输出)"}`);
  return version;
}

async function* textLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    for (;;) {
      const nl = buffer.indexOf("\n");
      if (nl < 0) break;
      const line = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      if (line.trim().length > 0) yield line;
    }
  }
  buffer += decoder.decode();
  if (buffer.trim().length > 0) yield buffer.replace(/\r$/, "");
}

type DshSubprocess = Bun.Subprocess<"pipe", "pipe", "pipe">;

export class DshProcessTransport implements DshTransport {
  private readonly proc: DshSubprocess;
  private readonly pending = new Map<number, PromiseWithResolvers<unknown>>();
  private nextRequestId = 1;
  private inboundHandler: ((frame: DshInboundFrame) => void) | null = null;
  private stderrHandler: ((line: string) => void) | null = null;
  private stopped = false;
  readonly dshVersion: string;

  private constructor(proc: DshSubprocess, dshVersion: string) {
    this.proc = proc;
    this.dshVersion = dshVersion;
    void this.pumpStdout();
    void this.pumpStderr();
    void this.proc.exited.then(() => {
      this.exitHandler?.("dsh 进程已退出");
      this.rejectPending("dsh 进程已退出");
    });
  }

  private exitHandler: ((reason: string) => void) | null = null;

  onExited(handler: (reason: string) => void): void {
    this.exitHandler = handler;
  }

  /** 拉起 dsh 子进程;版本不符或启动失败抛 DshLaunchError(由插件转成 fatal)。 */
  static async launch(program: string, args: string[], cwd: string, lockedVersion: string): Promise<DshProcessTransport> {
    const version = await probeDshVersion(program, cwd);
    if (version !== lockedVersion) {
      throw new DshLaunchError(`dsh 版本不匹配:插件锁定 ${lockedVersion},实际为 ${version}。dsh 处于开发者预览阶段,请安装锁定版本,或按规格 §9.1 在升级 PR 里重录样例并更新锁定版本。`);
    }
    let proc: DshSubprocess;
    try {
      proc = Bun.spawn([program, ...args], { cwd, windowsHide: true, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    } catch (err) {
      throw new DshLaunchError(`无法启动 ${program}:${(err as Error).message}`);
    }
    return new DshProcessTransport(proc, version);
  }

  get alive(): boolean {
    return !this.stopped && this.proc.exitCode === null && this.proc.signalCode === null;
  }

  onInbound(handler: (frame: DshInboundFrame) => void): void {
    this.inboundHandler = handler;
  }

  onStderrLine(handler: (line: string) => void): void {
    this.stderrHandler = handler;
  }

  request(method: string, params: unknown, timeoutMs = 20_000): Promise<unknown> {
    if (!this.alive) return Promise.reject(new Error(`dsh 已退出,无法发送 ${method}`));
    const id = this.nextRequestId++;
    const pending = Promise.withResolvers<unknown>();
    this.pending.set(id, pending);
    try {
      this.writeFrame({ jsonrpc: "2.0", id, method, params });
    } catch (err) {
      this.pending.delete(id);
      return Promise.reject(new Error(`写入 dsh 失败:${(err as Error).message}`));
    }
    return withTimeout(pending.promise, timeoutMs, `等待 dsh 的 ${method} 响应`).catch((err) => {
      this.pending.delete(id);
      throw err;
    });
  }

  private writeFrame(frame: DshOutboundFrame): void {
    this.proc.stdin.write(JSON.stringify(frame) + "\n");
    this.proc.stdin.flush();
  }

  respond(id: JsonRpcId, result: unknown): boolean {
    if (!this.alive) return false;
    try {
      this.writeFrame({ jsonrpc: "2.0", id, result });
      return true;
    } catch {
      // 对端已断开:由调用方按交付失败处理,不发 ask_resolved。
      return false;
    }
  }

  respondError(id: JsonRpcId, error: { code: number; message: string }): void {
    if (!this.alive) return;
    try {
      this.writeFrame({ jsonrpc: "2.0", id, error });
    } catch {
      // 同上。
    }
  }

  private async pumpStdout(): Promise<void> {
    try {
      await readJsonLines(this.proc.stdout, {
        onMessage: (raw) => {
          if (!this.alive) return;
          const frame = raw as Record<string, unknown>;
          if (frame.method !== undefined && (frame.id !== undefined || frame.params !== undefined)) {
            const inbound: DshInboundFrame = frame.id !== undefined
              ? { id: frame.id as JsonRpcId, method: String(frame.method), params: frame.params }
              : { method: String(frame.method), params: frame.params };
            this.inboundHandler?.(inbound);
            return;
          }
          // 响应帧:按 id 关联
          if (frame.id === undefined || (frame.result === undefined && frame.error === undefined)) return;
          const pending = this.pending.get(Number(frame.id));
          if (!pending) return;
          this.pending.delete(Number(frame.id));
          if (frame.error !== undefined) {
            const err = frame.error as { message?: unknown };
            pending.reject(new Error(`dsh 错误响应:${typeof err.message === "string" ? err.message : JSON.stringify(frame.error)}`));
          } else {
            pending.resolve(frame.result);
          }
        },
        onError: (err) => {
          // 畸形行按诊断处理,不中断传输;超过行上限等致命读错误会在流结束后暴露。
          this.stderrHandler?.(`[dsh stdout 解析] ${err.message}`);
        },
      });
    } catch {
      // 流异常结束(进程退出);pending 由 exited 兜底拒绝。
    }
  }

  private async pumpStderr(): Promise<void> {
    try {
      for await (const line of textLines(this.proc.stderr)) {
        if (!this.alive) return;
        this.stderrHandler?.(line);
      }
    } catch {
      // 进程退出导致的流关闭。
    }
  }

  private rejectPending(reason: string): void {
    for (const waiting of this.pending.values()) waiting.reject(new Error(reason));
    this.pending.clear();
  }

  /** 中断当前回合:结束整棵进程树(dsh 的启动器会释放运行时并刷完持久化)。 */
  async kill(): Promise<void> {
    if (!this.alive) return;
    const descendants = this.collectDescendants(this.proc.pid);
    await this.terminateTree(2000);
    await Promise.race([this.proc.exited, Bun.sleep(2000)]);
    // POSIX 没有整树终止:启动器没转发到的后代进程(dsh 崩溃/不转发时)一并清理。
    // 两轮 SIGKILL,中间留 100ms:第一轮命中后 /proc 条目消失有延迟,第二轮兜底漏网的。
    for (const pid of descendants) { try { process.kill(pid, "SIGKILL"); } catch { /* 已退出 */ } }
    await Bun.sleep(100);
    for (const pid of descendants) { try { process.kill(pid, "SIGKILL"); } catch { /* 已退出 */ } }
    this.stopped = true;
    this.rejectPending("dsh 进程已被终止");
  }

  /** Linux:经 /proc 的 PPID 链收集 pid 的全部后代;其他平台返回空(macOS 无 /proc,dsh 启动器负责转发)。 */
  private collectDescendants(pid: number): number[] {
    if (process.platform !== "linux") return [];
    const parentOf = new Map<number, number>();
    try {
      for (const entry of readdirSync("/proc")) {
        if (!/^\d+$/.test(entry)) continue;
        try {
          const stat = readFileSync("/proc/" + entry + "/stat", "utf8");
          const rest = stat.slice(stat.lastIndexOf(")") + 2);
          const ppid = Number(rest.split(" ")[1]);
          if (Number.isFinite(ppid)) parentOf.set(Number(entry), ppid);
        } catch { /* 进程可能刚消失 */ }
      }
    } catch { return []; }
    const out: number[] = [];
    const queue = [pid];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const [child, parent] of parentOf) {
        if (parent === current && !out.includes(child)) { out.push(child); queue.push(child); }
      }
    }
    return out;
  }

  /**
   * 结束整棵进程树:Windows 上 proc.kill 只能杀 dsh.cmd 本体,SDK 运行时子进程还挂着
   * (审查意见 3),用 `taskkill /T /F` 结束整棵树;POSIX 走 SIGTERM → 宽限 → SIGKILL。
   */
  private async terminateTree(graceMs: number): Promise<void> {
    if (process.platform === "win32") {
      try {
        const taskkill = Bun.spawn(["taskkill", "/PID", String(this.proc.pid), "/T", "/F"], {
          windowsHide: true, stdin: "ignore", stdout: "ignore", stderr: "ignore",
        });
        await taskkill.exited;
      } catch {
        // 进程可能已自行退出。
      }
      return;
    }
    this.tryKill("SIGTERM");
    const deadline = Date.now() + graceMs;
    while (this.alive && Date.now() < deadline) await Bun.sleep(50);
    if (this.alive) this.tryKill("SIGKILL");
  }

  /** 关闭收尾:关 stdin(EOF = dsh 视为正常关闭)→ 等退出 → 必要时结束整棵进程树。shutdown 请求由插件层发出。 */
  async dispose(): Promise<void> {
    if (!this.alive) {
      this.stopped = true;
      this.rejectPending("dsh 进程已关闭");
      return;
    }
    const descendants = this.collectDescendants(this.proc.pid);
    try {
      this.proc.stdin.end();
    } catch {
      // 已退出。
    }
    await Promise.race([this.proc.exited, Bun.sleep(2000)]);
    if (this.alive) await this.terminateTree(0); // EOF 宽限已给过,直接结束整树
    for (const pid of descendants) { try { process.kill(pid, "SIGKILL"); } catch { /* 已退出 */ } }
    this.stopped = true;
    this.rejectPending("dsh 进程已关闭");
  }

  private tryKill(signal: "SIGTERM" | "SIGKILL"): void {
    try {
      this.proc.kill(signal);
    } catch {
      // 已退出。
    }
  }
}
