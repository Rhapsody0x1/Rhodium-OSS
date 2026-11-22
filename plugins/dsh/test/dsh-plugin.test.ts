// dsh 插件的单元/集成测试:在进程内用内存流驱动 runAgentPlugin,以离线样例回放覆盖
// 正常路径、边界与失败处理、接入与契约(插件开发指南 §7)。真实 dsh 的版本校验、
// 子进程生命周期由 dsh-runtime.ts 单独封装,这里通过回放与纯函数验证其余全部行为。

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  runAgentPlugin,
  validateManifest,
  type AgentContext,
  type AgentPlugin,
} from "@rhodium-oss/plugin-sdk";
import { dshPromptMatchKey, LOCKED_DSH_VERSION, parseDshVersionOutput } from "../dsh-protocol";
import { parseFixture } from "../fixture-peer";
import { DshAgentPlugin } from "../index";

const FIXTURE_PATH = resolve(import.meta.dir, "../fixtures/sample.jsonl");
const MANIFEST = JSON.parse(readFileSync(resolve(import.meta.dir, "../plugin.json"), "utf8")) as unknown;

type Frame = Record<string, unknown>;

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function makeTempDir(): string {
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

class Harness {
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

  write(frame: Frame | string): void {
    // rh-agent/1 按行分帧:每条消息必须以 \n 结尾,否则 readJsonLines 会一直缓冲到流结束。
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

type InitOptions = {
  session?: { new: string } | { resume: string };
  approval?: boolean;
  model?: string | null;
  config?: Record<string, string>;
};

function initParams(options: InitOptions = {}): Frame {
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
    program: "dsh",
    approval: options.approval ?? false,
    model: options.model !== undefined ? options.model : "deepseek-chat",
    effort: null,
    resumed: false,
    config: { fixture: FIXTURE_PATH, ...options.config },
  };
}

/** 直接驱动帧处理用的最小 AgentContext 记录器。 */
function fakeCtx(): AgentContext & { frames: Frame[] } {
  const frames: Frame[] = [];
  const record = (frame: Frame) => frames.push(frame);
  return {
    frames,
    taken: (inputId) => record({ type: "taken", inputId }),
    turnStart: (input) => record({ type: "turn_start", input }),
    session: (session) => record({ type: "session", session }),
    textDelta: (text) => record({ type: "text_delta", text }),
    toolStart: (id, name, input) => record({ type: "tool_start", id, name, input }),
    item: (item) => record({ type: "item", item }),
    ask: (ask) => record({ type: "ask", ...ask }),
    askCancel: (requestId) => record({ type: "ask_cancel", requestId }),
    usage: (usage) => record({ type: "usage", ...usage }),
    turnEnd: (replyOrOpts?, extraOpts?) => record({
      type: "turn_end",
      ...(typeof replyOrOpts === "string" ? { reply: replyOrOpts } : {}),
      ...((typeof replyOrOpts === "object" ? replyOrOpts : extraOpts) ?? {}),
    }),
    error: (detail, recoverable) => record({ type: "error", detail, recoverable }),
    log: (message) => record({ type: "log", message }),
  };
}

async function readyHarness(options: InitOptions = {}): Promise<Harness> {
  const io = new Harness(new DshAgentPlugin());
  io.write(initParams(options));
  await io.waitFor((frame) => frame.type === "ready", "ready");
  return io;
}

describe("dsh agent 插件(离线回放)", () => {
  test("握手与正常回合:迟到会话上报、子 agent 会话过滤、工具与回复、系统提示拼接", async () => {
    const io = await readyHarness();
    const ready = io.outgoing.find((f) => f.type === "ready")!;
    expect(ready.session).toBeNull(); // 新会话:ready.session 先填 null(§9.1)
    expect(ready.capabilities).toEqual({ liveApproval: true, steer: false, commands: ["compact"] });
    expect(ready.version).toBe(LOCKED_DSH_VERSION);

    io.write({ type: "send", id: "in-1", text: "hello dsh", human: true, mode: "turn" });
    await io.waitFor((f) => f.type === "turn_end", "turn_end");
    expect(io.outgoing.find((f) => f.type === "taken")).toEqual({ type: "taken", inputId: "in-1" });
    expect(io.outgoing.find((f) => f.type === "session")).toEqual({ type: "session", session: "conf-session-1" });
    expect(io.outgoing.filter((f) => f.type === "turn_end")).toHaveLength(1); // sub-agent-9 的 idle 不触发
    const start = io.outgoing.find((f) => f.type === "turn_start")!;
    expect(start.input).toBe("in-1");
    expect(io.outgoing.some((f) => f.type === "text_delta" && String(f.text).includes("README.md"))).toBe(true);
    expect(io.outgoing.some((f) => f.type === "item" && (f.item as Frame)?.kind === "tool" && (f.item as Frame)?.id === "call-11")).toBe(true);
    expect(String(io.outgoing.find((f) => f.type === "turn_end")!.reply)).toContain("README.md");

    const peer = io.peer();
    const prompt = peer.requests.find((r) => r.method === "session/prompt")!;
    const blocks = (prompt.params as Frame).contentBlocks as Frame[];
    expect(String(blocks[0]?.text).startsWith("离线测试系统提示")).toBe(true); // 新会话首条 prompt 前拼系统提示
    expect(blocks.at(-1)?.text).toBe("hello dsh");

    io.write({ type: "close" });
    await io.expectCleanExit();
    expect(peer.requests.some((r) => r.method === "shutdown")).toBe(true); // close → shutdown
  }, 15000);

  test("dsh 拒绝 prompt → error(不可恢复)并退出,等待核心重启槽位重投递", async () => {
    const io = await readyHarness();
    io.write({ type: "send", id: "in-f", text: "/fail", human: true, mode: "turn" });
    const error = await io.waitFor((f) => f.type === "error", "error");
    expect(error.recoverable).toBe(false);
    expect(String(error.detail)).toContain("model unavailable");
    // 插件自己退出(exit 1),未发过 taken 的输入由核心在重启后重投递;不发 turn_end。
    const code = await Promise.race([io.done, Bun.sleep(8000).then(() => -999)]);
    expect(code).toBe(1);
    expect(io.outgoing.some((f) => f.type === "turn_end")).toBe(false);
    expect(io.outgoing.some((f) => f.type === "taken")).toBe(false);
  }, 15000);

  test("中断:停对端 → turn_end 不带 reply;下一条消息前重新拉起并 session/resume", async () => {
    const io = await readyHarness();
    io.write({ type: "send", id: "in-2", text: "investigate the flaky test slowly", human: true, mode: "turn" });
    await io.waitFor((f) => f.type === "turn_start", "turn_start");
    expect(io.outgoing.some((f) => f.type === "tool_start" && f.name === "read_file")).toBe(true);
    expect(io.outgoing.some((f) => f.type === "turn_end")).toBe(false); // 回合未结束才可打断

    io.write({ type: "interrupt" });
    const end = await io.waitFor((f) => f.type === "turn_end", "interrupted turn_end");
    expect(end.reply).toBeUndefined();

    io.write({ type: "send", id: "in-3", text: "继续修那个 flaky 测试", human: true, mode: "turn" });
    await io.waitFor((f) => f.type === "turn_end" && typeof f.reply === "string", "resumed turn_end");
    const peer = io.peer();
    expect(peer.requests.filter((r) => r.method === "initialize")).toHaveLength(2); // 中断后重新拉起
    expect(peer.requests.some((r) => r.method === "session/resume")).toBe(true);
    const lastPrompt = [...peer.requests].reverse().find((r) => r.method === "session/prompt")!;
    const blocks = (lastPrompt.params as Frame).contentBlocks as Frame[];
    expect(blocks).toHaveLength(1); // 续接的会话历史里已有系统提示,不再拼
    expect(blocks[0]?.text).toBe("继续修那个 flaky 测试");
    // 恢复时 dsh 给被打断的工具调用补的合成结果(error: true)
    expect(io.outgoing.some((f) => {
      const item = f.item as Frame | undefined;
      return f.type === "item" && item?.id === "call-71" && (item.result as Frame | undefined)?.error === true;
    })).toBe(true);

    io.write({ type: "close" });
    await io.expectCleanExit();
  }, 15000);

  test("resume 会话:initialize → session/resume → ready 带 session", async () => {
    const io = await readyHarness({ session: { resume: "conf-session-1" } });
    const ready = io.outgoing.find((f) => f.type === "ready")!;
    expect(ready.session).toBe("conf-session-1");
    io.write({ type: "send", id: "in-9", text: "继续修那个 flaky 测试", human: true, mode: "turn" });
    await io.waitFor((f) => f.type === "turn_end" && typeof f.reply === "string", "resumed turn_end");
    const peer = io.peer();
    expect(peer.requests.some((r) => r.method === "session/resume")).toBe(true);
    const prompt = peer.requests.find((r) => r.method === "session/prompt")!;
    expect(((prompt.params as Frame).contentBlocks as Frame[])).toHaveLength(1);
    io.write({ type: "close" });
    await io.expectCleanExit();
  }, 15000);

  test("审批:放行 → allowed-once,工具结果先于 ask_resolved", async () => {
    const io = await readyHarness({ approval: true });
    io.write({ type: "send", id: "in-4", text: "帮我删除 plugins 下的临时文件", human: true, mode: "turn" });
    const ask = await io.waitFor((f) => f.type === "ask", "ask");
    expect(ask.kind).toBe("permission");
    expect(ask.tool).toBe("delete_file");
    expect(ask.toolUse).toBe("call-81");
    expect(String(ask.requestId).startsWith("ap-")).toBe(true);
    expect(io.outgoing.some((f) => f.type === "ask_resolved")).toBe(false); // 未答前不闭合

    io.write({ type: "answer", requestId: ask.requestId, answer: { kind: "permission", allow: true } });
    const ack = await io.waitFor((f) => f.type === "ask_resolved" && f.requestId === ask.requestId, "ask_resolved");
    const toolItem = io.outgoing.find((f) => f.type === "item" && (f.item as Frame)?.id === "call-81")! as Frame;
    expect(((toolItem.item as Frame).result as Frame).text).toBe("已删除 3 个临时文件");
    expect(io.outgoing.indexOf(toolItem)).toBeLessThan(io.outgoing.indexOf(ack)); // 首次交付成功后才发 ask_resolved
    await io.waitFor((f) => f.type === "turn_end", "turn_end");
    expect(io.peer().responses).toContainEqual({ id: "srv-1", frame: { outcome: "allowed-once" } });

    io.write({ type: "close" });
    await io.expectCleanExit();
  }, 15000);

  test("审批:拒绝 → rejected;回放照样放完录制的结果帧", async () => {
    const io = await readyHarness({ approval: true });
    io.write({ type: "send", id: "in-5", text: "帮我删除 plugins 下的临时文件", human: true, mode: "turn" });
    const ask = await io.waitFor((f) => f.type === "ask", "ask");
    io.write({ type: "answer", requestId: ask.requestId, answer: { kind: "permission", allow: false } });
    await io.waitFor((f) => f.type === "ask_resolved", "ask_resolved");
    await io.waitFor((f) => f.type === "turn_end", "turn_end");
    expect(io.peer().responses).toContainEqual({ id: "srv-1", frame: { outcome: "rejected" } });
    io.write({ type: "close" });
    await io.expectCleanExit();
  }, 15000);

  test("审批关闭时自动放行,不惊动核心", async () => {
    const io = await readyHarness({ approval: false });
    io.write({ type: "send", id: "in-6", text: "帮我删除 plugins 下的临时文件", human: true, mode: "turn" });
    await io.waitFor((f) => f.type === "turn_end", "turn_end");
    expect(io.outgoing.some((f) => f.type === "ask")).toBe(false);
    expect(io.peer().responses).toContainEqual({ id: "srv-1", frame: { outcome: "allowed-once" } });
    io.write({ type: "close" });
    await io.expectCleanExit();
  }, 15000);

  test("提问:选项答案填 selected,自由回答填 custom,每题恰好一项", async () => {
    const io = await readyHarness();
    io.write({ type: "send", id: "in-7", text: "确认两件事再动手", human: true, mode: "turn" });
    const ask = await io.waitFor((f) => f.type === "ask", "ask");
    expect(ask.kind).toBe("question");
    expect(ask.requestId).toBe("uq-q-9");
    expect(ask.tool).toBe("ask_user_question");
    const questions = ((ask.input as Frame).questions as Frame[])!;
    expect(questions).toHaveLength(2);
    expect((questions[0]?.options as Frame[])?.map((o) => o.label)).toEqual(["TypeScript", "Python"]);

    io.write({
      type: "answer",
      requestId: ask.requestId,
      answer: { kind: "question", answers: { "用哪种语言重写这个脚本?": "TypeScript", "要写测试吗?": "顺手写一个" } },
    });
    await io.waitFor((f) => f.type === "ask_resolved" && f.requestId === ask.requestId, "ask_resolved");
    await io.waitFor((f) => f.type === "turn_end", "turn_end");
    // 0.2.2-rc.5 校验:selected 为标签数组;自由回答填 custom
    expect(io.peer().responses).toContainEqual({
      id: "srv-2",
      frame: { answers: [{ id: "q1", selected: ["TypeScript"] }, { id: "q2", selected: [], custom: "顺手写一个" }] },
    });
    io.write({ type: "close" });
    await io.expectCleanExit();
  }, 15000);

  test("插件重启后核心重发的 answer(未知 requestId)→ ask_cancel,不回 dsh", async () => {
    const io = await readyHarness();
    io.write({ type: "answer", requestId: "uq-gone", answer: { kind: "question", answers: {} } });
    await io.waitFor((f) => f.type === "ask_cancel" && f.requestId === "uq-gone", "ask_cancel");
    expect(io.outgoing.some((f) => f.type === "ask_resolved" && f.requestId === "uq-gone")).toBe(false);
    io.write({ type: "close" });
    await io.expectCleanExit();
  }, 15000);

  test("compact 命令:session/query → command_result;未声明命令返回 ok:false", async () => {
    const io = await readyHarness();
    io.write({ type: "command", id: "cmd-1", name: "compact", args: "" });
    const result = await io.waitFor((f) => f.type === "command_result" && f.id === "cmd-1", "command_result");
    expect(result.ok).toBe(true);
    expect(result.result).toEqual({ command: "compact", beforeTokens: 9600, afterTokens: 2100 });

    io.write({ type: "command", id: "cmd-2", name: "model", args: "" });
    const bad = await io.waitFor((f) => f.type === "command_result" && f.id === "cmd-2", "command_result");
    expect(bad.ok).toBe(false);
    expect(String(bad.error)).toContain("Unsupported command: model");
    io.write({ type: "close" });
    await io.expectCleanExit();
  }, 15000);

  test("user-question.cancelled → ask_cancel 且不回 dsh", async () => {
    const plugin = new DshAgentPlugin();
    const ctx = fakeCtx();
    void plugin.handleDshFrame(ctx, {
      id: "srv-9",
      method: "user-question/ask",
      params: { requestId: "q-77", questions: [{ id: "q1", question: "继续吗?" }] },
    });
    await Bun.sleep(20); // ask 同步发出
    expect(ctx.frames.some((f) => f.type === "ask" && f.requestId === "uq-q-77")).toBe(true);

    plugin.handleDshFrame(ctx, { method: "user-question.cancelled", params: { requestId: "q-77" } });
    expect(ctx.frames.some((f) => f.type === "ask_cancel" && f.requestId === "uq-q-77")).toBe(true);
    // 之后迟到的 answer 也不会再交付(提问已撤)
    await plugin.answer("uq-q-77", { kind: "question", answers: { "继续吗?": "是" } }, ctx);
    expect(ctx.frames.filter((f) => f.type === "ask_cancel" && f.requestId === "uq-q-77")).toHaveLength(2);
  });

  test("fixture 指向不存在的文件 → fatal(retryable: false)", async () => {
    const io = new Harness(new DshAgentPlugin());
    io.write(initParams({ config: { fixture: join(makeTempDir(), "missing.jsonl") } }));
    const fatal = await io.waitFor((f) => f.type === "fatal", "fatal");
    expect(String(fatal.message)).toContain("无法读取离线样例");
    expect(fatal.retryable).toBe(false);
  }, 15000);

  test("真实模式缺模型 → fatal(retryable: false)", async () => {
    const io = new Harness(new DshAgentPlugin());
    io.write(initParams({ config: { fixture: "" }, model: null })); // 走真实分支 —— 模型缺失应先于启动报错
    const fatal = await io.waitFor((f) => f.type === "fatal", "fatal");
    expect(String(fatal.message)).toContain("未配置模型");
  }, 15000);
});

describe("dsh 协议辅助与清单", () => {
  test("parseDshVersionOutput 解析各种形态", () => {
    expect(parseDshVersionOutput("dsh 0.2.3-alpha.1 (sdk profile)\n")).toBe("0.2.3-alpha.1");
    expect(parseDshVersionOutput("dsh-v0.2.3-alpha.1")).toBe("0.2.3-alpha.1");
    expect(parseDshVersionOutput("v1.2.3+build.4")).toBe("1.2.3+build.4"); // 含构建元数据也是合法 semver
    expect(parseDshVersionOutput("no version here")).toBeNull();
  });

  test("dshPromptMatchKey 取最后一个非空文本块", () => {
    expect(dshPromptMatchKey({
      contentBlocks: [
        { type: "text", text: "系统提示\n" },
        { type: "image", data: "x", mimeType: "image/png" },
        { type: "text", text: "hello dsh" },
      ],
    })).toBe("hello dsh");
    expect(dshPromptMatchKey({ contentBlocks: [] })).toBeUndefined();
    expect(dshPromptMatchKey(null)).toBeUndefined();
  });

  test("清单通过 SDK 校验;样例结构与锁定版本一致", () => {
    const validated = validateManifest(MANIFEST);
    expect(validated.ok).toBe(true);
    if (validated.ok && validated.manifest.kind === "agent") {
      expect(validated.manifest.id).toBe("dsh");
      expect(validated.manifest.program).toBe("dsh");
    }
    const { header, frames } = parseFixture(readFileSync(FIXTURE_PATH, "utf8"));
    expect(header.dshVersion).toBe(LOCKED_DSH_VERSION);
    expect(frames.length).toBeGreaterThan(20);
    for (const frame of frames) {
      if (frame.dir === "in" && (frame.method === "session.status" || frame.method === "session.event")) {
        expect((frame.params as Frame).sessionId, "会话帧必须带 sessionId").toBeString();
      }
    }
  });
});
