// Agent plugins speak rh-agent/1 through their holder (spec/plugins §3.2).
import { MAX_LINE_BYTES, type AgentCapabilities, type AgentInitParams, type AgentToCoreMessage, type CoreToAgentMessage } from "@rhodium-oss/plugin-sdk";
import { headlessEnv } from "./agents";
import type { AgentAsk, AgentDriver, AgentEmit, AgentEvent, AgentLink, AgentMessage, AskAnswer, CommandResult, CommonCommand, SendMode, SpawnSpec } from "./contracts";
import { closeLink } from "./holder";
import type { LoadedPlugin } from "./plugin-loader";

type Body = AgentEvent extends infer E ? E extends AgentEvent ? Omit<E, "conv" | "proc"> : never : never;
type Options = { conv: string; boot: number; emit: AgentEmit; kind: string; plugin?: LoadedPlugin; config: Record<string, string>; handshakeMs: number; interruptMs: number; stopGrace: number };
type Launch = Parameters<AgentDriver["spawn"]>[0];

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const str = (value: unknown): value is string => typeof value === "string";
const nullableString = (value: unknown) => value === null || str(value);
const optionalString = (value: unknown) => value === undefined || str(value);
const optionalBool = (value: unknown) => value === undefined || typeof value === "boolean";
const optionalNumber = (value: unknown) => value === undefined || (typeof value === "number" && Number.isFinite(value));
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(str);

function capabilities(value: unknown): value is AgentCapabilities {
  return object(value) && optionalBool(value.steer) && optionalBool(value.liveApproval)
    && (value.commands === undefined || strings(value.commands))
    && (value.models === undefined || (Array.isArray(value.models) && value.models.every((m: unknown) =>
      object(m) && str(m.id) && optionalString(m.label) && (m.efforts === undefined || strings(m.efforts)))));
}

const num = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const nullableNumber = (value: unknown) => value === null || num(value);
const rows = (value: unknown, test: (row: Record<string, unknown>) => boolean) => Array.isArray(value) && value.every((row) => object(row) && test(row));
const quota = (value: unknown) => rows(value, (r) => (r.window === "5h" || r.window === "7d") && num(r.usedPercent) && nullableNumber(r.resetsAt) && optionalString(r.model) && optionalString(r.limitId));
const choices = (value: unknown) => value === undefined || rows(value, (r) => str(r.id) && str(r.label) && optionalString(r.group));
const tokens = (value: unknown) => object(value) && [value.input, value.output, value.cacheRead, value.cacheWrite, value.total].every(num);
const context = (value: unknown) => object(value) && num(value.usedTokens) && nullableNumber(value.maxTokens);

// These objects go directly to the core's command formatters and the board.
function commandResult(name: CommonCommand, r: unknown): r is CommandResult {
  if (!object(r) || r.command !== name) return false;
  switch (name) {
    case "status": return nullableString(r.model) && (r.context === null || context(r.context)) && (r.limits === undefined || quota(r.limits)) && optionalString(r.effort);
    case "context": return context(r) && (r.categories === undefined || rows(r.categories, (c) => str(c.name) && num(c.tokens)));
    case "model": return nullableString(r.model) && choices(r.choices) && choices(r.efforts) && [r.label, r.level, r.was].every(optionalString);
    case "effort": return str(r.level) && choices(r.choices);
    case "compact": return nullableNumber(r.beforeTokens) && nullableNumber(r.afterTokens);
    case "usage":
      return quota(r.limits) && optionalNumber(r.credits)
        && (r.extra === undefined || (object(r.extra) && num(r.extra.usedPercent) && num(r.extra.used) && nullableNumber(r.extra.limit) && str(r.extra.currency)))
        && (r.session === undefined || (object(r.session) && optionalNumber(r.session.cost) && tokens(r.session.tokens)
          && (r.session.models === undefined || rows(r.session.models, (m) => str(m.name) && num(m.cost) && tokens(m.tokens)))));
    default: return false;
  }
}

export class PluginAgentDriver implements AgentDriver {
  readonly conv: string;
  readonly kind: string;
  readonly info: { session: string | null; selfStarted: boolean | null; why?: string; retryable?: boolean; capabilities?: AgentCapabilities } = { session: null, selfStarted: null };
  private link?: AgentLink;
  private proc = 0;
  private serial = 0;
  private init?: AgentInitParams;
  private gate?: PromiseWithResolvers<void>;
  private handshake?: ReturnType<typeof setTimeout>;
  private interruptTimer?: ReturnType<typeof setTimeout>;
  private closing?: Promise<void>;
  private busy = false;
  interruptExpired = false;
  private replayDone = false;
  private asks = new Map<string, AgentAsk>();
  private requests = new Map<string, { name: CommonCommand; result: PromiseWithResolvers<CommandResult> }>();

  constructor(private readonly o: Options) {
    this.conv = o.conv;
    this.kind = o.kind;
    if (o.plugin && (o.plugin.manifest.kind !== "agent" || o.plugin.id !== o.kind)) throw new Error("expected an agent plugin");
  }

  get canSend(): boolean {
    return !!this.o.plugin && !!this.link && !this.closing && !!this.info.capabilities && (!this.busy || !!this.info.capabilities.steer);
  }

  spawn(opts: Launch): SpawnSpec {
    if (!this.o.plugin) throw new Error(`插件 ${this.kind} 未加载，无法启动。`);
    const { env, ultracode: _, ...params } = opts;
    this.init = { ...params, proto: 1, conv: this.conv, config: this.o.config };
    return {
      argv: [...this.o.plugin.command], cwd: opts.cwd,
      env: { ...headlessEnv(this.o.plugin.id, env), RHODIUM_PLUGIN_DIR: this.o.plugin.dir, PYTHONUTF8: "1" },
    };
  }

  attach(link: AgentLink, proc: number): void {
    this.endWaits("插件进程已换。");
    this.link = link;
    this.proc = proc;
    this.busy = this.replayDone = this.interruptExpired = false;
    this.asks.clear();
    this.closing = undefined;
    Object.assign(this.info, { session: null, selfStarted: null, capabilities: undefined, why: undefined, retryable: undefined });
    const gate = this.gate = Promise.withResolvers<void>();
    // A plugin may fail the handshake before there is an input waiting for it.
    void gate.promise.catch(() => {});
    this.handshake = setTimeout(() => this.fail("插件握手超时。"), this.o.handshakeMs);
    const gone = () => {
      if (this.link !== link) return;
      this.link = undefined;
      this.endWaits(this.info.why ?? "插件进程已退出。");
    };
    void link.exited.then(gone, gone);
    if (this.init) {
      const init = this.init;
      this.init = undefined;
      void this.write({ type: "init", ...init }, "plugin-init").catch((err: Error) => {
        if (this.link === link) this.fail(err.message);
      });
    }
  }

  untaken(_ids: string[]): void {} // The plugin echoes the original input id in taken.

  replayed(): void {
    this.replayDone = true;
    if (this.info.capabilities) this.pendingAsks();
  }

  private pendingAsks(): void {
    this.emit({ type: "pending_asks", asks: [...this.asks.values()] });
  }

  private emit(body: Body): void {
    this.o.emit({ ...body, conv: this.conv, proc: this.proc });
  }

  private endWaits(why: string): void {
    clearTimeout(this.handshake);
    clearTimeout(this.interruptTimer);
    this.interruptTimer = undefined;
    this.gate?.reject(new Error(why));
    for (const { result } of this.requests.values()) result.reject(new Error(why));
    this.requests.clear();
  }

  redact(text: string): string {
    for (const value of Object.values(this.o.config).sort((a, b) => b.length - a.length)) if (value) text = text.replaceAll(value, "[redacted]");
    return text.slice(0, 1000);
  }

  private fail(why: string, retryable = true): void {
    this.info.why = this.redact(why);
    this.info.retryable = retryable;
    this.endWaits(this.info.why);
    if (this.link) void this.close().catch(() => {});
  }

  feed(line: Uint8Array, proc?: number, replay = false): AgentToCoreMessage | undefined {
    if ((this.closing && this.info.why !== undefined) || (proc !== undefined && proc !== this.proc)) return;
    const bad = (reason: "line_too_long" | "bad_line" | "unexpected", detail: string) => {
      if (!replay) this.emit({ type: "protocol_error", reason, detail });
      this.fail(detail);
      return undefined;
    };
    if (line.byteLength > MAX_LINE_BYTES) return bad("line_too_long", "插件输出行超过 64 MiB。");
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
    } catch {
      return bad("bad_line", "插件输出不是有效的 UTF-8 JSON。");
    }
    if (!object(value) || !str(value.type)) return bad("bad_line", "插件输出缺少消息类型。");
    const m = value;
    if (!this.info.capabilities && m.type !== "ready" && m.type !== "fatal") return bad("unexpected", "插件未完成握手就发来了消息。");
    const send = (e: Body) => { if (!replay) this.emit(e); };
    switch (m.type) {
      case "ready": {
        if (this.info.capabilities || m.proto !== 1 || !nullableString(m.session) || !optionalBool(m.selfStarted) || (m.capabilities !== undefined && !capabilities(m.capabilities))) break;
        const caps = m.capabilities ?? {};
        const manifest = this.o.plugin?.manifest;
        const declared = manifest?.kind === "agent" ? manifest.capabilities : {};
        this.info.capabilities = {
          steer: !!declared.steer && !!caps.steer,
          liveApproval: !!declared.liveApproval && !!caps.liveApproval,
          commands: caps.commands?.filter((c) => declared.commands?.includes(c)) ?? [],
          models: manifest ? caps.models : undefined,
        };
        this.info.selfStarted = m.selfStarted === true;
        this.info.session = m.session as string | null;
        clearTimeout(this.handshake);
        this.gate?.resolve();
        if (this.replayDone && !replay) this.pendingAsks();
        return m as AgentToCoreMessage;
      }
      case "fatal":
        if (!str(m.message) || !optionalBool(m.retryable)) break;
        this.fail(m.message, m.retryable !== false);
        return m as AgentToCoreMessage;
      case "session":
        if (!str(m.session)) break;
        this.info.session = m.session;
        return m as AgentToCoreMessage;
      case "taken":
        if (!str(m.inputId)) break;
        send({ type: "taken", inputId: m.inputId });
        return m as AgentToCoreMessage;
      case "turn_start":
        if (!optionalString(m.input) || !optionalString(m.session)) break;
        this.busy = true;
        if (str(m.session)) this.info.session = m.session;
        send({ type: "turn_start", ...(str(m.input) && { input: m.input }) });
        return m as AgentToCoreMessage;
      case "turn_end":
        if (!optionalString(m.reply) || !optionalString(m.session) || !optionalBool(m.background)) break;
        clearTimeout(this.interruptTimer);
        this.interruptTimer = undefined;
        this.busy = false;
        this.asks.clear();
        if (str(m.session)) this.info.session = m.session;
        send({ type: "turn_end", ...(str(m.reply) && { reply: m.reply }), ...(m.background === true && { background: true }) });
        return m as AgentToCoreMessage;
      case "text_delta":
        if (!str(m.text)) break;
        send({ type: "text_delta", text: m.text });
        return m as AgentToCoreMessage;
      case "tool_start":
        if (!str(m.id) || !str(m.name)) break;
        send({ type: "tool_start", id: m.id, name: m.name, input: m.input });
        return m as AgentToCoreMessage;
      case "item": {
        const i = m.item;
        if (!object(i)) break;
        if (i.kind === "message" && str(i.text)) send({ type: "item", item: { kind: "message", text: i.text } });
        else if (i.kind === "tool" && str(i.name) && optionalString(i.id) && (i.result === undefined || (object(i.result) && str(i.result.text) && optionalBool(i.result.error)))) {
          if (str(i.id)) for (const ask of this.asks.values()) if (ask.toolUse === i.id) this.asks.delete(ask.requestId);
          send({ type: "item", item: { kind: "tool", ...(str(i.id) && { id: i.id }), name: i.name, input: i.input } });
        } else break;
        return m as AgentToCoreMessage;
      }
      case "ask": {
        if (!str(m.requestId) || !str(m.tool) || !optionalString(m.toolUse) || !["permission", "question", "plan"].includes(String(m.kind))) break;
        const ask = { requestId: m.requestId, kind: m.kind as AgentAsk["kind"], tool: m.tool, input: m.input, ...(str(m.toolUse) && { toolUse: m.toolUse }) };
        this.asks.set(ask.requestId, ask);
        send({ type: "ask", ...ask });
        return m as AgentToCoreMessage;
      }
      case "ask_cancel":
      case "ask_resolved":
        if (!str(m.requestId)) break;
        this.asks.delete(m.requestId);
        if (m.type === "ask_cancel") send({ type: "ask_cancel", requestId: m.requestId });
        return m as AgentToCoreMessage;
      case "usage":
        if (![m.inputTokens, m.outputTokens, m.contextTokens, m.maxContextTokens].every(optionalNumber)) break;
        send({ type: "usage", ...(typeof m.inputTokens === "number" && { inputTokens: m.inputTokens }), ...(typeof m.outputTokens === "number" && { outputTokens: m.outputTokens }), ...(typeof m.contextTokens === "number" && { contextTokens: m.contextTokens }) });
        return m as AgentToCoreMessage;
      case "command_result": {
        if (!str(m.id) || typeof m.ok !== "boolean") break;
        const p = this.requests.get(m.id);
        if (!p || replay) return m as AgentToCoreMessage;
        this.requests.delete(m.id);
        if (m.ok && commandResult(p.name, m.result)) p.result.resolve(m.result);
        else p.result.reject(new Error(str(m.error) ? this.redact(m.error) : "插件命令没有返回有效结果。"));
        return m as AgentToCoreMessage;
      }
      case "error":
        if (!str(m.detail) || !optionalBool(m.recoverable)) break;
        send({ type: "protocol_error", reason: "unexpected", detail: this.redact(m.detail) });
        return m as AgentToCoreMessage;
      default:
        // Protocol v1 ignores additions it does not understand.
        return;
    }
    return bad("bad_line", "rh-agent/1 消息不符合协议。");
  }

  private write(msg: CoreToAgentMessage, id = `plugin-${this.o.boot}-${this.proc}-${++this.serial}`): Promise<void> {
    if (!this.link) return Promise.reject(new Error("插件进程未连接。"));
    return this.link.write(id, JSON.stringify(msg));
  }

  private async ready(): Promise<void> {
    if (!this.o.plugin) throw new Error(`插件 ${this.kind} 未加载。`);
    if (!this.link || !this.gate || this.closing) throw new Error(this.info.why ?? "插件进程未连接。");
    const link = this.link;
    await this.gate.promise;
    if (link !== this.link || this.closing) throw new Error(this.info.why ?? "插件进程已更换。");
  }

  async send(message: AgentMessage, mode: SendMode): Promise<void> {
    await this.ready();
    if (!this.canSend) throw new Error("插件回合正在运行，下一条消息应等到回合结束。");
    const steer = mode === "steer" || this.busy;
    this.busy = true;
    await this.write({ type: "send", ...message, mode: steer && this.info.capabilities?.steer ? "steer" : "turn" }, message.id);
  }

  async interrupt(): Promise<void> {
    await this.ready();
    if (!this.interruptTimer) this.interruptTimer = setTimeout(() => {
      this.interruptExpired = true;
      this.fail("插件中断回合超时。");
    }, this.o.interruptMs);
    await this.write({ type: "interrupt" });
  }

  async answer(requestId: string, answer: AskAnswer): Promise<void> {
    await this.ready();
    await this.write({ type: "answer", requestId, answer });
  }

  async approval(on: boolean): Promise<void> {
    await this.ready();
    if (!this.info.capabilities?.liveApproval) throw new Error("该插件不支持运行中切换审批。");
    await this.write({ type: "approval", on });
  }

  async command(name: CommonCommand, args: string): Promise<CommandResult> {
    await this.ready();
    if (!this.info.capabilities?.commands?.includes(name)) throw new Error("该 agent 不支持此命令。");
    const id = `plugin-${this.o.boot}-${this.proc}-${++this.serial}`;
    const result = Promise.withResolvers<CommandResult>();
    this.requests.set(id, { name, result });
    void this.write({ type: "command", id, name, args }, id).catch((err) => {
      if (this.requests.delete(id)) result.reject(err);
    });
    return result.promise;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    const link = this.link;
    if (!link) return Promise.resolve();
    this.endWaits("插件进程正在关闭。");
    // Both frames go to the same ordered socket. Escalation must not wait for an unresponsive plugin to read close.
    void this.write({ type: "close" }).catch(() => {});
    this.closing = closeLink(link, this.o.stopGrace);
    return this.closing;
  }
}
