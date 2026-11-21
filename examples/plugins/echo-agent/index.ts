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

export class EchoAgentPlugin implements AgentPlugin {
  deliveredAnswers = 0;
  private sessionId: string | null = null;
  private delayedSession = false;
  private activeTurn = false;
  private pendingAsks = new Map<string, (answer: AskAnswer | null) => void>();

  async init(params: AgentInitParams, _ctx: AgentContext): Promise<AgentReadyInfo> {
    this.sessionId = "new" in params.session ? params.session.new : params.session.resume;
    this.delayedSession = params.config.delayedSession === "1" || params.config.delayedSession === "true";
    return {
      session: this.delayedSession ? null : this.sessionId,
      capabilities: {
        liveApproval: false,
        steer: false,
        commands: ["status", "model"],
      },
      version: "0.1.0",
    };
  }

  async send(msg: AgentSendParams, ctx: AgentContext): Promise<void> {
    this.activeTurn = true;
    try {
      ctx.taken(msg.id);
      ctx.turnStart(msg.id);

      const trimmed = msg.text.replace(/^\[来自 [^\n]*\]\n/, "").trim();
      if (trimmed === "/fail") {
        throw new PluginFatalError("Simulated failure triggered by /fail", { retryable: true });
      }

      const toolId = `echo-tool-${msg.id}`;
      ctx.toolStart(toolId, "echo", { text: msg.text });

      if (trimmed.includes("[ask]") || trimmed === "列出当前目录并确认是否修改") {
        const requestId = `ask-${msg.id}`;
        ctx.ask({
          requestId,
          kind: "permission",
          tool: "echo",
          input: { text: msg.text },
          toolUse: toolId,
        });
        const ans = await new Promise<AskAnswer | null>((resolveAnswer) => {
          this.pendingAsks.set(requestId, resolveAnswer);
        });
        if (ans === null) return;
        const allowed = ans.kind === "permission" && ans.allow;
        ctx.item({
          kind: "tool",
          id: toolId,
          name: "echo",
          input: { text: msg.text },
          result: { text: allowed ? "allowed" : "denied", error: !allowed },
        });
      } else {
        ctx.item({
          kind: "tool",
          id: toolId,
          name: "echo",
          input: { text: msg.text },
          result: { text: msg.text },
        });
      }

      if (this.delayedSession && this.sessionId) {
        ctx.session(this.sessionId);
        this.delayedSession = false;
      }

      const reply = `Echo: ${msg.text}`;
      ctx.textDelta(reply);
      ctx.item({ kind: "message", text: reply });
      this.activeTurn = false;
      ctx.turnEnd({ reply, ...(this.sessionId ? { session: this.sessionId } : {}) });
    } finally {
      this.activeTurn = false;
    }
  }

  async answer(requestId: string, answer: AskAnswer): Promise<void> {
    const waiter = this.pendingAsks.get(requestId);
    if (!waiter) throw new Error(`Unknown ask requestId: ${requestId}`);
    this.pendingAsks.delete(requestId);
    waiter(answer);
    this.deliveredAnswers++;
  }

  async interrupt(ctx: AgentContext): Promise<void> {
    const hadPending = this.pendingAsks.size > 0;
    for (const [reqId, resolveWaiter] of this.pendingAsks) {
      this.pendingAsks.delete(reqId);
      ctx.askCancel(reqId);
      resolveWaiter(null);
    }
    if (this.activeTurn || hadPending) {
      this.activeTurn = false;
      ctx.turnEnd();
    }
  }

  async command(name: string): Promise<CommandResult> {
    if (name === "status") {
      return { command: "status", model: "echo-model", context: { usedTokens: 0, maxTokens: 4096 } };
    }
    if (name === "model") {
      return { command: "model", model: "echo-model", label: "Echo Model" };
    }
    throw new Error(`Unsupported command: ${name}`);
  }

  async close(): Promise<void> {
    this.activeTurn = false;
    for (const [reqId, resolveWaiter] of this.pendingAsks) {
      this.pendingAsks.delete(reqId);
      resolveWaiter(null);
    }
  }
}

if (import.meta.main) {
  runAgentPlugin(new EchoAgentPlugin());
}
