import { validateImCapabilities, type Capabilities } from "./manifest";
import { logStderr, readJsonLines, writeJsonLine, type LineSink, type LineSource } from "./stdio";

export type JsonRpcId = string | number;

export type JsonRpcRequest<M extends string = string, P = unknown> = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: M;
  params: P;
};

export type JsonRpcNotification<M extends string = string, P = unknown> = {
  jsonrpc: "2.0";
  method: M;
  params: P;
};

export type JsonRpcSuccess<R = unknown> = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: R;
};

export type JsonRpcError = {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
};

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcSuccess | JsonRpcError;

export type ImInitParams = {
  proto: 1;
  botId: string;
  botName: string;
  config: Record<string, string>;
};

export type Button = {
  label: string;
  data: string;
  row?: number;
  muted?: true;
  fill?: string;
  copy?: true;
};

export type OutboundMessageWire = {
  text: string;
  markdown?: string;
  buttons?: Button[];
  replyTo?: string;
  seq?: number;
  file?: { kind: "image" | "file"; path: string; name: string };
  final?: true;
  stream?: true;
  draft?: true;
};

export type SendResult =
  | { status: "sent"; messageId?: string; ref?: string }
  | { status: "failed" | "unknown"; error: string; quota?: boolean; refused?: true; flood?: true };

export type MenuItem = {
  command: string;
  description: string;
};

export type RowButton =
  | { label: string; command: string }
  | { label: string; sub: { label: string; command: string }[] };

export type ImInboundAttachment = {
  id: string;
  kind: "image" | "file";
  name?: string;
  mimeType?: string;
};

export type ImInboundMessage = {
  chat: string;
  messageId: string;
  sender: string;
  text: string;
  at: number;
  quote?: { ref: string; text?: string; fallback?: string; picked?: true };
  ref?: string;
  button?: { data: string; message: string; text?: string };
  voice?: true;
  attachments?: ImInboundAttachment[];
};

export type ImProfile = {
  botBase64?: string;
  youBase64?: string;
  name?: string;
};

export type FetchAttachmentResult = {
  ok: true;
  size: number;
  mimeType?: string;
};

export class PluginSendFailedError extends Error {
  readonly quota?: boolean;
  readonly refused?: true;
  readonly flood?: true;

  constructor(message: string, opts?: { quota?: boolean; refused?: true; flood?: true }) {
    super(message);
    this.name = "PluginSendFailedError";
    if (opts?.quota !== undefined) this.quota = opts.quota;
    if (opts?.refused !== undefined) this.refused = opts.refused;
    if (opts?.flood !== undefined) this.flood = opts.flood;
  }
}

export interface ImContext {
  connected(up: boolean, error?: string): void;
  inbound(msg: ImInboundMessage): Promise<void>;
  keptGet(key: string): Promise<string | null>;
  keptSet(key: string, value: string | null): Promise<void>;
  log(message: string): void;
}

export interface ImPlugin {
  init(params: ImInitParams, ctx: ImContext): Promise<Capabilities>;
  send(chat: string, message: OutboundMessageWire, ctx: ImContext): Promise<SendResult>;
  edit?(chat: string, messageId: string, message: OutboundMessageWire, ctx: ImContext): Promise<SendResult>;
  dropButtons?(chat: string, messageId: string, ctx: ImContext): Promise<SendResult>;
  answerPress?(chat: string, press: string, text: string, ctx: ImContext): Promise<void>;
  fetchAttachment?(attachmentId: string, destPath: string, ctx: ImContext): Promise<FetchAttachmentResult>;
  setMenu?(items: MenuItem[], chat: string | undefined, ctx: ImContext): Promise<void>;
  setRow?(row: RowButton[], chat: string | undefined, ctx: ImContext): Promise<void>;
  profile?(you: string | null, ctx: ImContext): Promise<ImProfile>;
  shutdown?(): Promise<void>;
}

export type ImSignalRegistrar = boolean | ((onSignal: (signal: string) => void) => () => void);

export type ImPluginRunOptions = {
  shutdownTimeoutMs?: number;
  stdin?: LineSource;
  stdout?: LineSink;
  stderr?: LineSink;
  exit?: (code: number) => void;
  registerSignals?: ImSignalRegistrar;
};

function formatError(err: unknown): string {
  if (err instanceof Error) return err.stack || err.message;
  return String(err);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sendFailureResult(err: unknown, stderr: LineSink, op: string): SendResult {
  if (err instanceof PluginSendFailedError) {
    return {
      status: "failed",
      error: err.message,
      ...(err.quota !== undefined ? { quota: err.quota } : {}),
      ...(err.refused ? { refused: true } : {}),
      ...(err.flood ? { flood: true } : {}),
    };
  }
  // Preserve unknown semantics on uncaught exceptions so the core never retries an uncertain send.
  logStderr(`plugin.${op}() threw unexpected error (mapped to unknown): ${formatError(err)}`, stderr);
  return { status: "unknown", error: errorMessage(err) };
}

/** Run an ImPlugin over concurrent bidirectional rh-im/1 JSON-RPC 2.0 stdio. */
export async function runImPlugin(
  plugin: ImPlugin,
  opts?: ImPluginRunOptions,
): Promise<number> {
  const stdin: LineSource = opts?.stdin ?? process.stdin;
  const stdout: LineSink = opts?.stdout ?? process.stdout;
  const stderr: LineSink = opts?.stderr ?? process.stderr;
  const exitFn = opts?.exit ?? ((code: number) => process.exit(code));
  const shutdownTimeoutMs = opts?.shutdownTimeoutMs ?? 5_000;

  const stopController = new AbortController();
  let finished = false;
  let finalExitCode: number | null = null;
  let nextReqSeq = 1;
  let initPromise: Promise<void> | null = null;
  let shutdownHookPromise: Promise<void> | null = null;
  let terminatePromise: Promise<number> | null = null;

  const pendingOutgoing = new Map<
    JsonRpcId,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
  >();

  const writeRpc = (msg: JsonRpcMessage): void => {
    if (finished) return;
    writeJsonLine(stdout, msg);
  };

  const respondResult = (id: JsonRpcId, result: unknown): void => {
    writeRpc({ jsonrpc: "2.0", id, result });
  };

  const respondError = (id: JsonRpcId | null, code: number, message: string): void => {
    writeRpc({ jsonrpc: "2.0", id, error: { code, message } });
  };

  const rejectAllPending = (reason: string): void => {
    for (const [id, waiter] of pendingOutgoing) {
      pendingOutgoing.delete(id);
      waiter.reject(new Error(reason));
    }
  };

  const callCore = <R = unknown>(method: string, params: unknown): Promise<R> => {
    if (finished || stopController.signal.aborted) {
      return Promise.reject(new Error("IM plugin is shutting down"));
    }
    const id: JsonRpcId = `im-${nextReqSeq++}`;
    return new Promise<R>((resolvePromise, rejectPromise) => {
      pendingOutgoing.set(id, {
        resolve: resolvePromise as (value: unknown) => void,
        reject: rejectPromise,
      });
      writeRpc({ jsonrpc: "2.0", id, method, params });
    });
  };

  const ctx: ImContext = {
    connected(up, error) {
      writeRpc({
        jsonrpc: "2.0",
        method: "connected",
        params: error !== undefined ? { up, error } : { up },
      });
    },
    async inbound(msg) {
      await callCore<{ ok: true }>("inbound", msg);
    },
    async keptGet(key) {
      const res = await callCore<{ value: string | null }>("kept_get", { key });
      return res.value ?? null;
    },
    async keptSet(key, value) {
      await callCore<{ ok: true }>("kept_set", { key, value });
    },
    log(message) {
      logStderr(message, stderr);
    },
  };

  const runBoundedShutdown = (): Promise<void> => {
    if (shutdownHookPromise) return shutdownHookPromise;
    shutdownHookPromise = (async () => {
      if (!plugin.shutdown) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          plugin.shutdown(),
          new Promise<void>((resolveTimeout) => {
            timer = setTimeout(() => {
              logStderr(`plugin.shutdown() timed out after ${shutdownTimeoutMs}ms`, stderr);
              resolveTimeout();
            }, shutdownTimeoutMs);
          }),
        ]);
      } catch (err) {
        logStderr(`plugin.shutdown() failed: ${formatError(err)}`, stderr);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    })();
    return shutdownHookPromise;
  };

  const terminate = (code: number, runShutdownHook: boolean, ackId?: JsonRpcId): Promise<number> => {
    if (terminatePromise) return terminatePromise;
    terminatePromise = (async () => {
      stopController.abort();
      rejectAllPending("IM plugin shutting down");
      if (runShutdownHook) {
        await runBoundedShutdown();
      }
      if (ackId !== undefined) {
        respondResult(ackId, { ok: true });
      }
      finished = true;
      finalExitCode = code;
      return code;
    })();
    return terminatePromise;
  };

  const handleRequest = async (req: JsonRpcRequest): Promise<void> => {
    const params = (req.params ?? {}) as Record<string, unknown>;
    switch (req.method) {
      case "init": {
        if (params.proto !== 1) {
          const msg = `Unsupported protocol version: ${String(params.proto)}`;
          logStderr(msg, stderr);
          respondError(req.id, -32602, msg);
          await terminate(1, false);
          return;
        }
        try {
          const caps = await plugin.init(params as unknown as ImInitParams, ctx);
          const checked = validateImCapabilities(caps);
          if (!checked.ok) {
            logStderr(`Invalid IM capabilities from init(): ${checked.error}`, stderr);
            respondError(req.id, -32603, checked.error);
            await terminate(1, false);
            return;
          }
          respondResult(req.id, { proto: 1, capabilities: checked.capabilities });
        } catch (err) {
          logStderr(`plugin.init() failed: ${formatError(err)}`, stderr);
          respondError(req.id, -32000, errorMessage(err));
          await terminate(1, false);
        }
        return;
      }
      case "send": {
        try {
          const result = await plugin.send(
            params.chat as string,
            params.message as OutboundMessageWire,
            ctx,
          );
          respondResult(req.id, result);
        } catch (err) {
          respondResult(req.id, sendFailureResult(err, stderr, "send"));
        }
        return;
      }
      case "edit": {
        if (!plugin.edit) {
          respondError(req.id, -32601, "Method edit is not supported");
          return;
        }
        try {
          const result = await plugin.edit(
            params.chat as string,
            params.messageId as string,
            params.message as OutboundMessageWire,
            ctx,
          );
          respondResult(req.id, result);
        } catch (err) {
          respondResult(req.id, sendFailureResult(err, stderr, "edit"));
        }
        return;
      }
      case "drop_buttons": {
        if (!plugin.dropButtons) {
          respondError(req.id, -32601, "Method drop_buttons is not supported");
          return;
        }
        try {
          const result = await plugin.dropButtons(
            params.chat as string,
            params.messageId as string,
            ctx,
          );
          respondResult(req.id, result);
        } catch (err) {
          respondResult(req.id, sendFailureResult(err, stderr, "dropButtons"));
        }
        return;
      }
      case "answer_press": {
        if (!plugin.answerPress) {
          respondError(req.id, -32601, "Method answer_press is not supported");
          return;
        }
        try {
          await plugin.answerPress(
            params.chat as string,
            params.press as string,
            params.text as string,
            ctx,
          );
          respondResult(req.id, { ok: true });
        } catch (err) {
          logStderr(`plugin.answerPress() failed: ${formatError(err)}`, stderr);
          respondError(req.id, -32000, errorMessage(err));
        }
        return;
      }
      case "fetch_attachment": {
        if (!plugin.fetchAttachment) {
          respondError(req.id, -32601, "Method fetch_attachment is not supported");
          return;
        }
        try {
          const res = await plugin.fetchAttachment(
            params.attachmentId as string,
            params.destPath as string,
            ctx,
          );
          respondResult(req.id, res);
        } catch (err) {
          logStderr(`plugin.fetchAttachment() failed: ${formatError(err)}`, stderr);
          respondError(req.id, -32000, errorMessage(err));
        }
        return;
      }
      case "set_menu": {
        if (!plugin.setMenu) {
          respondError(req.id, -32601, "Method set_menu is not supported");
          return;
        }
        try {
          await plugin.setMenu(
            params.items as MenuItem[],
            params.chat as string | undefined,
            ctx,
          );
          respondResult(req.id, { ok: true });
        } catch (err) {
          logStderr(`plugin.setMenu() failed: ${formatError(err)}`, stderr);
          respondError(req.id, -32000, errorMessage(err));
        }
        return;
      }
      case "set_row": {
        if (!plugin.setRow) {
          respondError(req.id, -32601, "Method set_row is not supported");
          return;
        }
        try {
          await plugin.setRow(
            params.row as RowButton[],
            params.chat as string | undefined,
            ctx,
          );
          respondResult(req.id, { ok: true });
        } catch (err) {
          logStderr(`plugin.setRow() failed: ${formatError(err)}`, stderr);
          respondError(req.id, -32000, errorMessage(err));
        }
        return;
      }
      case "profile": {
        if (!plugin.profile) {
          respondResult(req.id, {});
          return;
        }
        try {
          const prof = await plugin.profile((params.you as string | null | undefined) ?? null, ctx);
          respondResult(req.id, prof ?? {});
        } catch (err) {
          logStderr(`plugin.profile() failed: ${formatError(err)}`, stderr);
          respondResult(req.id, {});
        }
        return;
      }
      case "shutdown": {
        await terminate(0, true, req.id);
        return;
      }
      default: {
        respondError(req.id, -32601, `Method not found: ${req.method}`);
      }
    }
  };

  const onMessage = (raw: unknown): void => {
    if (finished || stopController.signal.aborted) return;
    if (typeof raw !== "object" || raw === null) {
      logStderr("Ignoring non-object JSON-RPC payload", stderr);
      return;
    }

    const msg = raw as Record<string, unknown>;
    if (typeof msg.method === "string") {
      if (msg.id !== undefined) {
        const req = msg as unknown as JsonRpcRequest;
        const p = handleRequest(req);
        if (req.method === "init") {
          initPromise = p;
        }
      }
      return;
    }

    if (msg.id !== undefined && ("result" in msg || "error" in msg)) {
      const waiter = pendingOutgoing.get(msg.id as JsonRpcId);
      if (!waiter) return;
      pendingOutgoing.delete(msg.id as JsonRpcId);
      if ("error" in msg && msg.error !== undefined) {
        const rpcErr = msg.error as { message?: unknown };
        waiter.reject(new Error(typeof rpcErr?.message === "string" ? rpcErr.message : JSON.stringify(msg.error)));
      } else {
        waiter.resolve(msg.result);
      }
    }
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
        logStderr(`stdin JSON-RPC error: ${formatError(err)}`, stderr);
        respondError(null, -32700, err.message);
      },
    });
    if (initPromise && !terminatePromise) {
      await initPromise;
    }
    if (!terminatePromise) {
      await terminate(0, true);
    } else {
      await terminatePromise;
    }
  } finally {
    cleanupSignals?.();
  }

  const code = finalExitCode ?? 0;
  exitFn(code);
  return code;
}
