import {
  PluginSendFailedError,
  runImPlugin,
  type Capabilities,
  type ImContext,
  type ImInitParams,
  type ImPlugin,
  type OutboundMessageWire,
  type SendResult,
} from "@rhodium-oss/plugin-sdk";

class LocalImPlugin implements ImPlugin {
  private seq = 1;
  private readonly channels = new Map<string, string>();

  async init(_params: ImInitParams, ctx: ImContext): Promise<Capabilities> {
    ctx.connected(true);
    return {
      progress: "edit",
      editEvery: 100,
      finalEdit: true,
      buttons: true,
      maxButtons: 8,
      sendLimit: { kind: "rate", perChatPerSecond: 20 },
      menu: { scope: "global", maxItems: 10 },
      maxTextLength: 4000,
      maxFileBytes: { image: 10485760, file: 26214400 },
      markdown: { extensions: ["heading"] },
    };
  }

  async send(chat: string, message: OutboundMessageWire, ctx: ImContext): Promise<SendResult> {
    if (message.text.includes("[simulate-unknown]")) {
      return { status: "unknown", error: "Simulated lost receipt" };
    }
    if (message.text.includes("[simulate-fail]")) {
      throw new PluginSendFailedError("Simulated platform refusal", { refused: true });
    }
    if (!this.channels.has(chat)) {
      const stored = await ctx.keptGet(`dm:${chat}`);
      const channel = stored ?? `dm-channel:${chat}`;
      if (!stored) {
        await ctx.keptSet(`dm:${chat}`, channel);
      }
      this.channels.set(chat, channel);
    }
    return { status: "sent", messageId: `local-${this.seq++}` };
  }

  async edit(_chat: string, messageId: string): Promise<SendResult> {
    return { status: "sent", messageId };
  }

  async dropButtons(_chat: string, messageId: string): Promise<SendResult> {
    return { status: "sent", messageId };
  }

  async shutdown(): Promise<void> {}
}

if (import.meta.main) {
  runImPlugin(new LocalImPlugin());
}
