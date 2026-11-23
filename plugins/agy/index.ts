import { basename, join } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { PluginFatalError, runAgentPlugin, type AgentContext, type AgentInitParams, type AgentPlugin, type AgentSendParams, type AskAnswer } from "@rhodium-oss/plugin-sdk";
import { AcpPeer, list, object, text, within, type RpcId, type Wire } from "./acp";
import { form } from "./form";
import manifest from "./plugin.json";

const cancelled = { outcome: { outcome: "cancelled" } };
// Below the core's 10 s handshake limit (durations.pluginHandshake), so the user sees this plugin's reason.
const startupTimeout = 8_000;
// agy stops sub-agents and background tasks on cancel; stay under the core's 10 s interrupt limit.
const interruptTimeout = 8_000;

type Tool = { name: string; input: unknown; complete: boolean };
type Pending = { id: RpcId; cancel: Wire; submit: (answer: AskAnswer) => Wire };
type Turn = {
  ctx: AgentContext; tools: Map<string, Tool>; asks: Map<string, Pending>;
  reply: string; message: string; interrupted: boolean; done: PromiseWithResolvers<void>;
};

function environment(offline: boolean): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => offline
    ? /^(path|systemroot|windir|tmp|temp|os|pathext|comspec)$/i.test(key)
    : !/^(anthropic_|claude|herdr_|rhodium_token$)/i.test(key)));
}

function executable(program: string): string {
  const blocked = (path: string) => /^(claude(?:\..*)?|.*\.(cmd|bat|ps1))$/i.test(basename(path));
  if (blocked(program)) throw new PluginFatalError("Set the Antigravity program to a native agy executable, not a shell wrapper.");
  const path = Bun.which(process.platform === "win32" && program === "agy" ? "agy.exe" : program);
  if (!path) throw new PluginFatalError("Antigravity executable not found. Install agy or set agy under [programs].");
  const resolved = realpathSync(path);
  if (blocked(resolved)) throw new PluginFatalError("The configured Antigravity executable is not supported.");
  return resolved;
}

export class AgyPlugin implements AgentPlugin {
  private peer?: AcpPeer;
  private session = "";
  private image = false;
  private rules = "";
  private closable = false;
  private turn?: Turn;
  private nextAsk = 0;

  async init(params: AgentInitParams, _ctx: AgentContext) {
    const fixture = params.config.fixture;
    if (fixture !== undefined && fixture !== "builtin") throw new PluginFatalError("Unknown Antigravity fixture; use fixture = \"builtin\".");
    const offline = fixture === "builtin";
    const pluginDir = process.env.RHODIUM_PLUGIN_DIR || import.meta.dir;
    // With slot approval off, agy approves tools itself (spec §9.2 #3); liveApproval is false, so a switch restarts the slot.
    const args = ["acp", ...(params.approval ? [] : ["--dangerously-skip-permissions"])];
    const command: [string, ...string[]] = offline
      ? [process.execPath, fakeAgy(pluginDir), ...args]
      : [executable(params.program ?? manifest.program), ...args];
    this.rules = await Bun.file(params.systemPromptFile).text();
    const peer = this.peer = new AcpPeer(command, offline ? pluginDir : params.cwd, environment(offline), (method, value, id) => {
      if (id === undefined) {
        if (method === "session/update") this.update(value);
      } else {
        void this.reverse(peer, method, value, id).catch(() => {});
      }
    });
    try {
      await within(this.handshake(peer, params), startupTimeout, `Antigravity did not start within ${startupTimeout / 1000} s.`);
      return { session: this.session, capabilities: manifest.capabilities, version: manifest.version };
    } catch (error) {
      await this.close();
      const message = error instanceof Error ? error.message : "Antigravity failed to start.";
      throw new Error(peer.tail && !message.includes(peer.tail) ? `${message}\n${peer.tail}` : message);
    }
  }

  private async handshake(peer: AcpPeer, params: AgentInitParams): Promise<void> {
    const initialized = await peer.request("initialize", {
      protocolVersion: 1, clientInfo: { name: "Rhodium", version: manifest.version },
      clientCapabilities: { elicitation: { form: {} } },
    });
    if (initialized.protocolVersion !== 1) throw new Error("Antigravity did not negotiate ACP protocol version 1.");
    const caps = object(initialized.agentCapabilities);
    this.image = object(caps.promptCapabilities).image === true;
    this.closable = object(caps.sessionCapabilities).close != null;
    const dir = { cwd: params.cwd, mcpServers: [] };
    if ("resume" in params.session) {
      const sessionId = params.session.resume;
      const canResume = object(caps.sessionCapabilities).resume != null;
      if (!canResume && caps.loadSession !== true) throw new Error("Antigravity does not support resuming sessions over ACP.");
      await peer.request(canResume ? "session/resume" : "session/load", { ...dir, sessionId });
      this.session = sessionId;
    } else {
      const opened = await peer.request("session/new", dir);
      this.session = text(opened.sessionId);
      if (!this.session) throw new Error("Antigravity did not return a session ID.");
    }
  }

  async send(msg: AgentSendParams, ctx: AgentContext): Promise<void> {
    const peer = this.peer;
    if (!peer?.alive) throw new PluginFatalError("Antigravity ACP is not running.", { retryable: true });
    if (this.turn || msg.mode !== "turn") {
      ctx.error("Antigravity does not support overlapping turns.", true);
      return;
    }
    if (msg.images?.length && !this.image) throw new Error("This Antigravity version does not accept image prompts.");
    const turn: Turn = this.turn = {
      ctx, tools: new Map(), asks: new Map(), reply: "", message: "", interrupted: false, done: Promise.withResolvers(),
    };
    let reply: string | undefined;
    try {
      const prompt: Wire[] = [];
      if (this.rules.trim()) prompt.push({ type: "text", text: `Rhodium slot instructions:\n${this.rules}` });
      prompt.push({ type: "text", text: msg.text });
      for (const image of msg.images ?? []) prompt.push({ type: "image", ...image });
      const result = await peer.request("session/prompt", { sessionId: this.session, prompt }, () => {
        ctx.taken(msg.id);
        ctx.turnStart(msg.id);
      });
      if (!turn.interrupted && result.stopReason !== "cancelled") {
        this.rules = "";
        this.flushMessage(turn);
        reply = turn.reply || undefined;
      }
    } catch (error) {
      if (!turn.interrupted) {
        if (!peer.alive) throw new PluginFatalError(["Lost the Antigravity ACP connection.", peer.tail].filter(Boolean).join("\n"), { retryable: true });
        ctx.error(error instanceof Error ? error.message : "Antigravity prompt failed.", true);
      }
    } finally {
      if (this.turn === turn) {
        this.turn = undefined;
        await this.cancelAsks(turn);
        if (peer.alive || turn.interrupted) ctx.turnEnd(reply);
      }
      turn.done.resolve();
    }
  }

  private flushMessage(turn: Turn): void {
    if (turn.message) turn.ctx.item({ kind: "message", text: turn.message });
    turn.message = "";
  }

  private update(params: Wire): void {
    const turn = this.turn;
    if (!turn || turn.interrupted || params.sessionId !== this.session) return;
    const update = object(params.update);
    if (update.sessionUpdate === "agent_message_chunk") {
      const content = object(update.content);
      const delta = content.type === "text" ? text(content.text) : "";
      if (delta) {
        turn.message += delta;
        turn.reply += delta;
        turn.ctx.textDelta(delta);
      }
    } else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      this.tool(turn, update);
    }
  }

  private tool(turn: Turn, update: Wire): Tool | undefined {
    const id = text(update.toolCallId);
    if (!id) return;
    let tool = turn.tools.get(id);
    if (!tool) {
      this.flushMessage(turn);
      tool = { name: text(update.title) || "Tool", input: update.rawInput ?? null, complete: false };
      turn.tools.set(id, tool);
      turn.ctx.toolStart(id, tool.name, tool.input);
    } else {
      tool.name = text(update.title) || tool.name;
      if (update.rawInput !== undefined) tool.input = update.rawInput;
    }
    if (!tool.complete && (update.status === "completed" || update.status === "failed")) {
      tool.complete = true;
      const contents = list(update.content).map(object).flatMap(item => {
        const content = object(item.content);
        return item.type === "content" && content.type === "text" ? [text(content.text)] : [];
      });
      const raw = update.rawOutput;
      const output = contents.join("\n") || (typeof raw === "string" ? raw : raw == null ? "" : JSON.stringify(raw));
      turn.ctx.item({ kind: "tool", id, name: tool.name, input: tool.input, result: { text: output, error: update.status === "failed" } });
    }
    return tool;
  }

  private async reverse(peer: AcpPeer, method: string, params: Wire, id: RpcId): Promise<void> {
    const turn = this.turn;
    if (method === "session/request_permission") {
      if (!turn || turn.interrupted || params.sessionId !== this.session) return peer.respond(id, cancelled);
      const call = object(params.toolCall);
      const tool = this.tool(turn, call);
      const options = list(params.options).map(object);
      const yes = options.find(option => option.kind === "allow_once" && text(option.optionId));
      const no = options.find(option => option.kind === "reject_once" && text(option.optionId));
      const requestId = `agy-ask-${++this.nextAsk}`;
      turn.asks.set(requestId, { id, cancel: cancelled, submit(answer) {
        const option = answer.kind === "permission" ? answer.allow ? yes : no : undefined;
        return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : cancelled;
      } });
      turn.ctx.ask({ requestId, kind: "permission", tool: tool?.name ?? "Tool", input: tool?.input ?? null, toolUse: text(call.toolCallId) || undefined });
    } else if (method === "elicitation/create") {
      if (params.mode !== "form") return peer.reject(id, -32602, "Only form elicitation is supported by Rhodium.");
      if (!turn || turn.interrupted || params.sessionId !== this.session) return peer.respond(id, { action: "cancel" });
      const question = form(params);
      // agy falls back to asking in the conversation when the form errors, so the user can still answer.
      if (!question) return peer.reject(id, -32602, "Rhodium cannot show this form.");
      const requestId = `agy-ask-${++this.nextAsk}`;
      turn.asks.set(requestId, { id, cancel: { action: "cancel" }, submit: answer => answer.kind === "question"
        ? question.submit(answer.answers) : { action: "decline" } });
      turn.ctx.ask({ requestId, kind: "question", tool: "Antigravity", input: question.input, toolUse: text(params.toolCallId) || undefined });
    } else {
      await peer.reject(id, -32601, "ACP method unsupported by Rhodium.");
    }
  }

  async answer(requestId: string, answer: AskAnswer): Promise<void> {
    const asks = this.turn?.asks;
    const pending = asks?.get(requestId);
    if (!pending || !this.peer) throw new Error("Antigravity request is no longer pending.");
    asks!.delete(requestId);
    await this.peer.respond(pending.id, pending.submit(answer));
  }

  private async cancelAsks(turn: Turn): Promise<void> {
    const pending = [...turn.asks];
    turn.asks.clear();
    await Promise.allSettled(pending.map(([requestId, ask]) => {
      turn.ctx.askCancel(requestId);
      return this.peer?.respond(ask.id, ask.cancel);
    }));
  }

  async interrupt(): Promise<void> {
    const turn = this.turn;
    const peer = this.peer;
    if (!turn || turn.interrupted || !peer) return;
    turn.interrupted = true;
    try {
      await within(Promise.all([peer.notify("session/cancel", { sessionId: this.session }), this.cancelAsks(turn), turn.done.promise]),
        interruptTimeout, "Antigravity did not acknowledge cancellation.");
    } catch {
      // agy ignored the cancel, so skip session/close and its 1 s wait: the kill lands well inside the core's 10 s.
      this.turn = undefined;
      await peer.close();
      throw new PluginFatalError("Antigravity stopped responding during cancellation.", { retryable: true });
    }
  }

  async close(): Promise<void> {
    if (this.turn) {
      this.turn.interrupted = true;
      this.turn = undefined;
    }
    await this.peer?.close(this.closable ? this.session : undefined);
  }
}

/** The packaged plugin ships the fake agy bundled as fixtures/agy.js (scripts/plugin-package.ts); a checkout runs the source. */
function fakeAgy(pluginDir: string) {
  const bundled = join(pluginDir, "fixtures", "agy.js");
  return existsSync(bundled) ? bundled : join(pluginDir, "fixtures", "agy.ts");
}

if (import.meta.main) void runAgentPlugin(new AgyPlugin());
