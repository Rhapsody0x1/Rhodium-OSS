// DeepSeek Harness(dsh)agent 插件适配器 —— 插件化规格 §9.1。
//
// 一个插件进程对应一个槽位,只开一个 dsh 会话:常驻拉起 `dsh --profile sdk`,
// 在它的 stdio 上讲 dsh 原生 SDK JSON-RPC,并翻译成 rh-agent/1。全部映射在本插件内完成,
// 不修改 src/ 下的任何核心源码。
//
// 关键映射:
// - send → session/prompt(不走 slash 命令路由);response 的 { messageId } 之后发 taken。
// - session.status running/idle → turn_start/turn_end;session.event 的
//   assistant/message、tool/call、tool/result → text_delta + item / tool_start / item。
//   session.status 与 session.event 只认本槽位 sessionId(子 agent 的子会话全部忽略);
//   approval/request 与 user-question/ask 不按会话过滤,照样转成 ask。
// - 审批与提问 → ask(kind: permission / question),答案写回 dsh;同一 requestId
//   至多向下游交付一次,ask_resolved 在首次交付成功后才发(§3.2)。
// - 中断:dsh 的 SDK 协议没有取消方法 —— 停掉 dsh 进程 → 发 turn_end(不带 reply)→
//   下一条消息前重新拉起并 session/resume。
// - 零 Key 演示:config.fixture 指向离线样例时不拉起 dsh,由假对端按样例回放
//   (fixture-peer.ts),契约检查与 CI 都只用回放。

import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  PluginFatalError,
  runAgentPlugin,
  type AgentContext,
  type AgentInitParams,
  type AgentPlugin,
  type AgentReadyInfo,
  type AgentSendParams,
  type AskAnswer,
  type CommandResult,
} from "@rhodium-oss/plugin-sdk";
import {
  DEFAULT_PROVIDER,
  dshAssistantText,
  dshToolCallInput,
  dshToolResultCallId,
  dshToolResultError,
  dshToolResultText,
  LOCKED_DSH_VERSION,
  SDK_SERVER_NAME,
  toContentBlocks,
  type DshApprovalParams,
  type DshContentBlock,
  type DshEventData,
  type DshInboundFrame,
  type DshInitializeParams,
  type DshSessionEventParams,
  type DshSessionStatusParams,
  type DshTransport,
  type DshUserQuestionParams,
  type JsonRpcId,
} from "./dsh-protocol";
import { DshProcessTransport } from "./dsh-runtime";
import { FixturePeer, FixtureTransport } from "./fixture-peer";
import manifest from "./plugin.json";

/** 打包交付后 import.meta.dir 会变成 <插件目录>/dist,优先用核心注入的插件目录定位随包资源。 */
const PLUGIN_DIR = process.env.RHODIUM_PLUGIN_DIR || import.meta.dir;

/** 等待核心回答的提问:answer 在收到核心答案时兑现;delivered 在把应答写回 dsh 之后兑现(§3.2 ask_resolved 时序)。 */
type PendingAsk = {
  answer: PromiseWithResolvers<AskAnswer | null>;
  delivered: PromiseWithResolvers<void>;
};

function resolveFixturePath(value: string | undefined, pluginDir: string): string | null {
  if (!value) return null;
  return isAbsolute(value) ? value : join(pluginDir, value);
}

function readSystemPrompt(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    // 系统提示读不到不致命,跳过即可;诊断只写 stderr。
    console.error(`[dsh] 无法读取 systemPromptFile ${path}:${(err as Error).message}`);
    return "";
  }
}

export class DshAgentPlugin implements AgentPlugin {
  // —— 核心握手参数(init 时固定) ——
  private program = "dsh";
  private cwd = "";
  private sessionId: string | null = null;
  private sessionIsResume = false;
  /** dsh 的会话在第一次写入前不落盘;首次 session/prompt 返回后才算存在(§9.1)。 */
  private sessionWritten = false;
  /** 是否已向核心上报过 session(ready.session 或独立的 session 消息)。 */
  private sessionReported = false;
  private systemPrompt = "";
  private provider = DEFAULT_PROVIDER;
  private model: string | null = null;
  private effort: string | null = null;
  private fixturePath: string | null = null;
  private approvalOn = false;

  // —— 传输层与回合状态 ——
  private ctxRef: AgentContext | null = null;
  private fixturePeer: FixturePeer | null = null;
  private transport: DshTransport | null = null;
  private launching: Promise<void> | null = null;
  /** 中断时正在退出的旧 dsh;新一代必须等它退出再拉起,否则 session/resume 会被会话锁拒绝。 */
  private dying: Promise<void> | null = null;
  private closing = false;
  private activeTurn = false;
  private currentInputId: string | null = null;
  private turnAborted = false;
  private lastAssistantText: string | null = null;
  /** 本轮的 dsh 出错原因(turn/end 事件 reason.kind === "error"),idle 时透出(审查意见 1)。 */
  private turnError: string | null = null;
  private turnDone: PromiseWithResolvers<void> | null = null;
  private pendingToolCalls = new Map<string, { name: string; input: unknown }>();
  private unnamedToolSeq = 0;
  private pendingAsks = new Map<string, PendingAsk>();

  async init(params: AgentInitParams, ctx: AgentContext): Promise<AgentReadyInfo> {
    this.ctxRef = ctx;
    this.program = params.program || "dsh";
    this.cwd = params.cwd;
    this.sessionId = "new" in params.session ? params.session.new : params.session.resume;
    this.sessionIsResume = "resume" in params.session;
    this.sessionWritten = this.sessionIsResume;
    this.sessionReported = this.sessionIsResume;
    this.approvalOn = params.approval;
    this.effort = params.effort ?? null;
    this.provider = params.config.provider || DEFAULT_PROVIDER;
    this.model = params.model ?? params.config.model ?? null;
    this.fixturePath = resolveFixturePath(params.config.fixture, PLUGIN_DIR);
    // 系统提示:SDK 协议没有系统提示参数,新会话在第一条 session/prompt 前拼上;续接的历史里已有,不再拼。
    this.systemPrompt = this.sessionIsResume ? "" : readSystemPrompt(params.systemPromptFile);

    // 真实模式必须有模型(init.model → config.model);回放模式的假对端不吃参数,允许缺省。
    if (!this.fixturePath && !this.model) {
      throw new PluginFatalError(
        "未配置模型:核心的 init.model 与 [plugins.dsh] config.model 都为空。请在 config.toml 给该槽位配置模型。",
        { retryable: false },
      );
    }

    await this.launchTransport();
    await this.handshake();
    if (this.sessionWritten) await this.resumeSession();
    return {
      session: this.sessionIsResume ? this.sessionId : null,
      capabilities: manifest.capabilities,
      version: this.transport?.dshVersion ?? LOCKED_DSH_VERSION,
    };
  }

  /** 拉起一代 dsh(真实子进程或回放假对端)。 */
  private async launchTransport(): Promise<void> {
    if (this.fixturePath) {
      if (!this.fixturePeer) {
        let text: string;
        try {
          text = readFileSync(this.fixturePath, "utf8");
        } catch (err) {
          throw new PluginFatalError(`无法读取离线样例 ${this.fixturePath}:${(err as Error).message}`, { retryable: false });
        }
        try {
          this.fixturePeer = new FixturePeer(text);
        } catch (err) {
          throw new PluginFatalError(`离线样例格式错误:${(err as Error).message}`, { retryable: false });
        }
      }
      const transport = new FixtureTransport(this.fixturePeer);
      transport.onInbound((frame) => this.handleDshFrame(this.ctxRef!, frame));
      this.transport = transport;
      return;
    }
    try {
      const transport = await DshProcessTransport.launch(this.program, ["--profile", "sdk"], this.cwd, LOCKED_DSH_VERSION);
      transport.onInbound((frame) => this.handleDshFrame(this.ctxRef!, frame));
      transport.onStderrLine((line) => this.ctxRef?.log(`[dsh] ${line}`));
      transport.onExited((reason) => this.handleTransportExit(transport, reason));
      this.transport = transport;
    } catch (err) {
      // 找不到程序、版本不符、启动失败一律 fatal(retryable: false),原因取 dsh 侧信息(§9.1)。
      throw new PluginFatalError((err as Error).message, { retryable: false });
    }
  }

  /** initialize 握手;serverInfo.name 不是 dsh SDK 运行时就 fatal。 */
  private async handshake(): Promise<void> {
    const transport = this.transport!;
    // 真实模式必须有模型(init.model → config.model);回放模式的假对端不吃参数,允许缺省。
    const model = this.model ?? (this.fixturePath ? "offline-replay" : null);
    if (!model) {
      throw new PluginFatalError(
        "未配置模型:核心的 init.model 与 [plugins.dsh] config.model 都为空。请在 config.toml 给该槽位配置模型。",
        { retryable: false },
      );
    }
    const params: DshInitializeParams = {
      cwd: this.cwd,
      provider: this.provider,
      model,
      ...(this.effort ? { reasoningEffort: this.effort } : {}),
      approvalRequests: true,
      capabilities: { userQuestions: true },
    };
    let result: unknown;
    try {
      result = await transport.request("initialize", params, 30_000);
    } catch (err) {
      throw new PluginFatalError(`dsh initialize 失败:${(err as Error).message}`, { retryable: false });
    }
    const serverName = (result as { serverInfo?: { name?: unknown } } | null)?.serverInfo?.name;
    if (serverName !== SDK_SERVER_NAME) {
      throw new PluginFatalError(
        `dsh initialize 返回的 serverInfo.name 不是 "${SDK_SERVER_NAME}":${JSON.stringify(serverName ?? null)}`,
        { retryable: false },
      );
    }
  }

  /** session/resume:会话缺失、读不了或被别的进程占着时 fatal(§9.1)。 */
  private async resumeSession(): Promise<void> {
    if (!this.sessionId) return;
    try {
      await this.transport!.request("session/resume", { sessionId: this.sessionId }, 30_000);
    } catch (err) {
      throw new PluginFatalError(`dsh session/resume 失败:${(err as Error).message}`, { retryable: false });
    }
  }

  /** 中断后的下一回合前重新拉起 dsh 并续接会话(§9.1 中断)。 */
  private async ensureLaunched(): Promise<void> {
    if (this.transport?.alive) return;
    if (!this.launching) this.launching = this.relaunch();
    try {
      await this.launching;
    } finally {
      this.launching = null;
    }
  }

  private async relaunch(): Promise<void> {
    if (this.closing) return;
    await this.dying;
    await this.launchTransport();
    await this.handshake();
    if (this.sessionWritten) await this.resumeSession();
  }

  // ---------------------------------------------------------------------------
  // send → session/prompt
  // ---------------------------------------------------------------------------

  async send(msg: AgentSendParams, ctx: AgentContext): Promise<void> {
    this.turnAborted = false;
    await this.ensureLaunched();
    if (this.closing || !this.transport) return;

    const blocks: DshContentBlock[] = [];
    if (!this.sessionWritten && this.systemPrompt) blocks.push({ type: "text", text: this.systemPrompt });
    blocks.push(...toContentBlocks(msg.text, msg.images));

    this.currentInputId = msg.id;
    this.lastAssistantText = null;
    this.turnError = null;
    this.turnAborted = false;
    const done = Promise.withResolvers<void>();
    this.turnDone = done;
    const aborted = (): boolean => this.turnAborted || this.turnDone !== done;
    try {
      // session/prompt 返回 { messageId } 表示已持久入队,此时才发 taken;回合进度看通知。
      await this.transport.request("session/prompt", { sessionId: this.sessionId, contentBlocks: blocks });
      this.markSessionWritten(ctx);
      ctx.taken(msg.id);
      await done.promise;
    } catch (err) {
      if (aborted()) return; // 中断/关停期间的对端退出:回合已由 interrupt() 收尾
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith("dsh 错误响应:")) {
        // dsh 明确拒收这条 prompt(如不支持的输入):可恢复——把原因告诉用户并结束回合(审查意见 10)。
        // 若按可重试失败退出,核心会重投递同一条消息,再次被拒,循环到熔断。
        throw new Error(msg);
      }
      // 进程死亡/传输异常:按可重试失败上报,插件退出,核心重启槽位后重新拉起并 resume,
      // 未发过 taken 的输入会原样重投递(§3.2 taken 语义)。
      throw new PluginFatalError(msg, { retryable: true });
    } finally {
      if (this.turnDone === done) this.turnDone = null;
      this.activeTurn = false;
      this.currentInputId = null;
    }
  }

  /** 首次 session/prompt 成功后:会话已落盘,补报迟到会话 ID(§9.1/§3.2)。 */
  private markSessionWritten(ctx: AgentContext): void {
    if (this.sessionWritten) return;
    this.sessionWritten = true;
    if (this.sessionId && !this.sessionReported) {
      this.sessionReported = true;
      ctx.session(this.sessionId);
    }
  }

  /** dsh 进程意外退出(非中断/非关闭):让当前回合以可重试失败收场,由核心重启续接(审查意见 4)。 */
  private handleTransportExit(transport: DshTransport, reason: string): void {
    if (this.closing || this.turnAborted || this.transport !== transport) return;
    const done = this.turnDone;
    if (!done) return;
    // 只 reject、不动 turnDone:send 的 catch 里 aborted() 依据 turnDone === done 区分中断与意外退出
    done.reject(new Error(reason));
  }

  // ---------------------------------------------------------------------------
  // dsh 通知与服务端请求 → rh-agent/1
  // ---------------------------------------------------------------------------

  /** dsh 入站帧的统一入口。公开以便单元测试直接驱动帧处理。 */
  handleDshFrame(ctx: AgentContext, frame: DshInboundFrame): void {
    if ("id" in frame) {
      void this.handleServerRequest(ctx, frame);
      return;
    }
    const params = (frame.params ?? {}) as Record<string, unknown>;
    if (frame.method === "session.status") {
      this.handleSessionStatus(ctx, params as unknown as DshSessionStatusParams);
    } else if (frame.method === "session.event") {
      this.handleSessionEvent(ctx, params as unknown as DshSessionEventParams);
    } else if (frame.method === "user-question.cancelled") {
      const requestId = `uq-${String((params as unknown as DshUserQuestionParams).requestId)}`;
      const pending = this.pendingAsks.get(requestId);
      if (pending) {
        this.pendingAsks.delete(requestId);
        ctx.askCancel(requestId);
        pending.answer.resolve(null);
        pending.delivered.resolve();
      }
    }
    // 其余通知类型:直接略过。
  }

  private handleSessionStatus(ctx: AgentContext, params: DshSessionStatusParams): void {
    if (params.sessionId !== this.sessionId) return; // 子 agent 的子会话等全部忽略,避免提前 turn_end(§9.1)
    if (params.status === "running") {
      // dsh 自发回合(后台任务、定时提醒)没有触发输入:turn_start 不带 input(审查意见 5)。
      if (!this.activeTurn) {
        this.activeTurn = true;
        ctx.turnStart(this.currentInputId ?? undefined);
      }
      return;
    }
    if (params.status === "idle" && this.activeTurn) {
      // idle 是整个 agent 的状态(含进程内子 agent),全部停下才算空闲;回合结束只认这个信号。
      this.activeTurn = false;
      const error = this.turnError;
      this.turnError = null;
      if (error && !this.lastAssistantText) {
        // 模型调用出错(Key 无效/欠费等)且本轮没有助手正文:把原因透出给用户(审查意见 1)。
        ctx.error("dsh 出错:" + error, true);
        ctx.turnEnd("dsh 出错:" + error);
      } else {
        ctx.turnEnd(this.lastAssistantText ?? undefined);
      }
      this.currentInputId = null;
      const done = this.turnDone;
      this.turnDone = null;
      done?.resolve();
    }
  }

  private handleSessionEvent(ctx: AgentContext, params: DshSessionEventParams): void {
    if (params.sessionId !== this.sessionId) return; // 只认本槽位会话的事件
    const event = params.event;
    if (!event?.type) return;
    const data = (event.data ?? {}) as DshEventData;
    if (event.type === "assistant/message") {
      const text = dshAssistantText(data);
      if (!text) return; // 只有 reasoning/tool-call 块的中间消息没有可见正文
      this.lastAssistantText = text;
      ctx.textDelta(text);
      ctx.item({ kind: "message", text });
      return;
    }
    if (event.type === "tool/call") {
      const callId = typeof data.callId === "string" ? data.callId : null;
      const name = typeof data.name === "string" ? data.name : typeof data.toolName === "string" ? data.toolName : "unknown";
      const input = dshToolCallInput(data);
      if (callId) this.pendingToolCalls.set(callId, { name, input });
      ctx.toolStart(callId ?? `dsh-tool-${++this.unnamedToolSeq}`, name, input);
      return;
    }
    if (event.type === "tool/result") {
      const callId = dshToolResultCallId(data);
      const known = callId ? this.pendingToolCalls.get(callId) : undefined;
      if (callId && known) this.pendingToolCalls.delete(callId);
      const name = known?.name ?? (typeof data.name === "string" ? data.name : typeof data.toolName === "string" ? data.toolName : "unknown");
      ctx.item({
        kind: "tool",
        ...(callId ? { id: callId } : {}),
        name,
        input: known?.input ?? dshToolCallInput(data),
        result: {
          text: dshToolResultText(data),
          ...(dshToolResultError(data) ? { error: true } : {}),
        },
      });
      return;
    }
    if (event.type === "turn/end") {
      // 回合结束原因:dsh 出错时记下原因,等 idle 时透出给用户(审查意见 1)。
      const reason = (data as { reason?: { kind?: string; error?: { message?: string } } }).reason;
      if (reason?.kind === "error") this.turnError = reason.error?.message ?? "未知错误";
      return;
    }
    // user/message、system/message、step/*、job/*、request/* 等其余事件:不转。
  }

  // ---------------------------------------------------------------------------
  // 审批(approval/request)与提问(user-question/ask)
  // ---------------------------------------------------------------------------

  private async handleServerRequest(ctx: AgentContext, frame: { id: JsonRpcId; method: string; params: unknown }): Promise<void> {
    if (frame.method === "approval/request") {
      await this.handleApprovalRequest(ctx, frame.id, (frame.params ?? {}) as DshApprovalParams);
      return;
    }
    if (frame.method === "user-question/ask") {
      await this.handleUserQuestion(ctx, frame.id, (frame.params ?? {}) as DshUserQuestionParams);
      return;
    }
    this.transport?.respondError(frame.id, { code: -32601, message: `dsh 插件不支持的方法:${frame.method}` });
  }

  private newPendingAsk(): PendingAsk {
    return { answer: Promise.withResolvers<AskAnswer | null>(), delivered: Promise.withResolvers() };
  }

  private async handleApprovalRequest(ctx: AgentContext, rpcId: JsonRpcId, params: DshApprovalParams): Promise<void> {
    // 审批开关由插件逐个请求判断(liveApproval);关闭时直接放行,不惊动核心。
    if (!this.approvalOn) {
      this.transport?.respond(rpcId, { outcome: "allowed-once" });
      return;
    }
    const requestId = `ap-${String(rpcId)}`;
    const pending = this.newPendingAsk();
    this.pendingAsks.set(requestId, pending);
    ctx.ask({
      requestId,
      kind: "permission",
      tool: params.toolName ?? "unknown",
      input: params.reason !== undefined ? { reason: params.reason } : {},
      ...(params.callId !== undefined ? { toolUse: params.callId } : {}),
    });
    const answer = await pending.answer.promise;
    if (answer === null) return; // ask_cancel/进程退出:不回 dsh,等待中的审批随进程断开按拒绝处理
    const allow = answer.kind === "permission" && answer.allow;
    // dsh 的审批不收附言,message 丢弃
    this.settleDelivery(pending, this.transport?.respond(rpcId, { outcome: allow ? "allowed-once" : "rejected" }));
  }

  private async handleUserQuestion(ctx: AgentContext, rpcId: JsonRpcId, params: DshUserQuestionParams): Promise<void> {
    const questions = Array.isArray(params.questions) ? params.questions : [];
    const requestId = `uq-${String(params.requestId)}`;
    const pending = this.newPendingAsk();
    this.pendingAsks.set(requestId, pending);
    ctx.ask({
      requestId,
      kind: "question",
      tool: "ask_user_question",
      input: { questions },
    });
    const answer = await pending.answer.promise;
    if (answer === null) return;
    // 按题面配回每个问题的 id(0.2.2-rc.5 校验:每个 id 恰好一项,selected 为标签数组,
    // 可选 custom;见 dsh-sdk-jsonrpc-server 的 parseHostAnswer)。选项没有 id,只有标签:
    // 答案与某个选项标签一致时填 selected:[标签],否则作为自由回答填 custom。
    const answers = questions
      .filter((question) => question.id !== undefined)
      .map((question) => {
        const given = answer.kind === "question" ? answer.answers[question.question ?? ""] : undefined;
        const labels = (question.options ?? []).map((o) => o.label).filter((l): l is string => l !== undefined);
        if (given === undefined) return { id: question.id as string, selected: [] as string[] };
        // 多选题:核心把答案拼成 "A, B";每段都是选项标签才填 selected,否则当自由回答(审查意见 6)。
        if (question.multiSelect === true) {
          const parts = given.split(", ").map((part) => part.trim());
          if (parts.length > 0 && parts.every((part) => labels.includes(part))) {
            return { id: question.id as string, selected: parts };
          }
          return { id: question.id as string, selected: [] as string[], custom: given };
        }
        const option = labels.find((label) => label === given);
        if (option !== undefined) return { id: question.id as string, selected: [option] };
        return { id: question.id as string, selected: [] as string[], custom: given };
      });
    this.settleDelivery(pending, this.transport?.respond(rpcId, { answers }));
  }

  /** 写回成功才确认交付;失败时 answer() 抛错,SDK 发 ask_cancel 而不是 ask_resolved(§3.2)。 */
  private settleDelivery(pending: PendingAsk, written: boolean | undefined): void {
    if (written) pending.delivered.resolve();
    else pending.delivered.reject(new Error("答案未能写回 dsh(进程已退出或写入失败)"));
  }

  // ---------------------------------------------------------------------------
  // answer / approval / command / interrupt / close
  // ---------------------------------------------------------------------------

  async answer(requestId: string, answer: AskAnswer, ctx: AgentContext): Promise<void> {
    const pending = this.pendingAsks.get(requestId);
    if (!pending) {
      // dsh 的提问只在当前 dsh 进程里有效;插件重启后核心重发的 answer → ask_cancel,不回 dsh(§9.1)。
      ctx.askCancel(requestId);
      return;
    }
    this.pendingAsks.delete(requestId);
    pending.answer.resolve(answer);
    await pending.delivered.promise; // ask_resolved 在首次交付(写回 dsh)成功后才发(§3.2)
  }

  async approval(on: boolean, _ctx: AgentContext): Promise<void> {
    this.approvalOn = on;
  }

  /** 只声明 compact:model/effort 在 initialize 时定死,换模型要重启 dsh(§9.1)。 */
  async command(name: string, _args: string, _ctx: AgentContext): Promise<CommandResult> {
    if (name !== "compact") throw new Error(`Unsupported command: ${name}`);
    await this.ensureLaunched();
    let result: unknown;
    try {
      // 压缩要等摘要模型跑完,长对话经常超过默认 20 秒;给足 10 分钟,期间用户可 /stop(审查意见 2)。
      result = await this.transport!.request("session/query", {
        sessionId: this.sessionId,
        contentBlocks: [{ type: "text", text: "/compact" } satisfies DshContentBlock],
      }, 600_000);
    } catch (err) {
      // dsh 在 agent 忙时拒绝压缩等:由 SDK 回 ok:false 带原因。
      throw new Error(`dsh 压缩失败:${(err as Error).message}`);
    }
    const execution = (result as { execution?: { beforeTokens?: unknown; afterTokens?: unknown } } | null)?.execution;
    const tokens = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
    return {
      command: "compact",
      beforeTokens: tokens(execution?.beforeTokens),
      afterTokens: tokens(execution?.afterTokens),
    };
  }

  /** 中断当前回合:停 dsh(SIGTERM → 2s → 强杀)→ 发 turn_end;下一条消息前重新拉起并 resume(§9.1)。 */
  async interrupt(ctx: AgentContext): Promise<void> {
    const hadPending = this.pendingAsks.size > 0;
    for (const [requestId, pending] of this.pendingAsks) {
      this.pendingAsks.delete(requestId);
      ctx.askCancel(requestId);
      pending.answer.resolve(null);
      pending.delivered.resolve();
    }
    if (!this.activeTurn && !hadPending) return;
    this.turnAborted = true;
    this.activeTurn = false; // 先置位:旧进程在退出前推来的 idle 不再产生第二个 turn_end(审查意见 9)
    this.currentInputId = null;
    const transport = this.transport;
    this.transport = null;
    // 不论有没有等待中的提问,都等旧 dsh 退出后再发 turn_end:核心收到 turn_end 可能立刻投递下一条,
    // 新 dsh 的 session/resume 会被还没退出的旧进程的会话锁拒绝,槽位因此 fatal。
    if (transport) {
      const dying = transport.kill().catch((err) => ctx.log(`[dsh] 终止旧进程失败:${(err as Error).message}`));
      this.dying = dying;
      await dying;
      if (this.dying === dying) this.dying = null;
    }
    this.pendingToolCalls.clear();
    ctx.turnEnd(); // 不带 reply,槽位回到空闲
    const done = this.turnDone;
    this.turnDone = null;
    done?.resolve();
  }

  async close(): Promise<void> {
    this.closing = true;
    this.turnAborted = true;
    for (const [, pending] of this.pendingAsks) {
      pending.answer.resolve(null);
      pending.delivered.resolve();
    }
    this.pendingAsks.clear();
    const done = this.turnDone;
    this.turnDone = null;
    done?.resolve();
    this.activeTurn = false;
    const transport = this.transport;
    this.transport = null;
    if (!transport) return;
    // 优雅关闭:发 shutdown(1.5s 超时),dsh 回 {} 后自行退出;没回就靠 dispose 关 stdin(EOF = 正常关闭)。
    try {
      await transport.request("shutdown", {}, 1500);
    } catch {
      // shutdown 没有回执时由 dispose 兜底。
    }
    await transport.dispose();
  }
}

if (import.meta.main) {
  runAgentPlugin(new DshAgentPlugin());
}
