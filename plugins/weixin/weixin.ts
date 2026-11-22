import { randomUUID } from "node:crypto";
import type { Capabilities, ImContext, ImInboundMessage, ImInitParams, ImPlugin, OutboundMessageWire, SendResult } from "../../packages/plugin-sdk";
import { defaultBase, defaultCdn, HttpError, ILink, type Incoming, type Item, replyCode, type Reply, serviceUrl, type Updates } from "./api";
import { type Attachment, download, upload } from "./media";
import manifest from "./plugin.json";
import { wizard } from "./wizard";

type Session = { api: ILink; cdn: string };
const capabilities = manifest.capabilities as Capabilities;

export class Weixin implements ImPlugin {
  private readonly stop = new AbortController();
  private readonly contexts = new Map<string, string>();
  private readonly attachments = new Map<string, Attachment>();
  private session?: Session;
  private polling?: Promise<void>;
  private online = false;
  readonly wizard = wizard;

  async init({ config }: ImInitParams, ctx: ImContext) {
    if (this.session) throw new Error("Weixin adapter already initialized");
    if (!config.token) throw new Error("Weixin Bot token required");
    const base = serviceUrl(config.baseUrl || defaultBase).href;
    const cdn = serviceUrl(config.cdnBaseUrl || defaultCdn).href;
    const api = new ILink(base, config.token, this.stop.signal);
    this.session = { api, cdn };
    this.polling = this.poll(api, ctx);
    return capabilities;
  }

  private async poll(api: ILink, ctx: ImContext) {
    let cursor: string | undefined;
    let timeout = 35_000, retry = 1_000;
    const signal = api.signal;
    while (!signal.aborted) {
      try {
        cursor ??= await ctx.keptGet("sync_buf") ?? "";
        const updates = await api.post<Updates>("getupdates", { get_updates_buf: cursor }, timeout + 3_000);
        if (updates.ret === -14 || updates.errcode === -14) {
          ctx.connected(false, "微信登录态已过期，请重新扫码更新 token");
          return;
        }
        if (replyCode(updates)) throw new Error("Weixin rejected updates");
        for (const msg of updates.msgs ?? []) await this.inbound(msg, ctx);
        const next = updates.get_updates_buf;
        if (typeof next === "string" && next && next !== cursor) {
          await ctx.keptSet("sync_buf", next);
          cursor = next;
        }
        if (!this.online) {
          this.online = true;
          ctx.connected(true);
        }
        if (Number.isFinite(updates.longpolling_timeout_ms)) {
          timeout = Math.min(60_000, Math.max(1_000, updates.longpolling_timeout_ms!));
        }
        retry = 1_000;
        if (!updates.msgs?.length) await Bun.sleep(100);
      } catch {
        if (signal.aborted) break;
        this.online = false;
        ctx.connected(false, "微信消息同步失败，正在重试");
        await new Promise<void>(resolve => {
          const done = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            resolve();
          };
          const timer = setTimeout(done, retry);
          signal.addEventListener("abort", done, { once: true });
        });
        retry = Math.min(retry * 2, 15_000);
      }
    }
  }

  private async inbound(msg: Incoming, ctx: ImContext) {
    const sender = msg.from_user_id;
    if (!sender || msg.group_id || msg.message_type !== 1 ||
        (msg.message_state !== undefined && msg.message_state !== 2)) return;
    const messageId = msg.message_id ? String(msg.message_id) : msg.client_id || (msg.seq ? `seq:${msg.seq}` : "");
    if (!messageId) throw new Error("Weixin user message has no stable ID");
    if (msg.context_token) {
      await ctx.keptSet(`ctx:${sender}`, msg.context_token);
      this.contexts.set(sender, msg.context_token);
    }
    const input: ImInboundMessage = { chat: sender, sender, messageId, text: "", at: msg.create_time_ms || Date.now() };
    const text: string[] = [];
    for (const [index, item] of (msg.item_list ?? []).entries()) {
      if (item.type === 1 && item.text_item?.text) text.push(item.text_item.text);
      if (item.type === 3) {
        if (item.voice_item?.text) text.push(item.voice_item.text);
        else input.voice = true;
      }
      const reference = item.ref_msg;
      const referenceText = reference?.message_item?.text_item?.text || reference?.title;
      if (!input.quote && reference) {
        input.quote = {
          ref: reference.message_item?.msg_id || `${messageId}:quote`,
          ...(referenceText && { text: referenceText }),
        };
      }
      const media = item.image_item?.media ?? item.file_item?.media ?? item.video_item?.media;
      if (media?.full_url || media?.encrypt_query_param) {
        const kind = item.image_item ? "image" : "file";
        const id = `${sender}:${messageId}:${index}`;
        const name = item.file_item?.file_name ?? (item.video_item ? "video.mp4" : undefined);
        this.attachments.set(id, { media, key: item.image_item?.aeskey, kind });
        (input.attachments ??= []).push({ id, kind, ...(name && { name }) });
      }
    }
    while (this.attachments.size > 1024) this.attachments.delete(this.attachments.keys().next().value!);
    input.text = text.join("\n");
    await ctx.inbound(input);
  }

  async send(chat: string, message: OutboundMessageWire, ctx: ImContext): Promise<SendResult> {
    const session = this.session;
    if (!session) return { status: "failed", error: "Weixin adapter not initialized" };
    let context: string | null;
    try {
      context = this.contexts.get(chat) ?? await ctx.keptGet(`ctx:${chat}`);
    } catch {
      return { status: "failed", error: "无法读取微信会话上下文" };
    }
    if (!context) return { status: "failed", error: "缺少 context_token，请先在微信向 Bot 发送一条消息" };
    const items: Item[] = [];
    if (message.text) items.push({ type: 1, text_item: { text: message.text } });
    if (message.file) {
      try {
        items.push(await upload(session.api, session.cdn, chat, message.file));
      } catch {
        return { status: "failed", error: "微信附件上传失败，消息尚未发送" };
      }
    }
    if (items.length === 0) return { status: "failed", error: "微信消息为空" };
    let lastId: string | undefined;
    for (const item of items) {
      const id = randomUUID();
      try {
        const reply = await session.api.post<Reply>("sendmessage", { msg: {
          from_user_id: "", to_user_id: chat, client_id: id, message_type: 2, message_state: 2,
          context_token: context, item_list: [item],
        } }, 20_000);
        if (replyCode(reply)) {
          return { status: lastId ? "unknown" : "failed", error: "微信拒收消息" };
        }
        if (reply.ret !== 0 && reply.errcode !== 0) return { status: "unknown", error: "微信发送回执缺失" };
      } catch (error) {
        const rejected = error instanceof HttpError && error.status >= 400 && error.status < 500;
        return { status: rejected && !lastId ? "failed" : "unknown",
          error: rejected ? "微信拒收消息" : "微信发送回执缺失" };
      }
      lastId = id;
    }
    return { status: "sent", messageId: lastId };
  }

  async fetchAttachment(id: string, dest: string) {
    const attachment = this.attachments.get(id);
    if (!this.session || !attachment) throw new Error("Unknown Weixin attachment");
    try {
      return await download(this.session.cdn, attachment, dest, this.stop.signal);
    } catch {
      throw new Error("Weixin attachment download failed");
    }
  }

  async profile() { return {}; }

  async shutdown() {
    this.stop.abort();
    await this.polling;
  }
}
