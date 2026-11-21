import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import {
  AGENT_RESERVED_IDS,
  IM_RESERVED_IDS,
  InvalidJsonLineError,
  LineTooLongError,
  MAX_LINE_BYTES,
  PLUGIN_ID_RE,
  PluginFatalError,
  PluginSendFailedError,
  compareSemver,
  expandPluginCommand,
  isForbiddenClaudeToken,
  isValidSemver,
  logStderr,
  readJsonLines,
  runAgentPlugin,
  runImPlugin,
  validateImCapabilities,
  validateManifest,
  writeJsonLine,
  type AgentContext,
  type AgentInitParams,
  type AgentPlugin,
  type AgentReadyInfo,
  type AgentSendParams,
  type AskAnswer,
  type Capabilities,
  type CommandResult,
  type ImContext,
  type ImInitParams,
  type ImPlugin,
  type OutboundMessageWire,
  type SendResult,
} from "@rhodium-oss/plugin-sdk";

const REPO_ROOT = resolve(import.meta.dir, "..");
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createLineCapture(): { sink: { write(chunk: string): boolean }; lines: () => unknown[]; raw: () => string } {
  let buf = "";
  return {
    sink: {
      write(chunk: string) {
        buf += chunk;
        return true;
      },
    },
    lines() {
      return buf
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line));
    },
    raw() {
      return buf;
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await Bun.sleep(5);
  }
}

describe("packages/plugin-sdk isolation and zero-dependency guarantees", () => {
  test("packages/plugin-sdk/ and scripts/plugin-conformance.ts have zero src/ imports and zero third-party deps", () => {
    const sdkDir = join(REPO_ROOT, "packages", "plugin-sdk");
    const sdkPkg = JSON.parse(readFileSync(join(sdkDir, "package.json"), "utf8")) as Record<string, unknown>;
    expect(sdkPkg.name).toBe("@rhodium-oss/plugin-sdk");
    expect(sdkPkg.dependencies).toBeUndefined();
    expect(sdkPkg.devDependencies).toBeUndefined();
    expect(sdkPkg.peerDependencies).toBeUndefined();

    const filesToCheck = [
      ...readdirSync(sdkDir)
        .filter((name) => name.endsWith(".ts"))
        .map((name) => join(sdkDir, name)),
      join(REPO_ROOT, "scripts", "plugin-conformance.ts"),
    ];

    const importRe = /(?:import|export)\s+(?:type\s+)?(?:[^"'`]*?\s+from\s+)?["']([^"']+)["']/g;
    for (const filePath of filesToCheck) {
      const source = readFileSync(filePath, "utf8");
      for (const match of source.matchAll(importRe)) {
        const spec = match[1]!;
        expect(spec).not.toMatch(/(?:^|\/)src(?:\/|$)/);
        const isAllowed =
          spec.startsWith("node:") ||
          spec.startsWith("./") ||
          spec.startsWith("../packages/plugin-sdk") ||
          spec === "@rhodium-oss/plugin-sdk";
        expect(isAllowed).toBe(true);
      }
    }
  });
});

describe("manifest.ts", () => {
  const docAgentManifest = {
    manifestVersion: 1,
    kind: "agent",
    id: "dsh",
    name: "DeepSeek Harness",
    statusName: "DeepSeek Harness",
    version: "0.1.0",
    protocol: "rh-agent/1",
    minRhodium: "1.5.0",
    program: "dsh",
    command: ["bun", "run", "${PLUGIN_DIR}/dist/index.js"],
    commandByPlatform: {
      win32: ["bun.exe", "run", "${PLUGIN_DIR}/dist/index.js"],
    },
    capabilities: {
      liveApproval: false,
      steer: false,
      commands: ["model", "status", "context"],
    },
    requiredConfig: [],
    optionalConfig: ["fixture"],
  };

  const docWeixinCapabilities = {
    progress: "append",
    buttons: false,
    sendLimit: { kind: "rate", perChatPerSecond: 1 },
    menu: { scope: "global", maxItems: 0 },
    maxTextLength: 2000,
    maxFileBytes: { image: 10485760, file: 26214400 },
    markdown: null,
  };

  const docImManifest = {
    manifestVersion: 1,
    kind: "im",
    id: "weixin",
    name: "微信官方 Bot",
    label: "微信",
    version: "0.1.0",
    protocol: "rh-im/1",
    minRhodium: "1.5.0",
    command: ["bun", "run", "${PLUGIN_DIR}/dist/index.js"],
    capabilities: docWeixinCapabilities,
    requiredConfig: ["token"],
    optionalConfig: ["baseUrl", "cdnBaseUrl", "accountId"],
  };

  test("reserved IDs and regex match spec", () => {
    expect([...AGENT_RESERVED_IDS]).toEqual(["claude", "pi", "codex", "herdr"]);
    expect([...IM_RESERVED_IDS]).toEqual(["qq", "telegram", "feishu", "fake", "me", "web"]);
    expect(PLUGIN_ID_RE.test("dsh")).toBe(true);
    expect(PLUGIN_ID_RE.test("local_im-1")).toBe(true);
    expect(PLUGIN_ID_RE.test("1bad")).toBe(false);
    expect(PLUGIN_ID_RE.test("BadCase")).toBe(false);
    expect(PLUGIN_ID_RE.test("a".repeat(33))).toBe(false);
  });

  test("semver validation and comparison", () => {
    expect(isValidSemver("1.5.0")).toBe(true);
    expect(isValidSemver("0.1.0")).toBe(true);
    expect(isValidSemver("1.5.0-rc.1")).toBe(true);
    expect(isValidSemver("1.5")).toBe(false);
    expect(isValidSemver("v1.5.0")).toBe(false);
    expect(isValidSemver("01.5.0")).toBe(false);

    expect(compareSemver("1.5.0", "1.5.0")).toBe(0);
    expect(compareSemver("1.6.0", "1.5.0")).toBeGreaterThan(0);
    expect(compareSemver("1.4.9", "1.5.0")).toBeLessThan(0);
    expect(compareSemver("1.5.0", "1.5.0-alpha.1")).toBeGreaterThan(0);
    expect(compareSemver("1.5.0-alpha.2", "1.5.0-alpha.1")).toBeGreaterThan(0);
  });

  test("validates verbatim agent and im examples from docs/spec/plugins.md", () => {
    const agentRes = validateManifest(docAgentManifest);
    expect(agentRes.ok).toBe(true);

    const capsRes = validateImCapabilities(docWeixinCapabilities);
    expect(capsRes.ok).toBe(true);

    const imRes = validateManifest(docImManifest);
    expect(imRes.ok).toBe(true);
  });

  test("rejects reserved IDs including herdr and built-in IM names", () => {
    for (const id of ["claude", "pi", "codex", "herdr"]) {
      const res = validateManifest({ ...docAgentManifest, id });
      expect(res.ok).toBe(false);
    }
    for (const id of ["qq", "telegram", "feishu", "fake", "me", "web"]) {
      const res = validateManifest({ ...docImManifest, id });
      expect(res.ok).toBe(false);
    }
  });

  test("isForbiddenClaudeToken rejects claude, claude.exe, claude.cmd case-insensitively across paths, =value, and shell tokens", () => {
    const badTokens = [
      "claude",
      "CLAUDE",
      "claude.exe",
      "Claude.EXE",
      "claude.cmd",
      "CLAUDE.CMD",
      "/usr/local/bin/claude",
      "C:\\Users\\demo\\bin\\Claude.exe",
      "../tools/claude.cmd",
      "--program=claude",
      "--bin=/opt/claude.exe",
      "EXEC=C:\\bin\\claude.cmd",
      "sh -c 'claude -p hello'",
      'bash -lc "exec /usr/bin/Claude.EXE && true"',
      "a;claude.cmd",
      "$(claude)",
    ];
    for (const token of badTokens) {
      expect(isForbiddenClaudeToken(token)).toBe(true);
    }

    const goodTokens = ["dsh", "bun", "agy", "my-claude-helper", "${PLUGIN_DIR}/dist/index.js", "/tmp/claude-notes/index.js"];
    for (const token of goodTokens) {
      expect(isForbiddenClaudeToken(token)).toBe(false);
    }

    expect(validateManifest({ ...docAgentManifest, program: "Claude.EXE" }).ok).toBe(false);
    expect(validateManifest({ ...docAgentManifest, command: ["--bin=/usr/bin/claude"] }).ok).toBe(false);
    expect(
      validateManifest({
        ...docAgentManifest,
        commandByPlatform: { win32: ["cmd", "/c", "C:\\bin\\claude.cmd"] },
      }).ok,
    ).toBe(false);
  });

  test("rejects mismatched agent vs im fields (statusName vs label, protocol, program)", () => {
    expect(validateManifest({ ...docAgentManifest, protocol: "rh-im/1" }).ok).toBe(false);
    expect(validateManifest({ ...docImManifest, protocol: "rh-agent/1" }).ok).toBe(false);
    const missingStatusName = { ...docAgentManifest, statusName: undefined, label: "Wrong" };
    expect(validateManifest(missingStatusName).ok).toBe(false);
    const missingLabel = { ...docImManifest, label: undefined, statusName: "Wrong" };
    expect(validateManifest(missingLabel).ok).toBe(false);
    expect(validateManifest({ ...docImManifest, program: "bad" }).ok).toBe(false);
  });

  test("validateImCapabilities enforces strict contract including qq_quota rejection and explicit markdown", () => {
    expect(
      validateImCapabilities({
        ...docWeixinCapabilities,
        sendLimit: { kind: "qq_quota" },
      }).ok,
    ).toBe(false);

    expect(
      validateImCapabilities({
        ...docWeixinCapabilities,
        sendLimit: { kind: "rate", perChatPerSecond: 0 },
      }).ok,
    ).toBe(false);

    const omittedMarkdown = { ...docWeixinCapabilities } as Record<string, unknown>;
    delete omittedMarkdown.markdown;
    expect(validateImCapabilities(omittedMarkdown).ok).toBe(false);

    expect(
      validateImCapabilities({
        ...docWeixinCapabilities,
        progress: "stream",
      }).ok,
    ).toBe(false);

    expect(
      validateImCapabilities({
        ...docWeixinCapabilities,
        buttons: "markdown",
        markdown: { extensions: ["heading", "html"], links: "http", literal: true, details: true },
      }).ok,
    ).toBe(true);

    expect(
      validateImCapabilities({
        ...docWeixinCapabilities,
        markdown: { extensions: ["unknown-ext"] },
      }).ok,
    ).toBe(false);
  });

  test("expandPluginCommand resolves ${PLUGIN_DIR} across platforms and preserves spaces without shell splitting", () => {
    const manifest = validateManifest(docAgentManifest);
    expect(manifest.ok).toBe(true);
    if (!manifest.ok) return;

    const linuxExpanded = expandPluginCommand(manifest.manifest, "/tmp/my plugins/dsh plugin", "linux");
    expect(linuxExpanded).toEqual(["bun", "run", "/tmp/my plugins/dsh plugin/dist/index.js"]);

    const winExpanded = expandPluginCommand(manifest.manifest, "C:\\My Plugins\\dsh plugin", "win32");
    expect(winExpanded).toEqual(["bun.exe", "run", "C:\\My Plugins\\dsh plugin\\dist\\index.js"]);

    const darwinManifest = validateManifest({
      ...docAgentManifest,
      command: ["${PLUGIN_DIR}/bin/agent tool", "--cfg=${PLUGIN_DIR}/my cfg/a.json"],
    });
    expect(darwinManifest.ok).toBe(true);
    if (!darwinManifest.ok) return;
    expect(expandPluginCommand(darwinManifest.manifest, "/Applications/My Plugins/dsh", "darwin")).toEqual([
      "/Applications/My Plugins/dsh/bin/agent tool",
      "--cfg=/Applications/My Plugins/dsh/my cfg/a.json",
    ]);
  });
});

describe("stdio.ts", () => {
  test("MAX_LINE_BYTES is 64 MiB and logStderr never touches stdout", () => {
    expect(MAX_LINE_BYTES).toBe(64 * 1024 * 1024);
    const stderr = createLineCapture();
    logStderr("hello stderr", stderr.sink);
    expect(stderr.raw()).toBe("hello stderr\n");
  });

  test("readJsonLines handles CRLF, blank lines, EOF without newline, and split multi-byte UTF-8 chunks", async () => {
    const stream = new PassThrough();
    const received: unknown[] = [];

    const first = Buffer.from(`${JSON.stringify({ text: "你好世界🚀" })}\r\n`, "utf8");
    const blank = Buffer.from("\r\n   \n", "utf8");
    const last = Buffer.from(JSON.stringify({ eof: true }), "utf8");

    const splitAt = first.indexOf("界") + 1; // split mid-UTF-8 character
    const reading = readJsonLines(stream, {
      onMessage(msg) {
        received.push(msg);
      },
    });

    stream.write(first.subarray(0, splitAt));
    stream.write(first.subarray(splitAt));
    stream.write(blank);
    stream.end(last);

    await reading;
    expect(received).toEqual([{ text: "你好世界🚀" }, { eof: true }]);
  });

  test("readJsonLines dispatches onMessage non-blockingly", async () => {
    const stream = new PassThrough();
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolvePromise) => {
      releaseFirst = resolvePromise;
    });
    const events: string[] = [];

    const reading = readJsonLines(stream, {
      async onMessage(msg) {
        const m = msg as { seq: number };
        events.push(`start:${m.seq}`);
        if (m.seq === 1) {
          await firstBlocked;
          events.push("end:1");
        } else {
          releaseFirst();
          events.push("end:2");
        }
      },
    });

    stream.write(`${JSON.stringify({ seq: 1 })}\n`);
    await waitFor(() => events.includes("start:1"));
    stream.end(`${JSON.stringify({ seq: 2 })}\n`);

    await reading;
    expect(events).toEqual(["start:1", "start:2", "end:2", "end:1"]);
  });

  test("readJsonLines rejects invalid JSON and overlong lines (exact byte count before newline)", async () => {
    const badJsonStream = new PassThrough();
    badJsonStream.end("{not json}\n");
    await expect(readJsonLines(badJsonStream, { onMessage() {} })).rejects.toBeInstanceOf(InvalidJsonLineError);

    const tooLongStream = new PassThrough();
    const exactOkStream = new PassThrough();
    const limit = 32;
    const okLine = Buffer.from('{"a":"' + "x".repeat(limit - 8) + '"}\r\n', "utf8"); // 32 bytes before \n? Wait: 33 bytes with \r
    const okExact = Buffer.from('{"a":"' + "x".repeat(limit - 8) + '"}\n', "utf8"); // exactly 32 bytes before \n
    expect(okExact.length - 1).toBe(limit);
    const seen: unknown[] = [];
    exactOkStream.end(okExact);
    await readJsonLines(exactOkStream, {
      maxLineBytes: limit,
      onMessage(m) {
        seen.push(m);
      },
    });
    expect(seen).toEqual([{ a: "x".repeat(limit - 8) }]);

    const tooLongLine = Buffer.from('{"a":"' + "x".repeat(limit) + '"}\n', "utf8");
    tooLongStream.end(tooLongLine);
    await expect(readJsonLines(tooLongStream, { maxLineBytes: limit, onMessage() {} })).rejects.toBeInstanceOf(LineTooLongError);

    // Unused variable silence guard
    expect(okLine.length).toBeGreaterThan(limit);
  });

  test("writeJsonLine serializes one JSON line", () => {
    const sink = createLineCapture();
    writeJsonLine(sink.sink, { type: "ready", proto: 1 });
    expect(sink.lines()).toEqual([{ type: "ready", proto: 1 }]);
  });
});

describe("agent.ts (runAgentPlugin)", () => {
  test("init -> ready, non-blocking answer/interrupt/close while send awaits ask, command_result, and single bounded close", async () => {
    const stdin = new PassThrough();
    const stdout = createLineCapture();
    const stderr = createLineCapture();
    let exitCode: number | undefined;
    let closeCalls = 0;
    let resolveAsk!: (ans: AskAnswer) => void;
    let askPending = new Promise<AskAnswer>((res) => {
      resolveAsk = res;
    });

    const plugin: AgentPlugin = {
      async init(params: AgentInitParams): Promise<AgentReadyInfo> {
        expect(params.proto).toBe(1);
        return {
          session: "new" in params.session ? params.session.new : params.session.resume,
          capabilities: { liveApproval: false, steer: false, commands: ["status"] },
        };
      },
      async send(msg: AgentSendParams, ctx: AgentContext): Promise<void> {
        ctx.taken(msg.id);
        ctx.turnStart(msg.id);
        ctx.toolStart("tc-1", "demo_tool", { q: msg.text });
        ctx.ask({ requestId: "req-1", kind: "permission", tool: "demo_tool", input: { q: msg.text }, toolUse: "tc-1" });
        const ans = await askPending;
        const allowed = ans.kind === "permission" && ans.allow;
        ctx.item({ kind: "tool", id: "tc-1", name: "demo_tool", input: { q: msg.text }, result: { text: allowed ? "ok" : "denied" } });
        ctx.textDelta("done");
        ctx.item({ kind: "message", text: "done" });
        ctx.turnEnd("done");
      },
      async answer(_requestId: string, ans: AskAnswer): Promise<void> {
        resolveAsk(ans);
      },
      async interrupt(ctx: AgentContext): Promise<void> {
        ctx.turnEnd();
      },
      async command(name: string): Promise<CommandResult> {
        return { command: "status", model: `echo:${name}`, context: { usedTokens: 10, maxTokens: 100 } };
      },
      async close(): Promise<void> {
        closeCalls += 1;
      },
    };

    const runPromise = runAgentPlugin(plugin, {
      stdin,
      stdout: stdout.sink,
      stderr: stderr.sink,
      exit(code) {
        exitCode = code;
      },
      registerSignals: false,
    });

    stdin.write(
      JSON.stringify({
        type: "init",
        proto: 1,
        conv: "c-1",
        session: { new: "s-1" },
        cwd: "/tmp/demo",
        systemPromptFile: "/tmp/prompt.md",
        program: "echo",
        approval: false,
        config: {},
      }) + "\n",
    );
    await waitFor(() => stdout.lines().some((m) => (m as { type: string }).type === "ready"));

    stdin.write(JSON.stringify({ type: "send", id: "in-1", text: "hi", human: true, mode: "turn" }) + "\n");
    await waitFor(() => stdout.lines().some((m) => (m as { type: string }).type === "ask"));

    // While send() is still awaiting askPending, answer arrives and must be dispatched immediately
    stdin.write(JSON.stringify({ type: "answer", requestId: "req-1", answer: { kind: "permission", allow: true } }) + "\n");
    await waitFor(() => stdout.lines().some((m) => (m as { type: string }).type === "turn_end"));

    stdin.write(JSON.stringify({ type: "command", id: "cmd-1", name: "status", args: "" }) + "\n");
    await waitFor(() => stdout.lines().some((m) => (m as { type: string }).type === "command_result"));

    stdin.write(JSON.stringify({ type: "close" }) + "\n");
    stdin.end();
    await runPromise;

    expect(exitCode).toBe(0);
    expect(closeCalls).toBe(1);
    const out = stdout.lines() as Array<{ type: string; [k: string]: unknown }>;
    expect(out.some((m) => m.type === "ask_resolved" && m.requestId === "req-1")).toBe(true);
    expect(out.some((m) => m.type === "command_result" && m.id === "cmd-1" && m.ok === true)).toBe(true);
    expect(stderr.raw()).toBe("");
  });

  test("answer rejection emits ask_cancel + unrecoverable error and calls interrupt; interrupt/close while send awaits ask works non-blockingly", async () => {
    const stdin = new PassThrough();
    const stdout = createLineCapture();
    const stderr = createLineCapture();
    let exitCode: number | undefined;
    let interrupted = false;
    let closeCalls = 0;

    const plugin: AgentPlugin = {
      async init(): Promise<AgentReadyInfo> {
        return { session: "s-2" };
      },
      async send(_msg: AgentSendParams, ctx: AgentContext): Promise<void> {
        ctx.ask({ requestId: "req-fail", kind: "question", tool: "ask_user", input: {} });
        await new Promise<void>(() => {
          // Intentionally keep send() awaiting until interrupt/close
        });
      },
      async answer(): Promise<void> {
        throw new Error("downstream rejected answer");
      },
      async interrupt(ctx: AgentContext): Promise<void> {
        interrupted = true;
        ctx.turnEnd();
      },
      async close(): Promise<void> {
        closeCalls += 1;
        // Intentionally hang longer than closeTimeoutMs to verify bounded close
        await new Promise(() => {});
      },
    };

    const runPromise = runAgentPlugin(plugin, {
      stdin,
      stdout: stdout.sink,
      stderr: stderr.sink,
      closeTimeoutMs: 50,
      exit(code) {
        exitCode = code;
      },
      registerSignals: false,
    });

    stdin.write(
      JSON.stringify({
        type: "init",
        proto: 1,
        conv: "c-2",
        session: { new: "s-2" },
        cwd: "/tmp/demo",
        systemPromptFile: "/tmp/prompt.md",
        approval: false,
        config: {},
      }) + "\n",
    );
    await waitFor(() => stdout.lines().some((m) => (m as { type: string }).type === "ready"));

    stdin.write(JSON.stringify({ type: "send", id: "in-2", text: "go", human: true, mode: "turn" }) + "\n");
    await waitFor(() => stdout.lines().some((m) => (m as { type: string }).type === "ask"));

    stdin.write(
      JSON.stringify({
        type: "answer",
        requestId: "req-fail",
        answer: { kind: "question", answers: { q: "a" } },
      }) + "\n",
    );
    await waitFor(() => interrupted && stdout.lines().some((m) => (m as { type: string }).type === "turn_end"));

    const out = stdout.lines() as Array<{ type: string; [k: string]: unknown }>;
    expect(out.some((m) => m.type === "ask_resolved")).toBe(false);
    expect(out.some((m) => m.type === "ask_cancel" && m.requestId === "req-fail")).toBe(true);
    expect(out.some((m) => m.type === "error" && m.recoverable === false)).toBe(true);
    expect(stderr.raw()).toContain("downstream rejected answer");

    // Trigger close twice + EOF: close() runs at most once and respects closeTimeoutMs
    stdin.write(JSON.stringify({ type: "close" }) + "\n");
    stdin.write(JSON.stringify({ type: "close" }) + "\n");
    stdin.end();
    await runPromise;
    expect(closeCalls).toBe(1);
    expect(exitCode).toBe(0);
  });

  test("init error emits fatal with retryable flag and exits non-zero", async () => {
    const stdin = new PassThrough();
    const stdout = createLineCapture();
    const stderr = createLineCapture();
    let exitCode: number | undefined;

    const plugin: AgentPlugin = {
      async init(): Promise<AgentReadyInfo> {
        throw new PluginFatalError("missing downstream binary", { retryable: false });
      },
      async send() {},
      async interrupt() {},
    };

    const runPromise = runAgentPlugin(plugin, {
      stdin,
      stdout: stdout.sink,
      stderr: stderr.sink,
      exit(code) {
        exitCode = code;
      },
      registerSignals: false,
    });

    stdin.write(
      JSON.stringify({
        type: "init",
        proto: 1,
        conv: "c-err",
        session: { new: "s-err" },
        cwd: "/tmp",
        systemPromptFile: "/tmp/p.md",
        approval: false,
        config: {},
      }) + "\n",
    );

    await runPromise;
    expect(exitCode).toBe(1);
    expect(stdout.lines()).toEqual([{ type: "fatal", message: "missing downstream binary", retryable: false }]);
    expect(stderr.raw()).toContain("missing downstream binary");
  });

  test("PluginFatalError during answer immediately runs single bounded close and exits 1", async () => {
    const stdin = new PassThrough();
    const stdout = createLineCapture();
    const stderr = createLineCapture();
    let exitCode: number | undefined;
    let closeCalls = 0;

    const plugin: AgentPlugin = {
      async init(): Promise<AgentReadyInfo> {
        return { session: "s-fatal" };
      },
      async send() {},
      async interrupt() {
        throw new Error("should not be called when answer throws PluginFatalError");
      },
      async answer() {
        throw new PluginFatalError("unrecoverable downstream crash", { retryable: false });
      },
      async close() {
        closeCalls += 1;
      },
    };

    const runPromise = runAgentPlugin(plugin, {
      stdin,
      stdout: stdout.sink,
      stderr: stderr.sink,
      exit(code) {
        exitCode = code;
      },
      registerSignals: false,
    });

    stdin.write(
      JSON.stringify({
        type: "init",
        proto: 1,
        conv: "c-f",
        session: { new: "s-fatal" },
        cwd: "/tmp",
        systemPromptFile: "/tmp/p.md",
        approval: false,
        config: {},
      }) + "\n",
    );
    await waitFor(() => stdout.lines().some((m) => (m as { type: string }).type === "ready"));

    stdin.write(JSON.stringify({ type: "answer", requestId: "req-f", answer: { kind: "permission", allow: false } }) + "\n");
    await runPromise;

    expect(exitCode).toBe(1);
    expect(closeCalls).toBe(1);
    const out = stdout.lines() as Array<{ type: string; [k: string]: unknown }>;
    expect(out.some((m) => m.type === "ask_cancel" && m.requestId === "req-f")).toBe(true);
    expect(out.some((m) => m.type === "error" && m.recoverable === false)).toBe(true);
  });

  test("queues post-init messages while init() is pending and handles signal cleanup once", async () => {
    const stdin = new PassThrough();
    const stdout = createLineCapture();
    const stderr = createLineCapture();
    const events: string[] = [];
    let releaseInit!: () => void;
    const initGate = new Promise<void>((res) => {
      releaseInit = res;
    });
    let triggerSignal!: (sig: string) => void;
    let unsubscribed = false;
    let exitCode: number | undefined;
    let closeCalls = 0;

    const plugin: AgentPlugin = {
      async init(): Promise<AgentReadyInfo> {
        await initGate;
        events.push("init");
        return { session: "s-queued" };
      },
      async send(msg: AgentSendParams, ctx: AgentContext): Promise<void> {
        events.push(`send:${msg.text}`);
        ctx.turnEnd(`re:${msg.text}`);
      },
      async interrupt() {},
      async close() {
        closeCalls += 1;
      },
    };

    const runPromise = runAgentPlugin(plugin, {
      stdin,
      stdout: stdout.sink,
      stderr: stderr.sink,
      exit(code) {
        exitCode = code;
      },
      registerSignals(onSignal) {
        triggerSignal = onSignal;
        return () => {
          unsubscribed = true;
        };
      },
    });

    stdin.write(
      JSON.stringify({
        type: "init",
        proto: 1,
        conv: "c-q",
        session: { new: "s-queued" },
        cwd: "/tmp",
        systemPromptFile: "/tmp/p.md",
        approval: false,
        config: {},
      }) + "\n",
    );
    // Send two messages BEFORE ready is emitted
    stdin.write(JSON.stringify({ type: "send", id: "in-q1", text: "one", human: true, mode: "turn" }) + "\n");
    stdin.write(JSON.stringify({ type: "send", id: "in-q2", text: "two", human: true, mode: "turn" }) + "\n");
    await Bun.sleep(10);
    expect(events).toEqual([]);

    releaseInit();
    await waitFor(() => stdout.lines().filter((m) => (m as { type: string }).type === "turn_end").length === 2);
    expect(events).toEqual(["init", "send:one", "send:two"]);

    triggerSignal("SIGTERM");
    triggerSignal("SIGINT");
    await runPromise;
    expect(closeCalls).toBe(1);
    expect(unsubscribed).toBe(true);
    expect(exitCode).toBe(0);
  });

  test("EOF during hung init() runs single bounded close() immediately and resolves cleanly", async () => {
    const stdin = new PassThrough();
    const stdout = createLineCapture();
    const stderr = createLineCapture();
    let initStarted = false;
    let closeCalls = 0;
    let exitCode: number | undefined;

    const plugin: AgentPlugin = {
      async init(): Promise<AgentReadyInfo> {
        initStarted = true;
        return await new Promise<AgentReadyInfo>(() => {});
      },
      async send() {},
      async interrupt() {},
      async close() {
        closeCalls += 1;
        await new Promise(() => {});
      },
    };

    const startedAt = Date.now();
    const runPromise = runAgentPlugin(plugin, {
      stdin,
      stdout: stdout.sink,
      stderr: stderr.sink,
      closeTimeoutMs: 50,
      exit(code) {
        exitCode = code;
      },
      registerSignals: false,
    });

    stdin.write(
      JSON.stringify({
        type: "init",
        proto: 1,
        conv: "c-eof-init",
        session: { new: "s-eof-init" },
        cwd: "/tmp",
        systemPromptFile: "/tmp/p.md",
        approval: false,
        config: {},
      }) + "\n",
    );
    await waitFor(() => initStarted);
    stdin.end();

    const code = await runPromise;
    expect(Date.now() - startedAt).toBeLessThan(1500);
    expect(code).toBe(0);
    expect(exitCode).toBe(0);
    expect(closeCalls).toBe(1);
  }, 2000);
});

describe("im.ts (runImPlugin)", () => {
  const validImCaps: Capabilities = {
    progress: "append",
    buttons: false,
    sendLimit: { kind: "rate", perChatPerSecond: 1 },
    menu: { scope: "global", maxItems: 0 },
    maxTextLength: 2000,
    maxFileBytes: { image: 1024 * 1024, file: 4 * 1024 * 1024 },
    markdown: null,
  };

  test("concurrent ctx.inbound() waits for { ok: true } while handling reverse fetch_attachment without deadlock", async () => {
    const stdin = new PassThrough();
    const stdout = createLineCapture();
    const stderr = createLineCapture();
    let exitCode: number | undefined;
    let inboundDone = false;
    let ctxRef!: ImContext;
    let shutdownCalls = 0;

    const plugin: ImPlugin = {
      async init(_params: ImInitParams, ctx: ImContext): Promise<Capabilities> {
        ctxRef = ctx;
        ctx.connected(true);
        return validImCaps;
      },
      async send(): Promise<SendResult> {
        return { status: "sent", messageId: "m-1" };
      },
      async fetchAttachment(attachmentId: string, destPath: string) {
        return { ok: true, size: attachmentId.length + destPath.length, mimeType: "image/png" };
      },
      async shutdown() {
        shutdownCalls += 1;
      },
    };

    const runPromise = runImPlugin(plugin, {
      stdin,
      stdout: stdout.sink,
      stderr: stderr.sink,
      exit(code) {
        exitCode = code;
      },
      registerSignals: false,
    });

    stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "init",
        params: { proto: 1, botId: "b-1", botName: "test-im", config: {} },
      }) + "\n",
    );
    await waitFor(() => stdout.lines().some((m) => (m as { id?: unknown }).id === 1));

    // Plugin initiates inbound with attachment
    const inboundPromise = ctxRef
      .inbound({
        chat: "u-1",
        messageId: "msg-1",
        sender: "u-1",
        text: "see image",
        at: 1763690000000,
        attachments: [{ id: "att-9", kind: "image", name: "photo.png", mimeType: "image/png" }],
      })
      .then(() => {
        inboundDone = true;
      });

    await waitFor(() => stdout.lines().some((m) => (m as { method?: string }).method === "inbound"));
    const inboundReq = stdout.lines().find((m) => (m as { method?: string }).method === "inbound") as { id: string | number };
    // Must NOT resolve before core sends { ok: true }
    await Bun.sleep(20);
    expect(inboundDone).toBe(false);

    // Core calls fetch_attachment BEFORE acknowledging inbound
    stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 50,
        method: "fetch_attachment",
        params: { attachmentId: "att-9", destPath: "/tmp/att-9.png" },
      }) + "\n",
    );
    await waitFor(() => stdout.lines().some((m) => (m as { id?: unknown }).id === 50));
    const fetchResp = stdout.lines().find((m) => (m as { id?: unknown }).id === 50) as { result: { ok: boolean; mimeType?: string } };
    expect(fetchResp.result.ok).toBe(true);
    expect(fetchResp.result.mimeType).toBe("image/png");

    // Now core acknowledges inbound
    stdin.write(JSON.stringify({ jsonrpc: "2.0", id: inboundReq.id, result: { ok: true } }) + "\n");
    await inboundPromise;
    expect(inboundDone).toBe(true);

    // Unimplemented profile defaults to {}
    stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 51, method: "profile", params: { you: "u-1" } }) + "\n");
    await waitFor(() => stdout.lines().some((m) => (m as { id?: unknown }).id === 51));
    const profileResp = stdout.lines().find((m) => (m as { id?: unknown }).id === 51) as { result: unknown };
    expect(profileResp.result).toEqual({});

    stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 99, method: "shutdown", params: {} }) + "\n");
    stdin.end();
    await runPromise;

    expect(shutdownCalls).toBe(1);
    expect(exitCode).toBe(0);
    expect(stdout.lines().some((m) => (m as { id?: unknown; result?: unknown }).id === 99)).toBe(true);
  });

  test("preserves unknown send outcomes (explicit unknown & uncaught errors) vs explicit failed & PluginSendFailedError", async () => {
    const stdin = new PassThrough();
    const stdout = createLineCapture();
    const stderr = createLineCapture();
    let exitCode: number | undefined;

    const plugin: ImPlugin = {
      async init(): Promise<Capabilities> {
        return validImCaps;
      },
      async send(chat: string, message: OutboundMessageWire): Promise<SendResult> {
        if (chat === "explicit-unknown") return { status: "unknown", error: "receipt lost" };
        if (chat === "network-throw") throw new Error("ECONNRESET");
        if (chat === "explicit-failed") return { status: "failed", error: "blocked by policy" };
        if (chat === "send-failed-err") throw new PluginSendFailedError("missing context_token", { refused: true, flood: true });
        return { status: "sent", messageId: `sent:${message.text}` };
      },
    };

    const runPromise = runImPlugin(plugin, {
      stdin,
      stdout: stdout.sink,
      stderr: stderr.sink,
      exit(code) {
        exitCode = code;
      },
      registerSignals: false,
    });

    stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "init", params: { proto: 1, botId: "b", botName: "b", config: {} } }) + "\n");
    await waitFor(() => stdout.lines().some((m) => (m as { id?: unknown }).id === 1));

    const cases = [
      { id: 10, chat: "explicit-unknown" },
      { id: 11, chat: "network-throw" },
      { id: 12, chat: "explicit-failed" },
      { id: 13, chat: "send-failed-err" },
    ];
    for (const c of cases) {
      stdin.write(JSON.stringify({ jsonrpc: "2.0", id: c.id, method: "send", params: { chat: c.chat, message: { text: "hi" } } }) + "\n");
    }
    await waitFor(() => stdout.lines().some((m) => (m as { id?: unknown }).id === 13));

    const byId = new Map((stdout.lines() as Array<{ id?: number; result?: SendResult }>).filter((m) => m.id !== undefined).map((m) => [m.id!, m.result]));
    expect(byId.get(10)).toEqual({ status: "unknown", error: "receipt lost" });
    expect(byId.get(11)).toEqual({ status: "unknown", error: "ECONNRESET" });
    expect(byId.get(12)).toEqual({ status: "failed", error: "blocked by policy" });
    expect(byId.get(13)).toEqual({ status: "failed", error: "missing context_token", refused: true, flood: true });
    expect(stderr.raw()).toContain("ECONNRESET");

    stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 20, method: "shutdown", params: {} }) + "\n");
    stdin.end();
    await runPromise;
    expect(exitCode).toBe(0);
  });

  test("rejects invalid IM capabilities in init and exits non-zero", async () => {
    const stdin = new PassThrough();
    const stdout = createLineCapture();
    const stderr = createLineCapture();
    let exitCode: number | undefined;

    const plugin: ImPlugin = {
      async init(): Promise<Capabilities> {
        return { ...validImCaps, sendLimit: { kind: "qq_quota" } } as unknown as Capabilities;
      },
      async send(): Promise<SendResult> {
        return { status: "sent" };
      },
    };

    const runPromise = runImPlugin(plugin, {
      stdin,
      stdout: stdout.sink,
      stderr: stderr.sink,
      exit(code) {
        exitCode = code;
      },
      registerSignals: false,
    });

    stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "init", params: { proto: 1, botId: "b", botName: "b", config: {} } }) + "\n");
    await runPromise;
    expect(exitCode).toBe(1);
    const errResp = stdout.lines()[0] as { id: number; error: { message: string } };
    expect(errResp.id).toBe(1);
    expect(errResp.error.message).toContain("qq_quota");
  });

  test("preserves unknown outcomes on edit/drop_buttons, supports keptGet/keptSet, and shuts down once on signal", async () => {
    const stdin = new PassThrough();
    const stdout = createLineCapture();
    const stderr = createLineCapture();
    let ctxRef!: ImContext;
    let triggerSignal!: (sig: string) => void;
    let shutdownCalls = 0;
    let exitCode: number | undefined;

    const plugin: ImPlugin = {
      async init(_p, ctx): Promise<Capabilities> {
        ctxRef = ctx;
        return validImCaps;
      },
      async send(): Promise<SendResult> {
        return { status: "sent", messageId: "m1" };
      },
      async edit(): Promise<SendResult> {
        throw new Error("edit timeout");
      },
      async dropButtons(): Promise<SendResult> {
        return { status: "unknown", error: "drop receipt lost" };
      },
      async shutdown() {
        shutdownCalls += 1;
      },
    };

    const runPromise = runImPlugin(plugin, {
      stdin,
      stdout: stdout.sink,
      stderr: stderr.sink,
      exit(code) {
        exitCode = code;
      },
      registerSignals(onSignal) {
        triggerSignal = onSignal;
        return () => {};
      },
    });

    stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "init", params: { proto: 1, botId: "b", botName: "b", config: {} } }) + "\n");
    await waitFor(() => stdout.lines().some((m) => (m as { id?: unknown }).id === 1));

    const keptPromise = ctxRef.keptGet("cursor");
    await waitFor(() => stdout.lines().some((m) => (m as { method?: string }).method === "kept_get"));
    const keptReq = stdout.lines().find((m) => (m as { method?: string }).method === "kept_get") as { id: string };
    stdin.write(JSON.stringify({ jsonrpc: "2.0", id: keptReq.id, result: { value: "c-42" } }) + "\n");
    expect(await keptPromise).toBe("c-42");

    stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "edit", params: { chat: "u", messageId: "m1", message: { text: "x" } } }) + "\n");
    stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "drop_buttons", params: { chat: "u", messageId: "m1" } }) + "\n");
    await waitFor(() => stdout.lines().some((m) => (m as { id?: unknown }).id === 3));

    const byId = new Map((stdout.lines() as Array<{ id?: number; result?: SendResult }>).filter((m) => m.id !== undefined).map((m) => [m.id!, m.result]));
    expect(byId.get(2)).toEqual({ status: "unknown", error: "edit timeout" });
    expect(byId.get(3)).toEqual({ status: "unknown", error: "drop receipt lost" });

    triggerSignal("SIGINT");
    triggerSignal("SIGTERM");
    await runPromise;
    expect(shutdownCalls).toBe(1);
    expect(exitCode).toBe(0);
  });

  test("EOF during pending init() awaiting keptGet rejects pending RPC and runs single bounded shutdown()", async () => {
    const stdin = new PassThrough();
    const stdout = createLineCapture();
    const stderr = createLineCapture();
    let keptRejected = false;
    let shutdownCalls = 0;
    let exitCode: number | undefined;

    const plugin: ImPlugin = {
      async init(_params, ctx): Promise<Capabilities> {
        try {
          await ctx.keptGet("sync_buf");
        } catch {
          keptRejected = true;
        }
        return validImCaps;
      },
      async send(): Promise<SendResult> {
        return { status: "sent" };
      },
      async shutdown() {
        shutdownCalls += 1;
        await new Promise(() => {});
      },
    };

    const startedAt = Date.now();
    const runPromise = runImPlugin(plugin, {
      stdin,
      stdout: stdout.sink,
      stderr: stderr.sink,
      shutdownTimeoutMs: 50,
      exit(code) {
        exitCode = code;
      },
      registerSignals: false,
    });

    stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "init",
        params: { proto: 1, botId: "b", botName: "b", config: {} },
      }) + "\n",
    );
    await waitFor(() => stdout.lines().some((m) => (m as { method?: string }).method === "kept_get"));
    stdin.end();

    const code = await runPromise;
    expect(Date.now() - startedAt).toBeLessThan(1500);
    expect(keptRejected).toBe(true);
    expect(shutdownCalls).toBe(1);
    expect(code).toBe(0);
    expect(exitCode).toBe(0);
  }, 2000);

  test("ctx.inbound() rejects when core responds with { ok: false }", async () => {
    const stdin = new PassThrough();
    const stdout = createLineCapture();
    const stderr = createLineCapture();
    let ctxRef!: ImContext;

    const plugin: ImPlugin = {
      async init(_p, ctx): Promise<Capabilities> {
        ctxRef = ctx;
        return validImCaps;
      },
      async send(): Promise<SendResult> {
        return { status: "sent" };
      },
    };

    const runPromise = runImPlugin(plugin, {
      stdin,
      stdout: stdout.sink,
      stderr: stderr.sink,
      exit() {},
      registerSignals: false,
    });

    stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "init", params: { proto: 1, botId: "b", botName: "b", config: {} } }) + "\n");
    await waitFor(() => stdout.lines().some((m) => (m as { id?: unknown }).id === 1));

    const inboundPromise = ctxRef.inbound({
      chat: "u-1",
      messageId: "m-bad",
      sender: "u-1",
      text: "hello",
      at: 1763690000000,
    });
    await waitFor(() => stdout.lines().some((m) => (m as { method?: string }).method === "inbound"));
    const inboundReq = stdout.lines().find((m) => (m as { method?: string }).method === "inbound") as { id: string | number };
    stdin.write(JSON.stringify({ jsonrpc: "2.0", id: inboundReq.id, result: { ok: false } }) + "\n");

    await expect(inboundPromise).rejects.toThrow(/ok:\s*true/i);

    stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "shutdown", params: {} }) + "\n");
    stdin.end();
    await runPromise;
  });
});

describe("scripts/plugin-conformance.ts and examples/plugins", () => {
  async function runConformance(
    manifestPath: string,
    extraEnv?: Record<string, string>,
    timeoutArg = "10000",
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn(["bun", "scripts/plugin-conformance.ts", "--manifest", manifestPath, "--timeout", timeoutArg], {
      cwd: REPO_ROOT,
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  }

  test("echo-agent interrupt stops cancelled [ask] turn cleanly with single turn_end and no trailing reply", async () => {
    const proc = Bun.spawn(["bun", "run", join(REPO_ROOT, "examples", "plugins", "echo-agent", "index.ts")], {
      cwd: REPO_ROOT,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const out: Array<Record<string, unknown>> = [];
    const readerDone = readJsonLines<Record<string, unknown>>(proc.stdout, {
      onMessage(msg) {
        out.push(msg);
      },
    });
    try {
      proc.stdin.write(
        JSON.stringify({
          type: "init",
          proto: 1,
          conv: "c-echo-int",
          session: { new: "s-echo-int" },
          cwd: REPO_ROOT,
          systemPromptFile: join(REPO_ROOT, "README.md"),
          program: "echo-agent",
          approval: false,
          config: {},
        }) + "\n",
      );
      await waitFor(() => out.some((m) => m.type === "ready"));

      proc.stdin.write(JSON.stringify({ type: "send", id: "in-ask", text: "[ask] hello", human: true, mode: "turn" }) + "\n");
      await waitFor(() => out.some((m) => m.type === "ask"));

      proc.stdin.write(JSON.stringify({ type: "interrupt" }) + "\n");
      await waitFor(() => out.some((m) => m.type === "turn_end"));
      await Bun.sleep(30);

      proc.stdin.write(JSON.stringify({ type: "close" }) + "\n");
      proc.stdin.end();
      const code = await proc.exited;
      await readerDone;
      expect(code).toBe(0);

      expect(out.filter((m) => m.type === "ask_cancel")).toHaveLength(1);
      const turnEnds = out.filter((m) => m.type === "turn_end");
      expect(turnEnds).toHaveLength(1);
      expect(turnEnds[0]!.reply).toBeUndefined();
      expect(out.filter((m) => m.type === "text_delta")).toHaveLength(0);
      const assistantItems = out.filter(
        (m) => m.type === "item" && typeof m.item === "object" && m.item !== null && (m.item as { kind?: string }).kind === "message",
      );
      expect(assistantItems).toHaveLength(0);
    } finally {
      try {
        proc.kill();
      } catch {
        // already exited
      }
      await proc.exited.catch(() => {});
    }
  }, 10_000);

  test("local-im runtime capabilities match plugin.json and support all declared RPC methods without -32601", async () => {
    const manifestJson = JSON.parse(readFileSync(join(REPO_ROOT, "examples", "plugins", "local-im", "plugin.json"), "utf8")) as {
      capabilities: Capabilities;
    };
    const proc = Bun.spawn(["bun", "run", join(REPO_ROOT, "examples", "plugins", "local-im", "index.ts")], {
      cwd: REPO_ROOT,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const out: Array<Record<string, unknown>> = [];
    const kept = new Map<string, string>();
    const readerDone = readJsonLines<Record<string, unknown>>(proc.stdout, {
      onMessage(msg) {
        if (typeof msg.method === "string" && msg.id !== undefined) {
          const params = (msg.params ?? {}) as Record<string, unknown>;
          if (msg.method === "kept_get") {
            proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { value: kept.get(String(params.key)) ?? null } }) + "\n");
          } else if (msg.method === "kept_set") {
            kept.set(String(params.key), String(params.value));
            proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { ok: true } }) + "\n");
          }
          return;
        }
        out.push(msg);
      },
    });
    const byId = (id: number) => out.find((m) => m.id === id);

    try {
      proc.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "init",
          params: { proto: 1, botId: "b-local", botName: "local-im", config: {} },
        }) + "\n",
      );
      await waitFor(() => byId(1) !== undefined);
      const initResp = byId(1)! as { result?: { capabilities: Capabilities } };
      expect(initResp.result?.capabilities).toEqual(manifestJson.capabilities);

      const requests: Array<{ id: number; method: string; params: unknown }> = [
        { id: 2, method: "send", params: { chat: "u1", message: { text: "hi" } } },
        { id: 3, method: "edit", params: { chat: "u1", messageId: "local-1", message: { text: "edited" } } },
        { id: 4, method: "drop_buttons", params: { chat: "u1", messageId: "local-1" } },
        { id: 5, method: "answer_press", params: { chat: "u1", press: "p1", text: "ok" } },
        { id: 6, method: "set_menu", params: { items: [{ command: "status", description: "Show status" }] } },
        { id: 7, method: "profile", params: { you: "u1" } },
      ];
      for (const req of requests) {
        proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...req }) + "\n");
      }
      await waitFor(() => byId(7) !== undefined);

      for (const req of requests) {
        const resp = byId(req.id)!;
        expect(resp.error).toBeUndefined();
      }
      expect((byId(2)! as { result: SendResult }).result.status).toBe("sent");
      expect((byId(3)! as { result: SendResult }).result.status).toBe("sent");
      expect((byId(4)! as { result: SendResult }).result.status).toBe("sent");
      expect((byId(5)! as { result: unknown }).result).toEqual({ ok: true });
      expect((byId(6)! as { result: unknown }).result).toEqual({ ok: true });
      expect((byId(7)! as { result: unknown }).result).toEqual({});

      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 8, method: "shutdown", params: {} }) + "\n");
      await waitFor(() => byId(8) !== undefined);
      expect((byId(8)! as { result: unknown }).result).toEqual({ ok: true });
      proc.stdin.end();
      const code = await proc.exited;
      await readerDone;
      expect(code).toBe(0);
    } finally {
      try {
        proc.kill();
      } catch {
        // already exited
      }
      await proc.exited.catch(() => {});
    }
  }, 10_000);

  test("conformance rejects agent plugin that emits only empty turn_end without taken/turn_start/reply", async () => {
    const pluginDir = makeTempDir("rhodium empty turn ");
    writeFileSync(
      join(pluginDir, "plugin.json"),
      JSON.stringify({
        manifestVersion: 1,
        kind: "agent",
        id: "empty-turn",
        name: "Empty Turn",
        statusName: "Empty Turn",
        version: "0.1.0",
        protocol: "rh-agent/1",
        minRhodium: "1.5.0",
        program: "empty-turn",
        command: ["bun", "run", "${PLUGIN_DIR}/index.ts"],
        capabilities: { liveApproval: false, steer: false, commands: [] },
      }),
    );
    writeFileSync(
      join(pluginDir, "index.ts"),
      `import { runAgentPlugin } from ${JSON.stringify(join(REPO_ROOT, "packages", "plugin-sdk", "index.ts"))};
runAgentPlugin({
  async init() {
    return { session: "s-empty", capabilities: {} };
  },
  async send(_msg, ctx) {
    ctx.turnEnd();
  },
  async interrupt() {},
});
`,
    );
    const res = await runConformance(join(pluginDir, "plugin.json"));
    expect(res.code).not.toBe(0);
  }, 10_000);

  test("conformance bounds cleanup with SIGKILL when a timed-out plugin ignores close and traps SIGTERM", async () => {
    const pluginDir = makeTempDir("rhodium trap sigterm ");
    writeFileSync(
      join(pluginDir, "plugin.json"),
      JSON.stringify({
        manifestVersion: 1,
        kind: "agent",
        id: "trap-sigterm",
        name: "Trap SIGTERM",
        statusName: "Trap SIGTERM",
        version: "0.1.0",
        protocol: "rh-agent/1",
        minRhodium: "1.5.0",
        program: "trap-sigterm",
        command: ["bun", "run", "${PLUGIN_DIR}/index.ts"],
        capabilities: { liveApproval: false, steer: false, commands: [] },
      }),
    );
    writeFileSync(
      join(pluginDir, "index.ts"),
      `process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
process.stdin.resume();
`,
    );
    const startedAt = Date.now();
    const res = await runConformance(join(pluginDir, "plugin.json"), undefined, "200");
    expect(res.code).not.toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(3000);
  }, 6000);

  test("passes minimal conformance checks for echo-agent and local-im examples", async () => {
    const agentRes = await runConformance(join(REPO_ROOT, "examples", "plugins", "echo-agent", "plugin.json"));
    expect(agentRes.code).toBe(0);

    const imRes = await runConformance(join(REPO_ROOT, "examples", "plugins", "local-im", "plugin.json"));
    expect(imRes.code).toBe(0);
  }, 20_000);

  test("scrubs mixed-case ANTHROPIC/CLAUDE/HERDR env vars, injects RHODIUM_PLUGIN_DIR and PYTHONUTF8, and spawns in space-containing cwd", async () => {
    const pluginDir = makeTempDir("rhodium env probe ");
    const outFile = join(pluginDir, "probe-env.json");
    writeFileSync(
      join(pluginDir, "plugin.json"),
      JSON.stringify({
        manifestVersion: 1,
        kind: "agent",
        id: "env-probe",
        name: "Env Probe",
        statusName: "Env Probe",
        version: "0.1.0",
        protocol: "rh-agent/1",
        minRhodium: "1.5.0",
        program: "env-probe",
        command: ["bun", "run", "${PLUGIN_DIR}/index.ts"],
        capabilities: { liveApproval: false, steer: false, commands: [] },
      }),
    );
    writeFileSync(
      join(pluginDir, "index.ts"),
      `import { writeFileSync } from "node:fs";
import { runAgentPlugin } from ${JSON.stringify(join(REPO_ROOT, "packages", "plugin-sdk", "index.ts"))};

runAgentPlugin({
  async init(params) {
    writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({
      cwd: process.cwd(),
      rhPluginDir: process.env.RHODIUM_PLUGIN_DIR,
      pythonUtf8: process.env.PYTHONUTF8,
      leakedKeys: Object.keys(process.env).filter((k) => /^(?:anthropic_|claude|herdr_)/i.test(k)),
      initCwd: params.cwd,
    }));
    return { session: "probe-1", capabilities: {} };
  },
  async send(msg, ctx) {
    ctx.taken(msg.id);
    ctx.turnStart(msg.id);
    ctx.turnEnd("ok");
  },
  async interrupt() {},
});
`,
    );

    const res = await runConformance(join(pluginDir, "plugin.json"), {
      Anthropic_Api_Key: "secret-1",
      claude_code_oauth_token: "secret-2",
      HERDR_SESSION: "default",
      Herdr_Socket: "/tmp/do-not-leak.sock",
    });
    expect(res.code).toBe(0);
    const recorded = JSON.parse(readFileSync(outFile, "utf8")) as {
      cwd: string;
      rhPluginDir: string;
      pythonUtf8: string;
      leakedKeys: string[];
      initCwd: string;
    };
    expect(recorded.leakedKeys).toEqual([]);
    expect(recorded.rhPluginDir).toBe(pluginDir);
    expect(recorded.pythonUtf8).toBe("1");
    expect(recorded.cwd).toContain(" ");
    expect(recorded.initCwd).toBe(recorded.cwd);
  }, 20_000);

  test("rejects forbidden manifest (claude program or reserved herdr id)", async () => {
    const dir = makeTempDir("rhodium-bad-manifest ");
    const manifestPath = join(dir, "plugin.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        manifestVersion: 1,
        kind: "agent",
        id: "herdr",
        name: "Bad",
        statusName: "Bad",
        version: "0.1.0",
        protocol: "rh-agent/1",
        minRhodium: "1.5.0",
        program: "claude.exe",
        command: ["bun", "run", "${PLUGIN_DIR}/index.ts"],
        capabilities: {},
      }),
    );
    const res = await runConformance(manifestPath);
    expect(res.code).not.toBe(0);
  });
});
