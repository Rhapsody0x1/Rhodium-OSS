import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  expandPluginCommand,
  readJsonLines,
  validateImCapabilities,
  validateManifest,
  type AgentPluginManifest,
  type ImPluginManifest,
} from "@rhodium-oss/plugin-sdk";

const SENSITIVE_ENV_RE = /^(?:anthropic_|claude|herdr_)/i;

type CliArgs = {
  manifestPath: string;
  config: Record<string, string>;
  timeoutMs: number;
};

function parseArgs(argv: string[]): CliArgs {
  let manifestPath = "";
  let configRaw = "{}";
  let timeoutMs = 10_000;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--manifest" && i + 1 < argv.length) {
      manifestPath = argv[++i]!;
    } else if (arg === "--config" && i + 1 < argv.length) {
      configRaw = argv[++i]!;
    } else if (arg === "--timeout" && i + 1 < argv.length) {
      timeoutMs = Number(argv[++i]!);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (!manifestPath) {
    throw new Error("Usage: bun scripts/plugin-conformance.ts --manifest <path> [--config <json>] [--timeout 10000]");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`Invalid --timeout value: ${timeoutMs}`);
  }
  const parsedConfig = JSON.parse(configRaw) as unknown;
  if (typeof parsedConfig !== "object" || parsedConfig === null || Array.isArray(parsedConfig)) {
    throw new Error("--config must be a JSON object");
  }
  const config: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsedConfig)) {
    config[k] = typeof v === "string" ? v : JSON.stringify(v);
  }
  return { manifestPath: resolve(manifestPath), config, timeoutMs };
}

function buildSanitizedEnv(pluginDir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (SENSITIVE_ENV_RE.test(key)) continue;
    env[key] = value;
  }
  env.RHODIUM_PLUGIN_DIR = pluginDir;
  env.PYTHONUTF8 = "1";
  return env;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      rejectPromise(new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`));
    }, timeoutMs);
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolvePromise(val);
      },
      (err) => {
        clearTimeout(timer);
        rejectPromise(err);
      },
    );
  });
}

function writeLine(stdin: { write(chunk: string | Uint8Array): unknown }, msg: unknown): void {
  stdin.write(`${JSON.stringify(msg)}\n`);
}

async function forceCleanupProcess(
  proc: ReturnType<typeof Bun.spawn>,
  graceMs: number,
): Promise<void> {
  if (proc.exitCode !== null) return;
  try {
    proc.kill("SIGTERM");
  } catch {
    return;
  }
  const waitExit = async (ms: number): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        proc.exited.then(() => true).catch(() => true),
        new Promise<boolean>((resolveTimeout) => {
          timer = setTimeout(() => resolveTimeout(false), ms);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  const termWaitMs = Math.max(50, Math.min(graceMs, 500));
  if (await waitExit(termWaitMs)) return;
  if (proc.exitCode !== null) return;
  try {
    proc.kill("SIGKILL");
  } catch {
    return;
  }
  await waitExit(1_000);
}

async function testAgentPlugin(
  manifest: AgentPluginManifest,
  pluginDir: string,
  tempCwd: string,
  config: Record<string, string>,
  timeoutMs: number,
): Promise<void> {
  const argv = expandPluginCommand(manifest, pluginDir);
  const promptFile = join(tempCwd, "system-prompt.md");
  writeFileSync(promptFile, "# Conformance Prompt\n", "utf8");

  const proc = Bun.spawn(argv, {
    cwd: tempCwd,
    env: buildSanitizedEnv(pluginDir),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });

  const stderrPromise = new Response(proc.stderr).text();
  const waiters: Array<{
    check: (msg: Record<string, unknown>) => boolean;
    fail: (err: Error) => void;
  }> = [];
  const backlog: Array<Record<string, unknown>> = [];
  let streamClosed = false;

  const nextMatching = (
    predicate: (msg: Record<string, unknown>) => boolean,
    label: string,
  ): Promise<Record<string, unknown>> => {
    const idx = backlog.findIndex(predicate);
    if (idx >= 0) {
      return Promise.resolve(backlog.splice(idx, 1)[0]!);
    }
    if (streamClosed) {
      return Promise.reject(new Error(`Plugin closed stdout before ${label}`));
    }
    return withTimeout(
      new Promise<Record<string, unknown>>((resolveMatch, rejectMatch) => {
        waiters.push({
          check(msg) {
            if (predicate(msg)) {
              resolveMatch(msg);
              return true;
            }
            return false;
          },
          fail: rejectMatch,
        });
      }),
      timeoutMs,
      label,
    );
  };

  const readerDone = readJsonLines<Record<string, unknown>>(proc.stdout, {
    onMessage(msg) {
      if (trackingTurn) {
        inspectTurnEvent(msg);
      }
      for (let i = 0; i < waiters.length; i++) {
        if (waiters[i]!.check(msg)) {
          waiters.splice(i, 1);
          return;
        }
      }
      backlog.push(msg);
    },
  }).finally(() => {
    streamClosed = true;
    while (waiters.length > 0) {
      const w = waiters.shift()!;
      w.fail(new Error("Plugin closed stdout unexpectedly"));
    }
  });

  let trackingTurn = false;
  let sawTaken = false;
  let sawTurnStart = false;
  let hasReplyContent = false;

  const inspectTurnEvent = (msg: Record<string, unknown>): void => {
    if (msg.type === "taken" && msg.inputId === "conf-in-1") {
      sawTaken = true;
    } else if (msg.type === "turn_start") {
      if (msg.input === undefined || msg.input === "conf-in-1") {
        sawTurnStart = true;
      }
    } else if (msg.type === "text_delta") {
      if (typeof msg.text === "string" && msg.text.trim().length > 0) {
        hasReplyContent = true;
      }
    } else if (msg.type === "item" && typeof msg.item === "object" && msg.item !== null) {
      const item = msg.item as { kind?: unknown; text?: unknown };
      if (item.kind === "message" && typeof item.text === "string" && item.text.trim().length > 0) {
        hasReplyContent = true;
      }
    } else if (msg.type === "turn_end") {
      if (typeof msg.reply === "string" && msg.reply.trim().length > 0) {
        hasReplyContent = true;
      }
    }
  };

  try {
    writeLine(proc.stdin, {
      type: "init",
      proto: 1,
      conv: "conf-conv-1",
      session: { new: "conf-session-1" },
      cwd: tempCwd,
      systemPromptFile: promptFile,
      program: manifest.program,
      approval: false,
      model: null,
      effort: null,
      resumed: false,
      config,
    });

    const readyOrFatal = await nextMatching(
      (m) => m.type === "ready" || m.type === "fatal",
      "agent ready handshake",
    );
    if (readyOrFatal.type === "fatal") {
      throw new Error(`Agent emitted fatal during handshake: ${String(readyOrFatal.message)}`);
    }
    if (readyOrFatal.proto !== 1) {
      throw new Error(`Expected ready.proto === 1, got ${String(readyOrFatal.proto)}`);
    }

    trackingTurn = true;
    writeLine(proc.stdin, {
      type: "send",
      id: "conf-in-1",
      text: "hello conformance",
      human: true,
      mode: "turn",
    });

    const turnDone = await nextMatching(
      (m) => m.type === "turn_end" || m.type === "fatal" || (m.type === "error" && m.recoverable === false),
      "agent turn_end",
    );
    if (turnDone.type !== "turn_end") {
      throw new Error(`Agent turn failed: ${JSON.stringify(turnDone)}`);
    }
    const missing: string[] = [];
    if (!sawTaken) missing.push('taken (inputId: "conf-in-1")');
    if (!sawTurnStart) missing.push("turn_start");
    if (!hasReplyContent) missing.push("non-empty reply content (turn_end.reply, text_delta, or message item)");
    if (missing.length > 0) {
      throw new Error(`Agent turn round-trip incomplete; missing: ${missing.join(", ")}`);
    }

    writeLine(proc.stdin, { type: "close" });
    proc.stdin.end();

    const code = await withTimeout(proc.exited, timeoutMs, "agent graceful exit");
    await readerDone;
    if (code !== 0) {
      const stderrText = await stderrPromise;
      throw new Error(`Agent exited with code ${code}: ${stderrText}`);
    }
  } finally {
    await forceCleanupProcess(proc, timeoutMs);
  }
}

async function testImPlugin(
  manifest: ImPluginManifest,
  pluginDir: string,
  tempCwd: string,
  config: Record<string, string>,
  timeoutMs: number,
): Promise<void> {
  const argv = expandPluginCommand(manifest, pluginDir);
  const proc = Bun.spawn(argv, {
    cwd: tempCwd,
    env: buildSanitizedEnv(pluginDir),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });

  const stderrPromise = new Response(proc.stderr).text();
  const keptStore = new Map<string, string>();
  const pendingById = new Map<
    string | number,
    { resolve: (msg: Record<string, unknown>) => void; reject: (err: Error) => void }
  >();

  const readerDone = readJsonLines<Record<string, unknown>>(proc.stdout, {
    onMessage(msg) {
      if (typeof msg.method === "string") {
        if (msg.id === undefined) return;
        const id = msg.id as string | number;
        const params = (msg.params ?? {}) as Record<string, unknown>;
        if (msg.method === "kept_get") {
          const key = String(params.key ?? "");
          writeLine(proc.stdin, { jsonrpc: "2.0", id, result: { value: keptStore.get(key) ?? null } });
        } else if (msg.method === "kept_set") {
          const key = String(params.key ?? "");
          const value = params.value as string | null;
          if (value === null) keptStore.delete(key);
          else keptStore.set(key, value);
          writeLine(proc.stdin, { jsonrpc: "2.0", id, result: { ok: true } });
        } else if (msg.method === "inbound") {
          writeLine(proc.stdin, { jsonrpc: "2.0", id, result: { ok: true } });
        } else {
          writeLine(proc.stdin, {
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `Unsupported conformance reverse method: ${msg.method}` },
          });
        }
        return;
      }

      if (msg.id !== undefined) {
        const key = msg.id as string | number;
        const waiter = pendingById.get(key);
        if (!waiter) return;
        pendingById.delete(key);
        if ("error" in msg && msg.error !== undefined) {
          waiter.reject(new Error(`JSON-RPC error: ${JSON.stringify(msg.error)}`));
        } else {
          waiter.resolve(msg);
        }
      }
    },
  }).finally(() => {
    for (const [key, waiter] of pendingById) {
      pendingById.delete(key);
      waiter.reject(new Error("Plugin closed stdout before responding to JSON-RPC request"));
    }
  });

  const rpc = (id: number, method: string, params: unknown): Promise<Record<string, unknown>> => {
    return withTimeout(
      new Promise<Record<string, unknown>>((resolveRpc, rejectRpc) => {
        pendingById.set(id, { resolve: resolveRpc, reject: rejectRpc });
        writeLine(proc.stdin, { jsonrpc: "2.0", id, method, params });
      }),
      timeoutMs,
      `IM RPC ${method}`,
    );
  };

  try {
    const initResp = await rpc(1, "init", {
      proto: 1,
      botId: "conf-bot-1",
      botName: manifest.id,
      config,
    });
    const initResult = initResp.result as { proto?: unknown; capabilities?: unknown } | undefined;
    if (!initResult || initResult.proto !== 1) {
      throw new Error(`Expected init result.proto === 1, got ${JSON.stringify(initResp)}`);
    }
    const capsCheck = validateImCapabilities(initResult.capabilities);
    if (!capsCheck.ok) {
      throw new Error(`Invalid IM capabilities returned from init: ${capsCheck.error}`);
    }

    const sendResp = await rpc(2, "send", {
      chat: "conf-user-1",
      message: { text: "hello conformance" },
    });
    const sendResult = sendResp.result as { status?: unknown } | undefined;
    if (!sendResult || sendResult.status !== "sent") {
      throw new Error(`Expected send status "sent", got ${JSON.stringify(sendResp)}`);
    }

    const shutResp = await rpc(3, "shutdown", {});
    const shutResult = shutResp.result as { ok?: unknown } | undefined;
    if (!shutResult || shutResult.ok !== true) {
      throw new Error(`Expected shutdown { ok: true }, got ${JSON.stringify(shutResp)}`);
    }
    proc.stdin.end();

    const code = await withTimeout(proc.exited, timeoutMs, "IM graceful exit");
    await readerDone;
    if (code !== 0) {
      const stderrText = await stderrPromise;
      throw new Error(`IM exited with code ${code}: ${stderrText}`);
    }
  } finally {
    await forceCleanupProcess(proc, timeoutMs);
  }
}

async function main(): Promise<void> {
  const { manifestPath, config, timeoutMs } = parseArgs(process.argv.slice(2));
  const pluginDir = dirname(manifestPath);
  const manifestJson = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
  const checked = validateManifest(manifestJson);
  if (!checked.ok) {
    throw new Error(`Manifest validation failed for ${manifestPath}: ${checked.error}`);
  }
  const missingConfig = (checked.manifest.requiredConfig ?? []).filter((key) => !(key in config));
  if (missingConfig.length > 0) {
    throw new Error(`Missing requiredConfig key(s) for ${checked.manifest.id}: ${missingConfig.join(", ")}`);
  }

  const tempCwd = mkdtempSync(join(tmpdir(), "rhodium conformance "));
  try {
    if (checked.manifest.kind === "agent") {
      await testAgentPlugin(checked.manifest, pluginDir, tempCwd, config, timeoutMs);
    } else {
      await testImPlugin(checked.manifest, pluginDir, tempCwd, config, timeoutMs);
    }
    process.stdout.write(`PASS ${checked.manifest.kind} plugin conformance: ${checked.manifest.id}\n`);
  } finally {
    rmSync(tempCwd, { recursive: true, force: true });
  }
}

main().catch((err) => {
  process.stderr.write(`FAIL plugin conformance: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
