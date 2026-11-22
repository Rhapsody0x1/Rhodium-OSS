// dsh(DeepSeek Harness)SDK JSON-RPC 2.0 协议定义 —— 插件化规格 §9.1。
//
// dsh 处于开发者预览阶段,协议不保证跨版本兼容:本插件锁定 LOCKED_DSH_VERSION,
// 升级 dsh 时须用真实 `dsh sdk` 重录 fixtures/sample.jsonl,并在同一个 PR 里更新这里的锁定版本。

/** 锁定的 dsh 版本:实测可跑的 npm 最新稳定版 0.2.2-rc.5(2026-11-22)。
 *  上游 git 标签 dsh-v0.2.3-alpha.1 的 npm 发布包本身损坏(其依赖 @deepseek-ai/cordis-plugin-loader
 *  1.1.0 缺少 dsh-app-boot 引用的导出,启动即报错),故锁定 0.2.2-rc.5。
 *  真实模式下与 `dsh --version` 严格比对;升级 dsh 时须重录 fixtures/sample.jsonl 并在此同 PR 更新。 */
export const LOCKED_DSH_VERSION = "0.2.2-rc.5";

/** initialize 结果里 serverInfo.name 必须是这个值,否则判定对端不是 dsh SDK 运行时。 */
export const SDK_SERVER_NAME = "deepseek-harness-sdk-runtime";

/** dsh 缺省的提供方(它唯一会自动挂适配器的提供方)。 */
export const DEFAULT_PROVIDER = "deepseek-official";

/** JSON-RPC id:dsh 发来的服务端请求可能用字符串 id。 */
export type JsonRpcId = string | number;

/** dsh 的 content block:文本或图片(base64 data)。 */
export type DshContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/** `initialize` 请求参数(§9.1 启动与握手)。 */
export type DshInitializeParams = {
  cwd: string;
  provider: string;
  model: string;
  reasoningEffort?: string;
  approvalRequests: true;
  capabilities: { userQuestions: true };
};

export type DshServerInfo = { name?: string; version?: string };

/** `session.status` 通知载荷。 */
export type DshSessionStatusParams = { sessionId?: string; status?: string };

/** `session.event` 通知载荷(0.2.2-rc.5 实测):具体内容在 `event.data` 里;不认识的 type 直接略过。 */
export type DshSessionEventParams = {
  sessionId?: string;
  event?: {
    type?: string;
    /** 事件序号(dsh 按序推送,本插件按到达顺序处理)。 */
    seq?: number;
    /** 事件主体。 */
    data?: DshEventData;
  };
};

/** `session.event` 的 data 字段(尽量宽容:兼容顶层形状,便于跨小版本解析)。 */
export type DshEventData = {
  /** tool/call:调用 ID。 */
  callId?: string;
  /** tool/call:工具名(实测字段名是 name;toolName 为规格留档的别名)。 */
  name?: string;
  toolName?: string;
  /** tool/call:参数 JSON 字符串(实测为字符串化 JSON)。 */
  arguments?: string;
  input?: unknown;
  text?: string;
  isError?: boolean;
  /** assistant/message 与 tool/result 的消息体。 */
  message?: {
    role?: string;
    /** tool/result:对应调用的 ID。 */
    toolCallId?: string;
    isError?: boolean;
    /** 消息内容块:text / reasoning / tool-call 等。 */
    content?: { type?: string; text?: string }[];
    source?: { callId?: string };
  };
  /** 兼容旧形状:顶层文本块列表。 */
  blocks?: DshContentBlock[];
};

/** `approval/request` 服务端请求参数。 */
export type DshApprovalParams = { toolName?: string; callId?: string; reason?: string };

/** 提问选项(0.2.2-rc.5 实测):没有 id,只有标签与说明。 */
export type DshQuestionOption = { label?: string; description?: string };
export type DshQuestion = {
  id?: string;
  question?: string;
  /** 短标题(看板/终端显示用)。 */
  header?: string;
  options?: DshQuestionOption[];
  /** 是否允许多选(应答时 selected 为标签数组)。 */
  multiSelect?: boolean;
};

/** `user-question/ask` 服务端请求参数。 */
export type DshUserQuestionParams = { requestId?: string; questions?: DshQuestion[] };

// ---------------------------------------------------------------------------
// 插件 ↔ dsh 的 JSON-RPC 帧类型
// ---------------------------------------------------------------------------

/** 插件写给 dsh 的出站帧:请求、对服务端请求的应答,或应答错误。 */
export type DshOutboundFrame =
  | { jsonrpc: "2.0"; id: JsonRpcId; method: string; params: unknown }
  | { jsonrpc: "2.0"; id: JsonRpcId; result: unknown }
  | { jsonrpc: "2.0"; id: JsonRpcId; error: { code: number; message: string } };

/** dsh 写给插件的入站帧(响应帧按 id 由传输层内部消化,这里只指通知与服务端请求)。 */
export type DshInboundFrame =
  | { method: string; params: unknown }
  | { id: JsonRpcId; method: string; params: unknown };

/** 传输层抽象:真实 dsh 子进程(dsh-runtime.ts)与离线回放假对端(fixture-peer.ts)共用。 */
export interface DshTransport {
  /** 本代传输是否还活着(中断/关闭后为 false,由插件重新拉起)。 */
  readonly alive: boolean;
  /** 对端 dsh 版本(真实模式来自 `dsh --version`,回放模式来自样例首行)。 */
  readonly dshVersion: string;
  /** 发一个 JSON-RPC 请求并等待响应;响应为 error 或对端中断时 reject。 */
  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
  /** 应答 dsh 发来的服务端请求;对端已退出或写入失败时返回 false(§3.2:交付失败不得确认)。 */
  respond(id: JsonRpcId, result: unknown): boolean;
  /** 以错误应答 dsh 发来的服务端请求。 */
  respondError(id: JsonRpcId, error: { code: number; message: string }): void;
  /** 注册入站帧(通知与服务端请求)处理器。 */
  onInbound(handler: (frame: DshInboundFrame) => void): void;
  /** 注册 dsh stderr 行处理器(插件把它转进自己的 stderr)。 */
  onStderrLine(handler: (line: string) => void): void;
  /** 注册进程退出回调(真实模式:dsh 意外死亡时用于让当前回合以可重试失败收场)。 */
  onExited?(handler: (reason: string) => void): void;
  /** 中断:停掉当前 dsh(SIGTERM → 2s → 强杀),等待中的请求全部 reject。 */
  kill(): Promise<void>;
  /** 关闭:发 shutdown → 关 stdin → 等退出 → 必要时强杀。 */
  dispose(): Promise<void>;
}

// ---------------------------------------------------------------------------
// 解析辅助(对预览期协议形状保持宽容)
// ---------------------------------------------------------------------------

/** 提取 assistant/message 事件的正文:data.message.content 里 type==="text" 的块拼接
 *  (跳过 reasoning、tool-call 块);兼容顶层 blocks/text 的旧形状。 */
export function dshAssistantText(data: DshEventData): string {
  const content = data.message?.content;
  if (Array.isArray(content)) {
    const joined = content
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("");
    if (joined) return joined;
    // 只有 reasoning/tool-call 块的中间消息没有可见正文
    if (content.length > 0) return "";
  }
  const blocks = Array.isArray(data.blocks) ? data.blocks : [];
  const fromBlocks = blocks
    .filter((b): b is { type: "text"; text: string } => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
  if (fromBlocks) return fromBlocks;
  return typeof data.text === "string" ? data.text : "";
}

/** 提取 tool/call 的参数:data.input 优先;实测的 arguments 是 JSON 字符串,解析失败时原样包一层。 */
export function dshToolCallInput(data: DshEventData): unknown {
  if (data.input !== undefined) return data.input;
  if (typeof data.arguments === "string") {
    try {
      return JSON.parse(data.arguments);
    } catch {
      return { raw: data.arguments };
    }
  }
  return null;
}

/** 提取 tool/result 的调用 ID:data.message.toolCallId → source.callId → data.callId。 */
export function dshToolResultCallId(data: DshEventData): string | undefined {
  return data.message?.toolCallId ?? data.message?.source?.callId ?? data.callId;
}

/** 提取 tool/result 的结果文本:data.message.content 的文本块拼接;兼容顶层 text。 */
export function dshToolResultText(data: DshEventData): string {
  const content = data.message?.content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("");
  }
  return typeof data.text === "string" ? data.text : "";
}

/** 提取 tool/result 的失败标记:data.message.isError → data.isError。 */
export function dshToolResultError(data: DshEventData): boolean {
  return data.message?.isError === true || data.isError === true;
}

/** session/prompt 的匹配键:contentBlocks 里最后一个非空文本块(离线回放按它对帧)。 */
export function dshPromptMatchKey(params: unknown): string | undefined {
  const blocks = (params as { contentBlocks?: unknown } | null | undefined)?.contentBlocks;
  if (!Array.isArray(blocks)) return undefined;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i] as { type?: unknown; text?: unknown } | undefined;
    if (block?.type === "text" && typeof block.text === "string" && block.text.length > 0) return block.text;
  }
  return undefined;
}

/** 解析 `dsh --version` 输出里的版本号(取第一个 semver 形态的记号,容忍 v 前缀)。 */
export function parseDshVersionOutput(output: string): string | null {
  const m = /v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)/.exec(output);
  return m ? m[1]! : null;
}

/** 把核心 send 的文本与图片转成 dsh 的 contentBlocks。 */
export function toContentBlocks(text: string, images?: { mimeType: string; data: string }[]): DshContentBlock[] {
  const blocks: DshContentBlock[] = [{ type: "text", text }];
  for (const image of images ?? []) blocks.push({ type: "image", data: image.data, mimeType: image.mimeType });
  return blocks;
}
