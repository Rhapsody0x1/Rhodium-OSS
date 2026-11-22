// dsh 插件测试共享的进程内驱动:用内存流跑 runAgentPlugin(离线回放与假 dsh 真实传输共用)。
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect } from "bun:test";
import { runAgentPlugin, type AgentPlugin } from "@rhodium-oss/plugin-sdk";
import { DshAgentPlugin } from "../index";

export const FIXTURE_PATH = resolve(import.meta.dir, "../fixtures/sample.jsonl");

export type Frame = Record<string, unknown>;

const tempDirs: string[] = [];

/** 清掉本文件里创建的临时目录;各测试文件在自己的 afterEach 里调用。 */
export function cleanupTempDirs(): void {
  while (tempDirs.length > 0) {
    try { rmSync(tempDirs.pop()!, { recursive: true, force: true }); } catch { /* Windows 句柄释放有延迟,留给进程退出 */ }
  }
}

export function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-plugin-test-"));
  tempDirs.push(dir);
  return dir;
}

function makeLineCollector(into: Frame[]): { write(chunk: string | Uint8Array): unknown } {
  let buffer = "";
  return {
    write(chunk: string | Uint8Array): unknown {
      buffer += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      for (;;) {
        const nl = buffer.indexOf("\n");
        if (nl < 0) break;
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) into.push(JSON.parse(line) as Frame);
      }
      return true;
    },
  };
}

export class Harness {
  readonly outgoing: Frame[] = [];
  exitCode: number | null = null;
  readonly stderrText: { text: string };
  readonly done: Promise<number>;
  private queue: (string | null)[] = [];
  private resolvers: ((value: string | null) => void)[] = [];

  constructor(readonly plugin: AgentPlugin) {
    const out = this.outgoing;
    const stderrText = { text: "" };
    this.stderrText = stderrText;
    this.done = runAgentPlugin(plugin, {
      stdin: this.lines(),
      stdout: makeLineCollector(out),
      stderr: {
        write(chunk: string | Uint8Array): unknown {
          stderrText.text += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
          return true;
        },
      },
      exit: (code) => {
        this.exitCode = code;
      },
      registerSignals: false,
    });
  }

  private async *lines(): AsyncGenerator<string> {
    for (;;) {
      const value = this.queue.length > 0
        ? (this.queue.shift() as string | null)
        : await new Promise<string | null>((resolveWait) => this.resolvers.push(resolveWait));
      if (value === null) return;
      yield value;
    }
  }

  /** rh-agent/1 按行分帧:每条消息必须以 \n 结尾,否则 readJsonLines 会一直缓冲到流结束。 */
  write(frame: Frame | string): void {
    const line = (typeof frame === "string" ? frame : JSON.stringify(frame)) + "\n";
    const resolver = this.resolvers.shift();
    if (resolver) resolver(line);
    else this.queue.push(line);
  }

  endStdin(): void {
    const resolver = this.resolvers.shift();
    if (resolver) resolver(null); // null = EOF
    else this.queue.push(null);
  }

  async waitFor(pred: (frame: Frame) => boolean, label: string, timeoutMs = 6000): Promise<Frame> {
    const deadline = Date.now() + timeoutMs;
    let scanned = 0;
    for (;;) {
      while (scanned < this.outgoing.length) {
        const frame = this.outgoing[scanned++]!;
        if (pred(frame)) return frame;
        if (frame.type === "fatal") throw new Error(`插件提前报 fatal(等待 ${label}):${String(frame.message)}`);
      }
      if (Date.now() > deadline) {
        throw new Error(`等待 ${label} 超时;已收到:${JSON.stringify(this.outgoing)}`);
      }
      await Bun.sleep(5);
    }
  }

  /** 关闭输入并等待插件以 0 退出。 */
  async expectCleanExit(): Promise<void> {
    this.endStdin();
    const code = await Promise.race([this.done, Bun.sleep(8000).then(() => -999)]);
    expect(code).toBe(0);
    expect(this.exitCode).toBe(0);
  }

  /** 取回放假对端(观察插件发出的请求与写回的应答)。 */
  peer(): { requests: { method: string; params: unknown }[]; responses: { id: unknown; frame: unknown }[] } {
    const peer = (this.plugin as unknown as {
      fixturePeer?: { requests: { method: string; params: unknown }[]; responses: { id: unknown; frame: unknown }[] };
    }).fixturePeer;
    if (!peer) throw new Error("插件不在回放模式");
    return peer;
  }
}

export type InitOptions = {
  session?: { new: string } | { resume: string };
  approval?: boolean;
  model?: string | null;
  program?: string;
  config?: Record<string, string>;
};

export function initParams(options: InitOptions = {}): Frame {
  const dir = makeTempDir();
  const promptFile = join(dir, "system-prompt.md");
  writeFileSync(promptFile, "离线测试系统提示(样例)\n");
  return {
    type: "init",
    proto: 1,
    conv: "conv-1",
    session: options.session ?? { new: "conf-session-1" },
    cwd: dir,
    systemPromptFile: promptFile,
    program: options.program ?? "dsh",
    approval: options.approval ?? false,
    model: options.model !== undefined ? options.model : "deepseek-chat",
    effort: null,
    resumed: false,
    config: { fixture: FIXTURE_PATH, ...options.config },
  };
}

export async function readyHarness(options: InitOptions = {}): Promise<Harness> {
  const io = new Harness(new DshAgentPlugin());
  io.write(initParams(options));
  await io.waitFor((frame) => frame.type === "ready", "ready");
  return io;
}
