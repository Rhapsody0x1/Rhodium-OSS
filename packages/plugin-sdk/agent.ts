import { logStderr, readJsonLines, writeJsonLine, type LineSink, type LineSource } from "./stdio";

export type AgentSessionSpec = { new: string } | { resume: string };

export type AgentImage = {
  mimeType: string;
  data: string;
};

export type AgentModelInfo = {
  id: string;
  label?: string;
  efforts?: string[];
};

export type AgentCapabilities = {
  liveApproval?: boolean;
  steer?: boolean;
  commands?: string[];
  models?: AgentModelInfo[];
};

export type AskKind = "question" | "plan" | "permission";

export type AskAnswer =
  | { kind: "permission"; allow: boolean; message?: string }
  | { kind: "question"; answers: Record<string, string> }
  | { kind: "plan"; approve: boolean; message?: string };

export type AgentAskPayload = {
  requestId: string;
  kind: AskKind;
  tool: string;
  input: unknown;
  toolUse?: string;
};

export type AgentItem =
  | { kind: "message"; text: string }
  | { kind: "tool"; id?: string; name: string; input: unknown; result?: { text: string; error?: boolean } };

export type Choice = {
  id: string;
  label: string;
  current?: true;
  group?: string;
};

export type ContextUse = {
  usedTokens: number;
  maxTokens: number | null;
};

export type QuotaWindow = {
  window: "5h" | "7d";
  model?: string;
  usedPercent: number;
  resetsAt: number | null;
  limitId?: string;
};

export type ExtraUsage = {
  usedPercent: number;
  used: number;
  limit: number | null;
  currency: string;
};

export type Tokens = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
};

export type SessionUse = {
  cost?: number;
  tokens: Tokens;
  models?: { name: string; cost: number; tokens: Tokens }[];
};

export type CommandResult =
  | { command: "new" }
  | { command: "stop"; stopped: boolean }
  | { command: "status"; model: string | null; context: ContextUse | null; limits?: QuotaWindow[]; effort?: string; ultracode?: true }
  | { command: "model"; model: string | null; choices?: Choice[]; label?: string; level?: string; was?: string; efforts?: Choice[] }
  | { command: "effort"; level: string; choices?: Choice[] }
  | { command: "ultracode"; on: boolean; choices?: Choice[]; unavailable?: true }
  | { command: "usage"; limits: QuotaWindow[]; extra?: ExtraUsage; credits?: number; session?: SessionUse }
  | { command: "context"; usedTokens: number; maxTokens: number | null; categories?: { name: string; tokens: number }[] }
  | { command: "compact"; beforeTokens: number | null; afterTokens: number | null }
  | { command: "resume"; session: string | null; agent?: string; choices?: Choice[]; name?: string };

export type AgentInitParams = {
  proto: 1;
  conv: string;
  session: AgentSessionSpec;
  cwd: string;
  systemPromptFile: string;
  program?: string | null;
  approval: boolean;
  model?: string | null;
  effort?: string | null;
  resumed?: boolean;
  config: Record<string, string>;
};

export type AgentSendParams = {
  id: string;
  text: string;
  human: boolean;
  mode: "turn" | "steer";
  images?: AgentImage[];
};

export type AgentReadyInfo = {
  session: string | null;
  selfStarted?: boolean;
  capabilities?: AgentCapabilities;
  version?: string;
};

export type AgentUsage = {
  inputTokens?: number;
  outputTokens?: number;
  contextTokens?: number;
  maxContextTokens?: number;
};

export type CoreToAgentMessage =
  | ({ type: "init" } & AgentInitParams)
  | ({ type: "send" } & AgentSendParams)
  | { type: "interrupt" }
  | { type: "answer"; requestId: string; answer: AskAnswer }
  | { type: "approval"; on: boolean }
  | { type: "command"; id: string; name: string; args: string }
  | { type: "close" };

export type AgentToCoreMessage =
  | ({ type: "ready"; proto: 1 } & AgentReadyInfo)
  | { type: "fatal"; message: string; retryable?: boolean }
  | { type: "taken"; inputId: string }
  | { type: "turn_start"; input?: string; session?: string }
  | { type: "session"; session: string }
  | { type: "text_delta"; text: string }
  | { type: "tool_start"; id: string; name: string; input: unknown }
  | { type: "item"; item: AgentItem }
  | ({ type: "ask" } & AgentAskPayload)
  | { type: "ask_resolved"; requestId: string }
  | { type: "ask_cancel"; requestId: string }
  | { type: "turn_end"; reply?: string; background?: boolean; session?: string }
  | ({ type: "usage" } & AgentUsage)
  | { type: "command_result"; id: string; ok: boolean; result?: CommandResult; error?: string }
  | { type: "error"; detail: string; recoverable?: boolean };

export class PluginFatalError extends Error {
  readonly retryable: boolean;

  constructor(message: string, opts?: { retryable?: boolean }) {
    super(message);
    this.name = "PluginFatalError";
    this.retryable = opts?.retryable ?? false;
  }
}

export interface AgentContext {
  taken(inputId: string): void;
  turnStart(input?: string, session?: string): void;
  session(session: string): void;
  textDelta(text: string): void;
  toolStart(id: string, name: string, input: unknown): void;
  item(item: AgentItem): void;
  ask(ask: AgentAskPayload): void;
  askCancel(requestId: string): void;
  usage(usage: AgentUsage): void;
  turnEnd(reply?: string, opts?: { background?: boolean; session?: string }): void;
  turnEnd(opts?: { reply?: string; background?: boolean; session?: string }): void;
  error(detail: string, recoverable?: boolean): void;
  log(message: string): void;
}

export interface AgentPlugin {
  init(params: AgentInitParams, ctx: AgentContext): Promise<AgentReadyInfo>;
  send(msg: AgentSendParams, ctx: AgentContext): Promise<void>;
  interrupt(ctx: AgentContext): Promise<void>;
  answer?(requestId: string, answer: AskAnswer, ctx: AgentContext): Promise<void>;
  approval?(on: boolean, ctx: AgentContext): Promise<void>;
  command?(name: string, args: string, ctx: AgentContext): Promise<CommandResult>;
  close?(): Promise<void>;
}

export type SignalRegistrar = boolean | ((onSignal: (signal: string) => void) => () => void);

export type AgentPluginRunOptions = {
  interruptTimeoutMs?: number;
  closeTimeoutMs?: number;
  stdin?: LineSource;
  stdout?: LineSink;
  stderr?: LineSink;
  exit?: (code: number) => void;
  registerSignals?: SignalRegistrar;
};

function formatError(err: unknown): string {
  if (err instanceof Error) return err.stack || err.message;
  return String(err);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Run an AgentPlugin over rh-agent/1 stdio JSONL with non-blocking control dispatch. */
export async function runAgentPlugin(
  plugin: AgentPlugin,
  opts?: AgentPluginRunOptions,
): Promise<number> {
  const stdin: LineSource = opts?.stdin ?? process.stdin;
  const stdout: LineSink = opts?.stdout ?? process.stdout;
  const stderr: LineSink = opts?.stderr ?? process.stderr;
  const exitFn = opts?.exit ?? ((code: number) => process.exit(code));
  const closeTimeoutMs = opts?.closeTimeoutMs ?? 5_000;
  // Retained in options for caller compatibility; see ponytail note on answer() below.
  void (opts?.interruptTimeoutMs ?? 10_000);

  const stopController = new AbortController();
  let endedTurns = 0;
  let initialized = false;
  let initializing = false;
  let finished = false;
  let finalExitCode: number | null = null;
  let closePromise: Promise<void> | null = null;
  const answers = new Map<string, "pending" | "delivered" | "cancelled">();
  const pendingPostInit: CoreToAgentMessage[] = [];

  const emit = (msg: AgentToCoreMessage): void => {
    if (finished) return;
    writeJsonLine(stdout, msg);
  };

  const ctx: AgentContext = {
    taken(inputId) {
      emit({ type: "taken", inputId });
    },
    turnStart(input, session) {
      emit({
        type: "turn_start",
        ...(input !== undefined ? { input } : {}),
        ...(session !== undefined ? { session } : {}),
      });
    },
    session(session) {
      emit({ type: "session", session });
    },
    textDelta(text) {
      emit({ type: "text_delta", text });
    },
    toolStart(id, name, input) {
      emit({ type: "tool_start", id, name, input });
    },
    item(item) {
      emit({ type: "item", item });
    },
    ask(ask) {
      emit({ type: "ask", ...ask });
    },
    askCancel(requestId) {
      answers.set(requestId, "cancelled");
      emit({ type: "ask_cancel", requestId });
    },
    usage(usage) {
      emit({ type: "usage", ...usage });
    },
    turnEnd(
      replyOrOpts?: string | { reply?: string; background?: boolean; session?: string },
      extraOpts?: { background?: boolean; session?: string },
    ) {
      endedTurns++;
      if (typeof replyOrOpts === "string" || replyOrOpts === undefined) {
        emit({
          type: "turn_end",
          ...(replyOrOpts !== undefined ? { reply: replyOrOpts } : {}),
          ...(extraOpts?.background !== undefined ? { background: extraOpts.background } : {}),
          ...(extraOpts?.session !== undefined ? { session: extraOpts.session } : {}),
        });
      } else {
        emit({
          type: "turn_end",
          ...(replyOrOpts.reply !== undefined ? { reply: replyOrOpts.reply } : {}),
          ...(replyOrOpts.background !== undefined ? { background: replyOrOpts.background } : {}),
          ...(replyOrOpts.session !== undefined ? { session: replyOrOpts.session } : {}),
        });
      }
    },
    error(detail, recoverable) {
      emit({
        type: "error",
        detail,
        ...(recoverable !== undefined ? { recoverable } : {}),
      });
    },
    log(message) {
      logStderr(message, stderr);
    },
  };

  const runBoundedClose = (): Promise<void> => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      if (!plugin.close) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          plugin.close(),
          new Promise<void>((resolveTimeout) => {
            timer = setTimeout(() => {
              logStderr(`plugin.close() timed out after ${closeTimeoutMs}ms`, stderr);
              resolveTimeout();
            }, closeTimeoutMs);
          }),
        ]);
      } catch (err) {
        logStderr(`plugin.close() failed: ${formatError(err)}`, stderr);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    })();
    return closePromise;
  };

  let shutdownPromise: Promise<number> | null = null;
  const terminate = (code: number, runClose: boolean): Promise<number> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      stopController.abort();
      if (runClose) {
        await runBoundedClose();
      }
      finished = true;
      finalExitCode = code;
      return code;
    })();
    return shutdownPromise;
  };

  const dispatchControl = (msg: CoreToAgentMessage): void => {
    if (finished || stopController.signal.aborted) return;

    switch (msg.type) {
      case "send": {
        const endedBeforeSend = endedTurns;
        void (async () => {
          try {
            await plugin.send(msg, ctx);
          } catch (err) {
            logStderr(`plugin.send() failed: ${formatError(err)}`, stderr);
            if (err instanceof PluginFatalError) {
              emit({ type: "error", detail: err.message, recoverable: false });
              await terminate(1, true);
            } else {
              emit({ type: "error", detail: errorMessage(err), recoverable: true });
              if (msg.mode === "turn" && endedTurns === endedBeforeSend) ctx.turnEnd();
            }
          }
        })();
        return;
      }
      case "interrupt": {
        void (async () => {
          try {
            await plugin.interrupt(ctx);
          } catch (err) {
            logStderr(`plugin.interrupt() failed: ${formatError(err)}`, stderr);
            if (err instanceof PluginFatalError) {
              emit({ type: "error", detail: err.message, recoverable: false });
              await terminate(1, true);
            } else {
              emit({ type: "error", detail: errorMessage(err), recoverable: true });
            }
          }
        })();
        return;
      }
      case "answer": {
        const state = answers.get(msg.requestId);
        if (state) {
          if (state === "delivered") emit({ type: "ask_resolved", requestId: msg.requestId });
          return;
        }
        answers.set(msg.requestId, "pending");
        // ponytail: interrupt after a failed answer waits for the plugin; add a local deadline if plugins hang during that cleanup.
        void (async () => {
          if (!plugin.answer) {
            const detail = "Plugin does not implement answer()";
            logStderr(detail, stderr);
            ctx.askCancel(msg.requestId);
            emit({ type: "error", detail, recoverable: false });
            try {
              await plugin.interrupt(ctx);
            } catch (intErr) {
              logStderr(`plugin.interrupt() after missing answer() failed: ${formatError(intErr)}`, stderr);
              await terminate(1, true);
            }
            return;
          }
          try {
            await plugin.answer(msg.requestId, msg.answer, ctx);
            if (answers.get(msg.requestId) !== "pending") return;
            answers.set(msg.requestId, "delivered");
            emit({ type: "ask_resolved", requestId: msg.requestId });
          } catch (err) {
            logStderr(`plugin.answer(${msg.requestId}) failed: ${formatError(err)}`, stderr);
            ctx.askCancel(msg.requestId);
            emit({ type: "error", detail: errorMessage(err), recoverable: false });
            if (err instanceof PluginFatalError) {
              await terminate(1, true);
              return;
            }
            try {
              await plugin.interrupt(ctx);
            } catch (intErr) {
              logStderr(`plugin.interrupt() after answer() failure failed: ${formatError(intErr)}`, stderr);
              await terminate(1, true);
            }
          }
        })();
        return;
      }
      case "approval": {
        void (async () => {
          if (!plugin.approval) {
            const detail = "Plugin does not support live approval switching";
            logStderr(detail, stderr);
            emit({ type: "error", detail, recoverable: true });
            return;
          }
          try {
            await plugin.approval(msg.on, ctx);
          } catch (err) {
            logStderr(`plugin.approval() failed: ${formatError(err)}`, stderr);
            if (err instanceof PluginFatalError) {
              emit({ type: "error", detail: err.message, recoverable: false });
              await terminate(1, true);
            } else {
              emit({ type: "error", detail: errorMessage(err), recoverable: true });
            }
          }
        })();
        return;
      }
      case "command": {
        void (async () => {
          if (!plugin.command) {
            emit({
              type: "command_result",
              id: msg.id,
              ok: false,
              error: `Unsupported command: ${msg.name}`,
            });
            return;
          }
          try {
            const result = await plugin.command(msg.name, msg.args, ctx);
            emit({ type: "command_result", id: msg.id, ok: true, result });
          } catch (err) {
            logStderr(`plugin.command(${msg.name}) failed: ${formatError(err)}`, stderr);
            emit({ type: "command_result", id: msg.id, ok: false, error: errorMessage(err) });
          }
        })();
        return;
      }
      case "close": {
        void terminate(0, true);
        return;
      }
      case "init": {
        logStderr("Ignoring duplicate init message", stderr);
        return;
      }
    }
  };

  const handleInit = (msg: CoreToAgentMessage & { type: "init" }): void => {
    if ((msg as { proto: unknown }).proto !== 1) {
      const detail = `Unsupported protocol version: ${String((msg as { proto: unknown }).proto)}`;
      logStderr(detail, stderr);
      emit({ type: "fatal", message: detail, retryable: false });
      void terminate(1, false);
      return;
    }

    initializing = true;
    void (async () => {
      try {
        const ready = await plugin.init(msg, ctx);
        if (stopController.signal.aborted || finished) return;
        initialized = true;
        initializing = false;
        emit({ type: "ready", proto: 1, ...ready });
        while (pendingPostInit.length > 0 && !stopController.signal.aborted && !finished) {
          dispatchControl(pendingPostInit.shift()!);
        }
      } catch (err) {
        if (stopController.signal.aborted || finished) return;
        logStderr(`plugin.init() failed: ${formatError(err)}`, stderr);
        emit({
          type: "fatal",
          message: errorMessage(err),
          retryable: err instanceof PluginFatalError ? err.retryable : false,
        });
        await terminate(1, false);
      }
    })();
  };

  const onMessage = (raw: unknown): void => {
    if (finished || stopController.signal.aborted) return;
    if (typeof raw !== "object" || raw === null || typeof (raw as { type?: unknown }).type !== "string") {
      logStderr("Ignoring malformed message without type", stderr);
      emit({ type: "error", detail: "Malformed message without type", recoverable: true });
      return;
    }

    const msg = raw as CoreToAgentMessage;
    if (!initialized && !initializing) {
      if (msg.type === "close") {
        void terminate(0, true);
        return;
      }
      if (msg.type !== "init") {
        const detail = `Expected init as first message, received ${msg.type}`;
        logStderr(detail, stderr);
        emit({ type: "fatal", message: detail, retryable: false });
        void terminate(1, false);
        return;
      }
      handleInit(msg);
      return;
    }

    if (initializing) {
      if (msg.type === "close") {
        void terminate(0, true);
        return;
      }
      pendingPostInit.push(msg);
      return;
    }

    dispatchControl(msg);
  };

  let cleanupSignals: (() => void) | undefined;
  const registerSignals = opts?.registerSignals ?? true;
  if (typeof registerSignals === "function") {
    cleanupSignals = registerSignals(() => {
      void terminate(0, true);
    });
  } else if (registerSignals) {
    const onSignal = () => {
      void terminate(0, true);
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    cleanupSignals = () => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    };
  }

  try {
    await readJsonLines(stdin, {
      signal: stopController.signal,
      onMessage,
      onError(err) {
        logStderr(`stdin read error: ${formatError(err)}`, stderr);
        emit({ type: "error", detail: err.message, recoverable: true });
      },
    });
    if (!shutdownPromise) {
      await terminate(0, true);
    } else {
      await shutdownPromise;
    }
  } finally {
    cleanupSignals?.();
  }

  const code = finalExitCode ?? 0;
  exitFn(code);
  return code;
}
