import {
  PluginSendFailedError, runImPlugin, type Capabilities, type ImContext, type ImInitParams,
  type FetchAttachmentResult, type ImPlugin, type ImInboundMessage, type ImWizardContext, type ImWizardDone, type ImWizardParams,
  type MenuItem, type OutboundMessageWire, type SendResult,
} from "@rhodium-oss/plugin-sdk";
import manifest from "./plugin.json";

type LocalUpdate = Omit<ImInboundMessage, "chat"> & { channel: string };
type Batch = { nextCursor: string; messages: LocalUpdate[] };

class LocalImPlugin implements ImPlugin {
  private seq = 1;
  private endpoint?: URL;
  private stop = new AbortController();

  async init(params: ImInitParams, ctx: ImContext): Promise<Capabilities> {
    if (params.config.endpoint) {
      const endpoint = new URL(params.config.endpoint);
      if (endpoint.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(endpoint.hostname)) {
        throw new Error("local-im endpoint must be an HTTP loopback address");
      }
      this.endpoint = endpoint;
      void this.poll(ctx);
    } else ctx.connected(true);
    return manifest.capabilities as Capabilities;
  }

  private async call(path: string, body?: object): Promise<Response> {
    const response = await fetch(new URL(path, this.endpoint), {
      method: body ? "POST" : "GET", signal: this.stop.signal, redirect: "error",
      ...(body && { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
    });
    if (!response.ok) throw new Error(`Local platform returned HTTP ${response.status}`);
    return response;
  }

  private async poll(ctx: ImContext): Promise<void> {
    let online = false;
    while (!this.stop.signal.aborted) {
      try {
        const cursor = await ctx.keptGet("sync_buf") ?? "";
        const batch: Batch = await (await this.call("/updates?cursor=" + encodeURIComponent(cursor))).json();
        if (!online) ctx.connected(true);
        online = true;
        for (const { channel, ...message } of batch.messages) {
          await ctx.keptSet("dm:" + message.sender, channel);
          await ctx.inbound({ ...message, chat: message.sender });
        }
        if (batch.nextCursor !== cursor) await ctx.keptSet("sync_buf", batch.nextCursor);
        if (!batch.messages.length) await Bun.sleep(100);
      } catch (err) {
        if (this.stop.signal.aborted) return;
        online = false;
        ctx.connected(false, (err as Error).message);
        await Bun.sleep(1000);
      }
    }
  }

  private async channel(chat: string, ctx: ImContext): Promise<string> {
    const channel = await ctx.keptGet("dm:" + chat);
    if (channel) return channel;
    // The local platform can create a DM from the user id before receiving its first update.
    const created = "dm-channel:" + chat;
    await ctx.keptSet("dm:" + chat, created);
    return created;
  }

  async send(chat: string, message: OutboundMessageWire, ctx: ImContext): Promise<SendResult> {
    if (message.text.includes("[simulate-fail]")) throw new PluginSendFailedError("Simulated platform refusal", { refused: true });
    const channel = await this.channel(chat, ctx);
    const result: SendResult = this.endpoint
      ? await (await this.call("/send", { channel, message })).json()
      : { status: "sent", messageId: `local-${this.seq++}` };
    return message.text.includes("[simulate-unknown]") ? { status: "unknown", error: "Simulated lost receipt" } : result;
  }

  async edit(chat: string, messageId: string, message: OutboundMessageWire, ctx: ImContext): Promise<SendResult> {
    return this.endpoint ? (await this.call("/edit", { channel: await this.channel(chat, ctx), messageId, message })).json() : { status: "sent", messageId };
  }

  async dropButtons(chat: string, messageId: string, ctx: ImContext): Promise<SendResult> {
    if (this.endpoint) await this.call("/drop_buttons", { channel: await this.channel(chat, ctx), messageId });
    return { status: "sent", messageId };
  }

  async answerPress(chat: string, press: string, text: string, ctx: ImContext): Promise<void> {
    if (this.endpoint) await this.call("/answer_press", { channel: await this.channel(chat, ctx), press, text });
  }

  async fetchAttachment(id: string, destPath: string): Promise<FetchAttachmentResult> {
    if (!this.endpoint) throw new Error("No local platform configured");
    const response = await this.call("/attachments/" + encodeURIComponent(id));
    const size = await Bun.write(destPath, response);
    return { ok: true, size };
  }

  async setMenu(items: MenuItem[]): Promise<void> {
    if (this.endpoint) await this.call("/set_menu", { items });
  }

  /** A fake bind flow that shows every kind of wizard step: scan, link, wait, a secret input, done. */
  async wizard(params: ImWizardParams, ctx: ImWizardContext): Promise<ImWizardDone> {
    ctx.qr("local-im://bind/" + params.botName, "用本地平台扫码");
    ctx.link("http://localhost/bind/" + params.botName, "或打开链接");
    ctx.waiting("等待本地平台确认");
    const token = await ctx.input("本地平台的 token", { secret: true });
    return { config: { token }, text: "Local IM Bot 已绑定" };
  }

  async shutdown(): Promise<void> {
    this.stop.abort();
  }
}

if (import.meta.main) runImPlugin(new LocalImPlugin());
