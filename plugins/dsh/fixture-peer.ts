// 离线回放假对端(规格 §9.1 零 Key 演示)。
//
// fixture 每行一帧:
//   {"v":1,"dshVersion":"…","note":"…"}                                首行元数据(无 dir 字段)
//   {"dir":"out","method":"…","match?":"…","params":…}                 插件当时发出的请求(记录帧)
//   {"dir":"in","method":"…","result":…}                               dsh 的响应(记录 method 供对帧)
//   {"dir":"in","method":"…","error":{…}}                              dsh 的错误响应
//   {"dir":"in","method":"…","params":…}                               通知(session.status / session.event 等)
//   {"dir":"in","id":"srv-1","method":"approval/request","params":…}    dsh 发来的服务端请求
//
// 插件每发一个请求,假对端回样例里对应方法的下一条响应,并按顺序放出其后的通知与请求;
// session/prompt 按 `match`(最后一个文本块)对帧,让同一个进程内不同回合、以及
// 每次契约探测的全新进程都能确定性地取到各自的段落。
// 放到 dsh 发来的请求(approval/request、user-question/ask)时先暂停放帧,等插件应答后继续,
// 保持"审批 → 工具结果"的因果顺序。
//
// 样例不拉起真实 dsh:未安装 dsh、没有 DeepSeek Key 时也能跑通启动、回合、工具、审批和关闭。

import {
  dshPromptMatchKey,
  type DshInboundFrame,
  type DshTransport,
  type JsonRpcId,
  LOCKED_DSH_VERSION,
} from "./dsh-protocol";

export class FixtureFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FixtureFormatError";
  }
}

export type FixtureHeader = { v?: number; dshVersion?: string; note?: string };

export type FixtureFrame = {
  dir: "in" | "out";
  method?: string;
  match?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
  id?: JsonRpcId;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 解析样例文本:首行(无 dir 字段)是元数据,其余每行必须带 dir:"in"/"out"。 */
export function parseFixture(text: string): { header: FixtureHeader; frames: FixtureFrame[] } {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) throw new FixtureFormatError("离线样例为空");
  let header: FixtureHeader = {};
  let start = 0;
  const first: unknown = JSON.parse(lines[0]!);
  if (isObject(first) && first.dir === undefined) {
    header = first as FixtureHeader;
    start = 1;
  }
  const frames: FixtureFrame[] = [];
  for (let i = start; i < lines.length; i++) {
    let obj: unknown;
    try {
      obj = JSON.parse(lines[i]!);
    } catch (err) {
      throw new FixtureFormatError(`离线样例第 ${i + 1} 行不是合法 JSON:${(err as Error).message}`);
    }
    if (!isObject(obj) || (obj.dir !== "in" && obj.dir !== "out")) {
      throw new FixtureFormatError(`离线样例第 ${i + 1} 行缺少 dir:"in"/"out"`);
    }
    frames.push(obj as FixtureFrame);
  }
  return { header, frames };
}

/** 样例的共享状态:帧序列与回放游标(跨"重启代"持续),以及供测试观察的请求/应答记录。 */
export class FixturePeer {
  readonly header: FixtureHeader;
  readonly frames: FixtureFrame[];
  private cursor = 0;
  /** 插件发出的请求(测试观察用)。 */
  readonly requests: { method: string; params: unknown }[] = [];
  /** 插件写回 dsh 的应答(测试观察用)。 */
  readonly responses: { id: JsonRpcId; frame: unknown }[] = [];

  constructor(text: string) {
    const parsed = parseFixture(text);
    this.header = parsed.header;
    this.frames = parsed.frames;
  }

  /** 从 from 起向后找下一条匹配的出站记录帧:方法相同,且记录了 match 时须与请求的匹配键一致。 */
  findMarker(method: string, matchKey: string | undefined, from: number): number {
    for (let i = from; i < this.frames.length; i++) {
      const frame = this.frames[i]!;
      if (frame.dir !== "out" || frame.method !== method) continue;
      if (matchKey === undefined) return i;
      const recorded = typeof frame.match === "string" ? frame.match : dshPromptMatchKey(frame.params);
      if (recorded === undefined || recorded === matchKey) return i;
    }
    return -1;
  }

  /** 当前游标指向的帧(不推进)。 */
  peek(): FixtureFrame | undefined {
    return this.frames[this.cursor];
  }

  /** 取走当前游标指向的帧并推进。 */
  take(): FixtureFrame | undefined {
    const frame = this.frames[this.cursor];
    if (frame !== undefined) this.cursor++;
    return frame;
  }

  /** 把游标移到指定位置(匹配到记录帧后跳过它,从其后的 dsh 帧开始放)。 */
  skipTo(index: number): void {
    this.cursor = index;
  }

  get position(): number {
    return this.cursor;
  }
}

const REQUEST_TIMEOUT_MS = 20_000;

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

type PendingRequest = PromiseWithResolvers<unknown>;

/** 一代"dsh 进程"的离线回放传输:中断/重启后由插件重新创建,底层样例与游标共享。 */
export class FixtureTransport implements DshTransport {
  private readonly peer: FixturePeer;
  private readonly pending = new Map<number, PendingRequest>();
  private nextRequestId = 1;
  private inboundHandler: ((frame: DshInboundFrame) => void) | null = null;
  private generationAlive = true;
  /** 正在等待插件应答的服务端请求(放帧暂停在这里)。 */
  private paused: { frame: FixtureFrame; pending: PendingRequest } | null = null;
  readonly dshVersion: string;

  constructor(peer: FixturePeer) {
    this.peer = peer;
    this.dshVersion = peer.header.dshVersion ?? LOCKED_DSH_VERSION;
  }

  get alive(): boolean {
    return this.generationAlive;
  }

  onInbound(handler: (frame: DshInboundFrame) => void): void {
    this.inboundHandler = handler;
  }

  onStderrLine(_handler: (line: string) => void): void {
    // 回放模式没有下游进程,没有 stderr 可转。
  }

  onExited(_handler: (reason: string) => void): void {
    // 回放对端的"退出"由 kill 显式触发,走中断路径,不经意外退出回调。
  }

  request(method: string, params: unknown, timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (!this.generationAlive) return Promise.reject(new Error(`对端已退出,无法发送 ${method}`));
    const id = this.nextRequestId++;
    const pending: PendingRequest = Promise.withResolvers();
    this.pending.set(id, pending);
    this.peer.requests.push({ method, params });
    const matchKey = dshPromptMatchKey(params);
    const markerAt = this.peer.findMarker(method, matchKey, this.peer.position);
    if (markerAt < 0) {
      this.pending.delete(id);
      return Promise.reject(
        new Error(`离线样例中没有 ${method}${matchKey === undefined ? "" : `(匹配 ${JSON.stringify(matchKey)})`} 的下一帧响应`),
      );
    }
    this.peer.skipTo(markerAt + 1); // 跳过记录帧本身,从其后的 dsh 帧开始放
    void this.playSection(pending);
    return withTimeout(pending.promise, timeoutMs, `等待离线样例的 ${method} 响应`);
  }

  /** 放出当前记录帧之后、下一条 out 记录帧之前的所有 dsh 帧;响应帧兑现请求,服务端请求暂停放帧。 */
  private async playSection(pending: PendingRequest): Promise<void> {
    for (;;) {
      if (!this.generationAlive) return;
      const frame = this.peer.peek();
      if (frame === undefined || frame.dir === "out") return; // 段落放完,后续帧留给下一个请求
      this.peer.take();
      if (frame.dir !== "in") continue;
      if (frame.result !== undefined || frame.error !== undefined) {
        // 响应帧:兑现(或拒绝)当前请求;让出一个宏任务,保证请求方的续延
        // (send 的 taken/session、命令的 command_result 等)先于后续通知帧执行。
        if (frame.error !== undefined) {
          pending.reject(new Error(`dsh 回放错误响应:${frame.error.message ?? JSON.stringify(frame.error)}`));
        } else {
          pending.resolve(frame.result);
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        continue;
      }
      if (frame.method === undefined) continue;
      if (frame.id !== undefined) {
        // dsh 发来的服务端请求:先暂停放帧,等插件应答后继续。
        this.paused = { frame, pending };
        this.inboundHandler?.({ id: frame.id, method: frame.method, params: frame.params });
        return;
      }
      this.inboundHandler?.({ method: frame.method, params: frame.params });
    }
  }

  respond(id: JsonRpcId, result: unknown): void {
    this.peer.responses.push({ id, frame: result });
    this.resumeIfPaused(id);
  }

  respondError(id: JsonRpcId, error: { code: number; message: string }): void {
    this.peer.responses.push({ id, frame: { error } });
    this.resumeIfPaused(id);
  }

  private resumeIfPaused(id: JsonRpcId): void {
    const paused = this.paused;
    if (!paused || !this.generationAlive) return;
    if (String(paused.frame.id) !== String(id)) return;
    this.paused = null;
    void this.playSection(paused.pending);
  }

  /** 中断:立即"退出",等待中的请求全部失败;等待插件应答的段落一并放弃。 */
  async kill(): Promise<void> {
    this.generationAlive = false;
    this.paused = null;
    for (const waiting of this.pending.values()) {
      waiting.reject(new Error("dsh 对端已被中断终止"));
    }
    this.pending.clear();
  }

  /** 关闭:回放模式没有真实进程,直接标记退出。 */
  async dispose(): Promise<void> {
    await this.kill();
  }
}
