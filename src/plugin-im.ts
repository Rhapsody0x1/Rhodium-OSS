// One rh-im/1 peer per bot. The daemon acknowledges inbound only after its transaction commits.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readJsonLines, validateImCapabilities, writeJsonLine, type ImInboundMessage, type JsonRpcId } from "@rhodium-oss/plugin-sdk";
import type { Capabilities, Connected, ImAdapter, InboundMessage, Kept, MenuItem, OutboundMessage, Profile, RowButton, SendResult } from "./contracts";
import type { LoadedPlugin } from "./plugin-loader";

type Options = {
  id: string; name: string; plugin: LoadedPlugin; config: Record<string, string>; env: Record<string, string>;
  kept: Kept; handshakeMs: number; rpcMs: number; stopGrace: number; botFailures: number;
};
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string";
const optionalString = (v: unknown) => v === undefined || str(v);
const idOf = (v: unknown): v is JsonRpcId => str(v) || typeof v === "number";

function inbound(v: unknown): v is ImInboundMessage {
  return object(v) && str(v.chat) && !!v.chat && str(v.sender) && !!v.sender && str(v.messageId) && !!v.messageId
    && str(v.text) && typeof v.at === "number" && Number.isFinite(v.at) && optionalString(v.ref)
    && (v.quote === undefined || (object(v.quote) && str(v.quote.ref) && optionalString(v.quote.text) && optionalString(v.quote.fallback) && (v.quote.picked === undefined || v.quote.picked === true)))
    && (v.button === undefined || (object(v.button) && str(v.button.message) && str(v.button.data) && optionalString(v.button.text)))
    && (v.voice === undefined || v.voice === true)
    && (v.attachments === undefined || (Array.isArray(v.attachments) && v.attachments.every(a => object(a) && str(a.id)
      && (a.kind === "file" || a.kind === "image") && optionalString(a.name) && optionalString(a.mimeType))));
}

class Peer {
  readonly process: ChildProcessWithoutNullStreams;
  readonly exited: Promise<void>;
  private serial = 0;
  private pending = new Map<JsonRpcId, PromiseWithResolvers<unknown>>();
  readonly handshake = Promise.withResolvers<boolean>();
  ready = false;
  reason = "";
  constructor(o: Options) {
    const [program, ...args] = o.plugin.command;
    const child = this.process = spawn(program!, args, { cwd: o.plugin.dir, windowsHide: true,
      env: { ...o.env, RHODIUM_PLUGIN_DIR: o.plugin.dir, PYTHONUTF8: "1" }, stdio: "pipe" });
    child.stdin.on("error", () => this.kill());
    child.stderr.resume(); // A plugin can log platform credentials. Only protocol errors are reported.
    child.once("error", () => { this.reason = "无法启动 IM 插件进程。"; });
    this.exited = new Promise(resolve => child.once("close", (code, signal) => {
      this.ready = false;
      this.reason ||= `IM 插件进程已退出（${signal ?? code}）。`;
      for (const reply of this.pending.values()) reply.reject(new Error(this.reason));
      this.pending.clear();
      resolve();
    }));
  }

  write(frame: object): void { writeJsonLine(this.process.stdin, { jsonrpc: "2.0", ...frame }); }

  async request(method: string, params: unknown, ms: number): Promise<unknown> {
    const id = ++this.serial;
    const reply = Promise.withResolvers<unknown>();
    this.pending.set(id, reply);
    const timer = setTimeout(() => reply.reject(new Error(`IM 插件 ${method} 超时。`)), ms);
    try {
      this.write({ id, method, params });
      return await reply.promise;
    } finally {
      clearTimeout(timer);
      this.pending.delete(id);
    }
  }

  receive(m: Record<string, unknown>): void {
    if (!idOf(m.id)) throw new Error("IM 插件响应缺少 id。");
    const reply = this.pending.get(m.id);
    if (!reply) return; // A late response to a timed-out send never triggers a second send.
    if ("result" in m) reply.resolve(m.result);
    else reply.reject(new Error(object(m.error) && str(m.error.message) ? m.error.message : "IM 插件 RPC 响应无效。"));
  }

  kill(): void { this.process.kill("SIGKILL"); }

  async close(ms: number): Promise<void> {
    const kill = setTimeout(() => this.kill(), ms);
    try {
      if (this.process.exitCode === null && !this.process.killed) {
        await this.request("shutdown", {}, ms).catch(() => {});
        this.process.stdin.end();
      }
      await this.exited;
    } finally { clearTimeout(kill); }
  }
}

export class PluginImAdapter implements ImAdapter {
  readonly pluginId: string;
  capabilities: Capabilities;
  faulted = false;
  initFailed = false;
  private peer?: Peer;
  private stop = new AbortController();
  private running?: Promise<void>;
  private ready = Promise.withResolvers<Peer | null>();

  constructor(private readonly o: Options) {
    if (o.plugin.manifest.kind !== "im") throw new Error("expected an IM plugin");
    this.pluginId = o.plugin.id;
    this.capabilities = o.plugin.manifest.capabilities;
  }

  get pid(): number | null { return this.peer?.process.pid ?? null; }

  private reason(err: unknown): string {
    let text = err instanceof Error ? err.message : String(err);
    for (const value of Object.values(this.o.config).sort((a, b) => b.length - a.length)) if (value) text = text.replaceAll(value, "[redacted]");
    return text.slice(0, 500);
  }

  messages(connected: Connected = () => {}, signal?: AbortSignal): AsyncIterable<InboundMessage> {
    const abort = () => this.stop.abort();
    let cancelled = false;
    return new ReadableStream<InboundMessage>({
      start: out => {
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        this.running = this.supervise(connected, m => out.enqueue(m)).finally(() => {
          signal?.removeEventListener("abort", abort);
          if (!cancelled) out.close();
        });
      },
      cancel: () => { cancelled = true; return this.shutdown(); },
    });
  }

  shutdown(): Promise<void> {
    this.stop.abort();
    this.ready.resolve(null);
    return this.running ?? Promise.resolve();
  }

  private async supervise(connected: Connected, push: (m: InboundMessage) => void): Promise<void> {
    const { signal } = this.stop;
    let failures = 0;
    while (!signal.aborted && !this.faulted) {
      let peer: Peer | undefined;
      let reportedDown = false;
      const status = (up: boolean, error?: string) => {
        if (signal.aborted || this.faulted) return;
        failures = up ? 0 : failures + 1;
        this.faulted = this.o.botFailures > 0 && failures >= this.o.botFailures;
        reportedDown = !up;
        connected(up, error === undefined ? undefined : this.reason(error));
        if (this.faulted) peer?.kill();
      };
      try {
        peer = this.peer = new Peer(this.o);
        await this.run(peer, status, connected, push);
        if (!reportedDown) status(false, peer.reason);
      } catch (err) {
        this.initFailed = this.faulted = true;
        connected(false, this.reason(err));
      } finally {
        this.peer = undefined;
        this.ready.resolve(null);
      }
      if (!this.faulted && !signal.aborted) {
        this.ready = Promise.withResolvers();
        await delay(Math.min(30_000, 1_000 * 2 ** Math.max(0, failures - 1)), undefined, { signal }).catch(() => {});
      }
    }
    this.ready.resolve(null);
  }

  private async run(p: Peer, status: Connected, connected: Connected, push: (m: InboundMessage) => void): Promise<void> {
    const abort = () => { void p.close(this.o.stopGrace); };
    this.stop.signal.addEventListener("abort", abort, { once: true });
    try {
      const bad = () => { p.reason ||= "IM 插件输出不是有效的 rh-im/1 消息。"; p.kill(); };
      void readJsonLines(p.process.stdout, { onMessage: m => this.receive(p, m, status, push), onError: bad }).then(() => p.kill(), bad);
      try {
        const r = await p.request("init", { proto: 1, botId: this.o.id, botName: this.o.name, config: this.o.config }, this.o.handshakeMs);
        if (!object(r) || r.proto !== 1) throw new Error("IM 插件协议版本无效。");
        const checked = validateImCapabilities(r.capabilities);
        if (!checked.ok) throw new Error(checked.error);
        this.capabilities = checked.capabilities;
        p.ready = true;
        p.handshake.resolve(true);
        this.ready.resolve(p);
      } catch (err) {
        p.handshake.resolve(false);
        if (!this.stop.signal.aborted) {
          this.initFailed = this.faulted = true;
          connected(false, this.reason(err));
        }
        p.kill();
      }
      await p.exited;
    } finally { this.stop.signal.removeEventListener("abort", abort); }
  }

  private async receive(p: Peer, m: unknown, status: Connected, push: (m: InboundMessage) => void): Promise<void> {
    if (!object(m) || m.jsonrpc !== "2.0") throw new Error("IM 插件 RPC 帧无效。");
    if (!("method" in m)) return p.receive(m);
    const params = m.params;
    if (m.method === "connected") {
      if (!object(params) || typeof params.up !== "boolean" || !optionalString(params.error)) throw new Error("IM 插件连接通知无效。");
      if (await p.handshake.promise && this.peer === p) status(params.up, params.error as string | undefined);
      return;
    }
    if (!idOf(m.id)) return;
    try {
      if (m.method === "inbound") {
        if (!(await p.handshake.promise) || !p.ready || this.stop.signal.aborted) throw new Error("IM 插件未就绪。");
        if (!inbound(params)) throw new Error("IM 插件入站消息无效。");
        this.incoming(p, m.id, params, push);
      } else if ((m.method === "kept_get" || m.method === "kept_set") && object(params) && str(params.key)) {
        const key = `plugin:${this.o.id}:${params.key}`;
        if (m.method === "kept_get") p.write({ id: m.id, result: { value: this.o.kept.get(key) ?? null } });
        else if (str(params.value) || params.value === null) {
          this.o.kept.set(key, params.value ?? undefined);
          p.write({ id: m.id, result: { ok: true } });
        } else throw new Error("kept_set value 无效。");
      } else throw new Error("IM 插件请求无效。");
    } catch (err) {
      p.write({ id: m.id, error: { code: -32000, message: this.reason(err) } });
    }
  }

  private async fetch(p: Peer, attachmentId: string): Promise<Uint8Array> {
    if (!p.ready) throw new Error("IM 插件已断开。");
    const dir = await mkdtemp(join(tmpdir(), "rhodium-im-"));
    try {
      const destPath = join(dir, "attachment");
      const r = await p.request("fetch_attachment", { attachmentId, destPath }, this.o.rpcMs);
      if (!object(r) || r.ok !== true || typeof r.size !== "number") throw new Error("IM 插件附件回执无效。");
      const data = await readFile(destPath);
      if (data.length !== r.size) throw new Error("IM 插件附件大小不符。");
      return data;
    } catch (err) {
      throw new Error(this.reason(err));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private incoming(p: Peer, id: JsonRpcId, msg: ImInboundMessage, push: (m: InboundMessage) => void): void {
    const { attachments, ...fields } = msg;
    push({
      ...fields, bot: this.o.id,
      attachments: attachments?.map(a => ({ kind: a.kind, name: a.name, mimeType: a.mimeType, fetch: () => this.fetch(p, a.id) })),
      acknowledge: err => {
        if (!p.ready || this.stop.signal.aborted) return;
        try { p.write(err ? { id, error: { code: -32000, message: "入站事务失败。" } } : { id, result: { ok: true } }); }
        catch { p.kill(); } // The committed input will be deduplicated when the peer reconnects.
      },
    });
  }

  private async online(): Promise<Peer> {
    if (this.peer?.ready && !this.stop.signal.aborted) return this.peer;
    const timer = Promise.withResolvers<null>();
    const timeout = setTimeout(() => timer.resolve(null), this.o.handshakeMs);
    try {
      const p = await Promise.race([this.ready.promise, timer.promise]);
      if (!p?.ready || this.stop.signal.aborted) throw new Error("IM 插件未连接。");
      return p;
    } finally { clearTimeout(timeout); }
  }

  private async sendResult(method: string, params: object): Promise<SendResult> {
    let p: Peer;
    try { p = await this.online(); }
    catch (err) { return { status: "failed", error: this.reason(err) }; }
    try {
      if (method === "edit" && this.capabilities.progress !== "edit" && !this.capabilities.stream) return { status: "failed", error: "IM 插件不支持编辑。" };
      if (method === "drop_buttons" && !this.capabilities.buttons) return { status: "failed", error: "IM 插件不支持按钮。" };
      const r = await p.request(method, params, this.o.rpcMs);
      if (!object(r)) throw new Error("IM 插件发送回执无效。");
      if (r.status === "sent" && optionalString(r.messageId) && optionalString(r.ref)) return r as SendResult;
      if ((r.status === "failed" || r.status === "unknown") && str(r.error)) {
        return { status: r.status, error: this.reason(r.error), ...(r.status === "failed" && {
          ...(r.refused === true && { refused: true }), ...(r.flood === true && { flood: true }), ...(r.quota === true && { quota: true }),
        }) };
      }
      throw new Error("IM 插件发送回执无效。");
    } catch (err) { return { status: "unknown", error: this.reason(err) }; }
  }

  send(chat: string, message: OutboundMessage) { return this.sendResult("send", { chat, message }); }
  edit(chat: string, messageId: string, message: OutboundMessage) { return this.sendResult("edit", { chat, messageId, message }); }
  dropButtons(chat: string, messageId: string) { return this.sendResult("drop_buttons", { chat, messageId }); }

  private async control(method: string, params: object, enabled: (caps: Capabilities) => boolean): Promise<void> {
    const p = await this.online();
    if (!enabled(this.capabilities)) return;
    const r = await p.request(method, params, this.o.rpcMs).catch(err => { throw new Error(this.reason(err)); });
    if (!object(r) || r.ok !== true) throw new Error("IM 插件操作回执无效。");
  }
  answerPress(chat: string, press: string, text: string) { return this.control("answer_press", { chat, press, text }, c => !!c.buttons); }
  setMenu(items: MenuItem[], chat?: string) { return this.control("set_menu", { items, chat }, c => c.menu.maxItems > 0); }
  setRow(row: RowButton[], chat?: string) { return this.control("set_row", { row, chat }, c => !!c.menu.row); }

  async profile(you: string | null): Promise<Profile> {
    try {
      const r = await (await this.online()).request("profile", { you }, this.o.rpcMs);
      if (object(r)) return {
        ...(str(r.botBase64) && { bot: Buffer.from(r.botBase64, "base64") }),
        ...(str(r.youBase64) && { you: Buffer.from(r.youBase64, "base64") }), ...(str(r.name) && { name: r.name }),
      };
    } catch {}
    return {};
  }
}
