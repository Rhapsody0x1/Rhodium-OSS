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

class EchoAgentPlugin implements AgentPlugin {
  private sessionId: string | null = null;
  private delayedSession = false;
  private pendingAsks = new Map<string, (answer: AskAnswer) => void>();

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
    ctx.taken(msg.id);
    ctx.turnStart(msg.id);

    const trimmed = msg.text.trim();
    if (trimmed === "/fail") {
      throw new PluginFatalError("Simulated failure triggered by /fail", { retryable: true });
    }

    const toolId = `echo-tool-${msg.id}`;
    ctx.toolStart(toolId, "echo", { text: msg.text });

    if (trimmed.includes("[ask]")) {
      const requestId = `ask-${msg.id}`;
      ctx.ask({
        requestId,
        kind: "permission",
        tool: "echo",
        input: { text: msg.text },
        toolUse: toolId,
      });
      const ans = await new Promise<AskAnswer>((resolveAnswer) => {
        this.pendingAsks.set(requestId, resolveAnswer);
      });
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
    ctx.turnEnd({ reply, ...(this.sessionId ? { session: this.sessionId } : {}) });
  }

  async answer(requestId: string, answer: AskAnswer): Promise<void> {
    const waiter = this.pendingAsks.get(requestId);
    if (!waiter) throw new Error(`Unknown ask requestId: ${requestId}`);
    this.pendingAsks.delete(requestId);
    waiter(answer);
  }

  async interrupt(ctx: AgentContext): Promise<void> {
    for (const [reqId, resolveWaiter] of this.pendingAsks) {
      this.pendingAsks.delete(reqId);
      ctx.askCancel(reqId);
      resolveWaiter({ kind: "permission", allow: false, message: "interrupted" });
    }
    ctx.turnEnd();
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
    for (const [reqId, resolveWaiter] of this.pendingAsks) {
      this.pendingAsks.delete(reqId);
      resolveWaiter({ kind: "permission", allow: false, message: "closed" });
    }
  }
}

if (import.meta.main) {
  runAgentPlugin(new EchoAgentPlugin());
}
