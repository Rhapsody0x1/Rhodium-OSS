import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createPrivateWindows, windows } from "../src/windows";
import { join, resolve } from "node:path";
import {
  AGENTS,
  AGENT_KINDS,
  agentDef,
  allAgentKinds,
  isBuiltinAgent,
  isRegisteredAgent,
  registerAgentPlugin,
} from "../src/agents";
import { agentCommands, slashMenu } from "../src/commands";
import { loadConfig } from "../src/config";
import {
  MADE,
  PLATFORMS,
  allPlatformLabels,
  isBuiltinPlatform,
  isRegisteredPlatform,
  platformDef,
  platformLabel,
  registerPlatformPlugin,
} from "../src/platforms";
import { applyPluginRegistry, loadPlugins, resetPluginRegistry } from "../src/plugin-loader";
import { pluginFindings } from "../src/doctor";
import { AT_BOARD, route, type Ctx, type Decision, type State } from "../src/router";
import type { AgentInput, Slot } from "../src/store";
import { hasTranscript, listConversations, transcriptFile } from "../src/transcript";

const dirs: string[] = [];

function tempDir(prefix = "rhodium-plugin-loader-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  if (!windows) return dir;
  const privateDir = join(dir, "private");
  createPrivateWindows([privateDir]);
  return privateDir;
}

afterEach(() => {
  resetPluginRegistry();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function dshManifest(overrides: Record<string, unknown> = {}) {
  return {
    manifestVersion: 1,
    kind: "agent",
    id: "dsh",
    name: "DeepSeek Harness",
    statusName: "DeepSeek Harness",
    version: "0.1.0",
    protocol: "rh-agent/1",
    minRhodium: "1.5.0",
    program: "nonexistent-dsh-cli-for-test",
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
    ...overrides,
  };
}

function weixinManifest(overrides: Record<string, unknown> = {}) {
  return {
    manifestVersion: 1,
    kind: "im",
    id: "weixin",
    name: "微信官方 Bot",
    label: "微信",
    version: "0.1.0",
    protocol: "rh-im/1",
    minRhodium: "1.5.0",
    command: ["bun", "run", "${PLUGIN_DIR}/index.js"],
    capabilities: {
      progress: "append",
      buttons: false,
      menu: { scope: "global", maxItems: 0 },
      maxTextLength: 2000,
      maxFileBytes: { image: 10 * 1024 * 1024, file: 25 * 1024 * 1024 },
      sendLimit: { kind: "rate", perChatPerSecond: 1 },
      markdown: null,
    },
    requiredConfig: ["token"],
    optionalConfig: ["baseUrl", "cdnBaseUrl", "accountId"],
    ...overrides,
  };
}

function writePluginDir(root: string, name: string, manifest: unknown): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest, null, 2));
  return dir;
}

describe("config.ts plugin support", () => {
  test("parses [durations] plugin defaults, [plugins.<id>] with relative paths, [programs.<plugin>], and [bots.<name>].platform cleanly without reading manifests", () => {
    const root = tempDir();
    const cfgPath = join(root, "config.toml");
    writeFileSync(
      cfgPath,
      [
        `stateDir = ${JSON.stringify(join(root, "state"))}`,
        "",
        "[programs]",
        `dsh = "custom-dsh"`,
        "",
        "[plugins.dsh]",
        `path = "./plugins with spaces/dsh"`,
        "",
        "[plugins.dsh.config]",
        `fixture = "./fixtures/dsh.jsonl"`,
        "",
        "[plugins.weixin]",
        `path = ${JSON.stringify(join(root, "missing-weixin-not-read-by-loadConfig"))}`,
        `enabled = false`,
        "",
        "[bots.my-weixin]",
        `platform = "weixin"`,
        `token = "mock-token"`,
      ].join("\n"),
      { mode: 0o600 },
    );

    const cfg = loadConfig(cfgPath);
    expect(cfg.durations.pluginHandshake).toBe(10_000);
    expect(cfg.durations.pluginInterrupt).toBe(10_000);
    expect(cfg.durations.pluginRpc).toBe(30_000);
    expect(cfg.programs.dsh).toBe("custom-dsh");
    expect(cfg.plugins.dsh).toEqual({
      path: resolve(root, "./plugins with spaces/dsh"),
      enabled: true,
      config: { fixture: "./fixtures/dsh.jsonl" },
    });
    expect(cfg.plugins.weixin).toEqual({
      path: join(root, "missing-weixin-not-read-by-loadConfig"),
      enabled: false,
      config: {},
    });
    expect(cfg.bots["my-weixin"]?.platform).toBe("weixin");
    // Pure config load must not mutate global registries.
    expect(isRegisteredAgent("dsh")).toBe(false);
    expect(isRegisteredPlatform("weixin")).toBe(false);
  });

  test("allows paths with Claude in a parent directory for non-claude programs, rejects built-in claude spoofing and unconfigured platforms, and isolates per-plugin config errors", () => {
    const root = tempDir();
    const okPiPath = join(root, "claude-dir-pi.toml");
    writeFileSync(
      okPiPath,
      `stateDir = ${JSON.stringify(join(root, "state-pi"))}\n[programs]\npi = "/opt/Claude Tools/pi"\n`,
      { mode: 0o600 },
    );
    expect(loadConfig(okPiPath).programs.pi).toBe("/opt/Claude Tools/pi");

    const fatalCases: { name: string; toml: string; match: RegExp }[] = [
      {
        name: "non-table plugins",
        toml: `plugins = "nope"\n`,
        match: /plugins must be a table/,
      },
      {
        name: "forbidden claude path in [programs.pi]",
        toml: `[programs]\npi = "/usr/local/bin/claude"\n`,
        match: /claude/i,
      },
      {
        name: "forbidden claude in dir with spaces in [programs.pi]",
        toml: `[programs]\npi = "/opt/Claude Tools/claude"\n`,
        match: /claude/i,
      },
      {
        name: "unconfigured plugin platform on bot",
        toml: `[bots.b]\nplatform = "weixin"\ntoken = "t"\n`,
        match: /bots\.b\.platform/,
      },
    ];

    for (const c of fatalCases) {
      const p = join(root, `${c.name.replace(/[^\w-]+/g, "-")}.toml`);
      writeFileSync(p, c.toml, { mode: 0o600 });
      expect(() => loadConfig(p)).toThrow(c.match);
    }

    const isolatedCases: { name: string; toml: string; match: RegExp }[] = [
      {
        name: "missing path",
        toml: `[plugins.dsh]\nenabled = true\n`,
        match: /plugins\.dsh\.path/,
      },
      {
        name: "unknown key inside plugin entry",
        toml: `[plugins.dsh]\npath = "./dsh"\nextra = "nope"\n`,
        match: /plugins\.dsh\.extra/,
      },
      {
        name: "non-boolean enabled",
        toml: `[plugins.dsh]\npath = "./dsh"\nenabled = "yes"\n`,
        match: /plugins\.dsh\.enabled/,
      },
      {
        name: "non-string config value",
        toml: `[plugins.dsh]\npath = "./dsh"\n[plugins.dsh.config]\ncount = 3\n`,
        match: /plugins\.dsh\.config\.count/,
      },
      {
        name: "forbidden claude in [programs.<plugin>]",
        toml: `[plugins.dsh]\npath = "./dsh"\n[programs]\ndsh = "claude.exe"\n`,
        match: /claude/i,
      },
    ];

    const localImPath = resolve(import.meta.dir, "../examples/plugins/local-im");
    for (const c of isolatedCases) {
      const p = join(root, `iso-${c.name.replace(/[^\w-]+/g, "-")}.toml`);
      writeFileSync(
        p,
        [
          `stateDir = ${JSON.stringify(join(root, "state"))}`,
          `[bots.t]`,
          `platform = "telegram"`,
          `token = "123:abc"`,
          `[plugins.local-im]`,
          `path = ${JSON.stringify(localImPath)}`,
          c.toml,
        ].join("\n"),
        { mode: 0o600 },
      );
      const cfg = loadConfig(p);
      expect(cfg.bots.t?.platform).toBe("telegram");
      expect(cfg.plugins.dsh?.configError).toMatch(c.match);

      const reg = loadPlugins(cfg.plugins, {
        coreVersion: "1.5.0",
        agentPath: process.env.PATH ?? "",
        bots: cfg.bots,
        programs: cfg.programs,
      });
      expect(reg.loaded.map((x) => x.id)).toEqual(["local-im"]);
      expect(reg.plugins.dsh?.status).toBe("failed");
      if (reg.plugins.dsh?.status === "failed") {
        expect(reg.plugins.dsh.error).toMatch(c.match);
      }
      const doc = pluginFindings(reg);
      expect(doc.findings.some((f) => f.level === "错误" && c.match.test(f.text))).toBe(true);
    }
  });
});

describe("plugin-loader.ts manifest validation and failure isolation", () => {
  test("loads valid agent (with spaces in path, missing downstream program binary) and IM manifests plus repo examples", () => {
    const root = tempDir();
    const dshDir = writePluginDir(root, "dsh plugin", dshManifest());
    const wxDir = writePluginDir(root, "weixin plugin", weixinManifest());

    const reg = loadPlugins(
      {
        dsh: { path: dshDir, enabled: true, config: { fixture: "sample.jsonl" } },
        weixin: { path: wxDir, enabled: true, config: {} },
        "echo-agent": { path: resolve(import.meta.dir, "../examples/plugins/echo-agent"), enabled: true, config: {} },
        "local-im": { path: resolve(import.meta.dir, "../examples/plugins/local-im"), enabled: true, config: {} },
      },
      {
        coreVersion: "1.5.0",
        agentPath: process.env.PATH ?? "",
        bots: {
          "my-wx": { platform: "weixin", token: "mock-weixin-token" },
        },
        register: true,
      },
    );

    expect(reg.failed).toEqual([]);
    expect(reg.disabled).toEqual([]);
    expect(reg.loaded.map((p) => p.id).sort()).toEqual(["dsh", "echo-agent", "local-im", "weixin"]);
    const dshRec = reg.plugins.dsh;
    expect(dshRec?.status).toBe("loaded");
    if (dshRec?.status === "loaded") {
      expect(dshRec.command[0]).toMatch(/^bun/);
      expect(dshRec.command[2]).toBe(resolve(dshDir, "dist/index.js"));
    }

    // Dynamic registries updated without widening built-in AGENTS / PLATFORMS / MADE.
    expect(Object.keys(AGENTS)).toEqual(["claude", "pi", "codex"]);
    expect(AGENT_KINDS).toEqual(["claude", "pi", "codex"]);
    expect(Object.keys(PLATFORMS)).toEqual(["qq", "telegram", "feishu", "fake"]);
    expect(Object.keys(MADE)).toEqual(["qq", "telegram", "feishu"]);

    expect(isBuiltinAgent("dsh")).toBe(false);
    expect(isRegisteredAgent("dsh")).toBe(true);
    expect(allAgentKinds()).toContain("dsh");
    expect(allAgentKinds()).toContain("echo-agent");

    const def = agentDef("dsh");
    expect(def).toMatchObject({
      builtin: false,
      tui: false,
      importable: false,
      paneImport: false,
      claudeKeys: false,
      ultracode: false,
      apiPrice: false,
      sessionIdOpens: false,
      steer: false,
      liveApproval: false,
      program: "nonexistent-dsh-cli-for-test",
    });
    expect(def.supportedCommands).toEqual(["model", "status", "context"]);

    expect(isBuiltinPlatform("weixin")).toBe(false);
    expect(isRegisteredPlatform("weixin")).toBe(true);
    expect(platformLabel("weixin")).toBe("微信");
    expect(platformDef("weixin")?.capabilities({ platform: "weixin" }, {} as never).markdown).toBeNull();
    expect(allPlatformLabels()).toContainEqual({ id: "weixin", label: "微信" });

    // Even if a direct caller attempts to pass unsafe capabilities, registerAgentPlugin locks them down.
    registerAgentPlugin("sneaky", {
      name: "Sneaky",
      statusName: "Sneaky",
      builtin: true as unknown as false,
      tui: true as unknown as false,
      importable: true as unknown as false,
      paneImport: true as unknown as false,
      claudeKeys: true as unknown as false,
      ultracode: true as unknown as false,
      apiPrice: true as unknown as false,
      sessionIdOpens: true as unknown as false,
    } as never);
    expect(agentDef("sneaky")).toMatchObject({
      builtin: false,
      tui: false,
      importable: false,
      paneImport: false,
      claudeKeys: false,
      ultracode: false,
      apiPrice: false,
      sessionIdOpens: false,
      steer: false,
      liveApproval: false,
      supportedCommands: [],
      program: "sneaky",
    });

    resetPluginRegistry();
    expect(isRegisteredAgent("dsh")).toBe(false);
    expect(isRegisteredPlatform("weixin")).toBe(false);
    expect(platformLabel("weixin")).toBe("weixin");

    applyPluginRegistry(reg);
    expect(isRegisteredAgent("dsh")).toBe(true);
    expect(isRegisteredPlatform("weixin")).toBe(true);
  });

  test("isolates all static validation failures without throwing or blocking valid sibling plugins", () => {
    const root = tempDir();
    const okDir = writePluginDir(root, "ok", dshManifest({ id: "ok" }));
    const badJsonDir = writePluginDir(root, "bad-json", "{ not json");
    const mismatchDir = writePluginDir(root, "mismatch", dshManifest({ id: "other-id" }));
    const herdrDir = writePluginDir(root, "herdr", dshManifest({ id: "herdr" }));
    const claudeIdDir = writePluginDir(root, "claude", dshManifest({ id: "claude" }));
    const qqIdDir = writePluginDir(root, "qq", weixinManifest({ id: "qq" }));
    const claudeProgDir = writePluginDir(root, "claude-prog", dshManifest({ id: "cprog", program: "claude" }));
    const claudeCmdDir = writePluginDir(root, "claude-cmd", dshManifest({ id: "ccmd", command: ["claude.cmd", "--headless"] }));
    const claudePlatCmdDir = writePluginDir(
      root,
      "claude-pcmd",
      dshManifest({
        id: "cpcmd",
        commandByPlatform: { [process.platform]: ["/opt/bin/claude.exe"] },
      }),
    );
    const newerCoreDir = writePluginDir(root, "newer", dshManifest({ id: "newer", minRhodium: "2.0.0" }));
    const missingBinDir = writePluginDir(
      root,
      "missing-bin",
      dshManifest({ id: "missing-bin", commandByPlatform: undefined, command: ["definitely-missing-rhodium-plugin-bin-xyz"] }),
    );
    const missingRelBinDir = writePluginDir(
      root,
      "missing-rel",
      dshManifest({ id: "missing-rel", commandByPlatform: undefined, command: ["${PLUGIN_DIR}/bin/not-there"] }),
    );
    const agentSecretDir = writePluginDir(
      root,
      "agent-secret",
      dshManifest({ id: "agent-secret", requiredConfig: ["apiKey", "endpoint"] }),
    );
    const wxSecretDir = writePluginDir(
      root,
      "wx-secret",
      weixinManifest({ id: "wx-secret", requiredConfig: ["token", "accountId"] }),
    );
    const missingPluginDir = join(root, "does-not-exist");
    const emptyExistingDir = join(root, "empty-existing-dir");
    mkdirSync(emptyExistingDir, { recursive: true });
    const imHerdrDir = writePluginDir(root, "im-herdr", weixinManifest({ id: "herdr" }));

    const reg = loadPlugins(
      {
        ok: { path: okDir, enabled: true, config: {} },
        disabled: { path: badJsonDir, enabled: false, config: {} },
        "missing-dir": { path: missingPluginDir, enabled: true, config: {} },
        "missing-manifest": { path: emptyExistingDir, enabled: true, config: {} },
        "bad-json": { path: badJsonDir, enabled: true, config: {} },
        mismatch: { path: mismatchDir, enabled: true, config: {} },
        herdr: { path: herdrDir, enabled: true, config: {} },
        claude: { path: claudeIdDir, enabled: true, config: {} },
        qq: { path: qqIdDir, enabled: true, config: {} },
        cprog: { path: claudeProgDir, enabled: true, config: {} },
        ccmd: { path: claudeCmdDir, enabled: true, config: {} },
        cpcmd: { path: claudePlatCmdDir, enabled: true, config: {} },
        newer: { path: newerCoreDir, enabled: true, config: {} },
        "missing-bin": { path: missingBinDir, enabled: true, config: {} },
        "missing-rel": { path: missingRelBinDir, enabled: true, config: {} },
        "agent-secret": {
          path: agentSecretDir,
          enabled: true,
          config: { apiKey: "SUPER_SECRET_AGENT_VALUE_123" },
        },
        "wx-secret": {
          path: wxSecretDir,
          enabled: true,
          config: {},
        },
      },
      {
        coreVersion: "1.5.0",
        agentPath: process.env.PATH ?? "",
        bots: {
          b1: { platform: "wx-secret", token: "SUPER_SECRET_IM_TOKEN_456" },
        },
        register: true,
      },
    );

    expect(reg.loaded.map((p) => p.id)).toEqual(["ok"]);
    expect(reg.disabled).toEqual(["disabled"]);
    expect(reg.plugins.disabled).toEqual({ id: "disabled", status: "disabled", dir: badJsonDir });

    const expectedFailed = [
      "missing-dir",
      "missing-manifest",
      "bad-json",
      "mismatch",
      "herdr",
      "claude",
      "qq",
      "cprog",
      "ccmd",
      "cpcmd",
      "newer",
      "missing-bin",
      "missing-rel",
      "agent-secret",
      "wx-secret",
    ];
    for (const id of expectedFailed) {
      expect(reg.plugins[id]?.status).toBe("failed");
    }
    expect(reg.plugins["missing-manifest"]?.status === "failed" ? reg.plugins["missing-manifest"].error : "").toContain("plugin.json");

    const imHerdrReg = loadPlugins(
      { herdr: { path: imHerdrDir, enabled: true, config: {} } },
      { coreVersion: "1.5.0", agentPath: process.env.PATH ?? "" },
    );
    expect(imHerdrReg.plugins.herdr?.status).toBe("failed");
    expect(imHerdrReg.loaded).toEqual([]);

    const agentErr = reg.plugins["agent-secret"]?.status === "failed" ? reg.plugins["agent-secret"].error : "";
    expect(agentErr).toContain("endpoint");
    expect(agentErr).not.toContain("SUPER_SECRET_AGENT_VALUE_123");

    const wxErr = reg.plugins["wx-secret"]?.status === "failed" ? reg.plugins["wx-secret"].error : "";
    expect(wxErr).toContain("accountId");
    expect(wxErr).not.toContain("SUPER_SECRET_IM_TOKEN_456");

    expect(isRegisteredAgent("ok")).toBe(true);
    expect(isRegisteredAgent("disabled")).toBe(false);
    expect(isRegisteredAgent("newer")).toBe(false);
  });
});

describe("commands, router, and transcript guards for plugin agents", () => {
  function routerCtx(root: string, plugins: ReturnType<typeof loadPlugins>): Ctx {
    const cfgPath = join(root, "config.toml");
    writeFileSync(cfgPath, `stateDir = ${JSON.stringify(join(root, "state"))}\n`, { mode: 0o600 });
    return {
      now: Date.parse("2026-11-21T10:00:00Z"),
      newId: () => crypto.randomUUID(),
      newPairCode: () => "0000",
      config: loadConfig(cfgPath),
      capabilities: () => ({
        progress: "edit",
        editEvery: 100,
        finalEdit: true,
        buttons: true,
        maxButtons: 8,
        sendLimit: { kind: "rate", perChatPerSecond: 20 },
        menu: { scope: "global", maxItems: 10 },
        maxTextLength: 4000,
        maxFileBytes: { image: 1024, file: 1024 },
        markdown: null,
      }),
      keepFile: () => null,
      diskFree: () => Infinity,
      herdr: () => true,
      front: () => false,
      retarget: () => null,
      dropBot: () => {},
      inboundOf: () => [],
      plugins,
    };
  }

  function makeState(agent: string, slotOverrides: Partial<Slot> = {}, queued: AgentInput[] = [], chatOf: Record<string, string> = {}): State {
    const slot: Slot = {
      id: "s1",
      workspace: "w1",
      name: "main",
      dir: "/tmp",
      mode: "headless",
      state: "idle",
      conversation: "c1",
      parent: null,
      lifetime: "persistent",
      archivedAt: null,
      turnStartedAt: null,
      turnEndedAt: null,
      turnChat: null,
      turnInbound: null,
      turnSentMe: null,
      interruptedAt: null,
      stopSentAt: null,
      model: null,
      effort: null,
      ultracode: null,
      approval: null,
      token: null,
      herdrPane: null,
      tuiPid: null,
      tuiStart: null,
      tuiLaunched: 0,
      tuiFocus: 0,
      tuiBack: 0,
      typedIn: 0,
      reapAt: null,
      activeAt: 0,
      webAt: null,
      memBlocked: null,
      nextAgent: null,
      nextSession: null,
    } as unknown as Slot;
    return {
      workspaces: [{ id: "w1", name: "work", dir: "/tmp", herdrWorkspace: null }],
      slots: [{ ...slot, ...slotOverrides }],
      conversations: [{ id: "c1", slot: "s1", agent, sessionId: "sess-1", startedAt: 0, progress: null }],
      bots: [{ id: "b1", name: "qq1", platform: "qq", connState: "up", defaultTarget: "s1", owners: JSON.stringify(["u1"]) }],
      chats: [{ id: "ch1", bot: "b1", platformChatId: "u1", machine: "", target: null, panel: null, verbose: null, contactedAt: null }],
      holders: [],
      queued,
      quotas: [],
      held: [],
      hints: [],
      asks: [],
      listed: [],
      unsure: [],
      chatOf,
      quoted: null,
      seen: false,
      begun: null,
      models: {},
      modelInfo: {},
    } as unknown as State;
  }

  const slotPatch = (d: Decision) => Object.assign({}, ...d.writes.flatMap((w) => (w.op === "update" && w.table === "slot" ? [w.patch] : [])));
  const rhReply = (d: Decision) => {
    const e = d.effects.find((x): x is Extract<Decision["effects"][number], { kind: "rh_reply" }> => x.kind === "rh_reply");
    return e?.reply;
  };
  const outboundTexts = (d: Decision) =>
    d.writes
      .filter((w): w is Extract<Decision["writes"][number], { op: "insert"; table: "outbound" }> => w.op === "insert" && w.table === "outbound")
      .map((w) => (JSON.parse(String((w.row as { payload: string }).payload)) as { text?: string }).text ?? "");

  test("filters plugin slashMenu/agentCommands and enforces router refusals & non-steer queuing", async () => {
    const root = tempDir();
    const dshDir = writePluginDir(root, "dsh", dshManifest());
    const badDir = writePluginDir(root, "bad", dshManifest({ id: "bad", minRhodium: "9.0.0" }));
    const reg = loadPlugins(
      {
        dsh: { path: dshDir, enabled: true, config: {} },
        offp: { path: badDir, enabled: false, config: {} },
        badp: { path: badDir, enabled: true, config: {} },
      },
      { coreVersion: "1.5.0", agentPath: process.env.PATH ?? "", register: true },
    );

    const dshMenu = slashMenu("dsh").map((m) => m.command);
    expect(dshMenu).toContain("/new");
    expect(dshMenu).toContain("/stop");
    expect(dshMenu).toContain("/resume");
    expect(dshMenu).toContain("/model");
    expect(dshMenu).toContain("/status");
    expect(dshMenu).toContain("/context");
    expect(dshMenu).not.toContain("/compact");
    expect(dshMenu).not.toContain("/ultracode");
    expect(agentCommands("dsh").map((c) => c.name)).not.toContain("compact");

    const ctx = routerCtx(root, reg);

    // rh new --agent <plugin>
    const created = route(makeState("claude"), { kind: "rh", id: "r1", caller: AT_BOARD, argv: ["new", "work/dsh1", "--agent", "dsh"] }, ctx);
    expect(rhReply(created)?.ok).toBe(true);

    const disabledNew = route(makeState("claude"), { kind: "rh", id: "r2", caller: AT_BOARD, argv: ["new", "work/dsh2", "--agent", "offp"] }, ctx);
    expect(rhReply(disabledNew)).toEqual({ ok: false, error: "插件 offp 已禁用" });

    const failedNew = route(makeState("claude"), { kind: "rh", id: "r3", caller: AT_BOARD, argv: ["new", "work/dsh3", "--agent", "badp"] }, ctx);
    const failedReply = rhReply(failedNew);
    expect(failedReply?.ok).toBe(false);
    if (failedReply && !failedReply.ok) expect(failedReply.error).toStartWith("插件 badp 加载失败：");

    // Routing to disabled / failed slot via IM, board, or rh send
    const imDisabled = route(
      makeState("offp"),
      { kind: "im", message: { bot: "b1", chat: "u1", sender: "u1", messageId: "m1", at: ctx.now, text: "hello" } },
      ctx,
    );
    expect(outboundTexts(imDisabled).join("\n")).toContain("插件 offp 已禁用，请启用或切换对话");

    const boardFailed = route(makeState("badp"), { kind: "board", id: "b-1", act: { kind: "say", slot: "s1", text: "hi" } }, ctx);
    const bfReply = rhReply(boardFailed);
    expect(bfReply?.ok).toBe(false);
    if (bfReply && !bfReply.ok) expect(bfReply.error).toStartWith("插件 badp 加载失败：");

    const sendDisabled = route(makeState("offp"), { kind: "rh", id: "r4", caller: AT_BOARD, argv: ["send", "work/main", "hi"] }, ctx);
    expect(rhReply(sendDisabled)).toEqual({ ok: false, error: "插件 offp 已禁用，请启用或切换对话" });

    // rh tui refused for plugin agent
    const tuiRes = route(makeState("dsh"), { kind: "rh", id: "r5", caller: AT_BOARD, argv: ["tui", "work/main"] }, ctx);
    expect(rhReply(tuiRes)).toEqual({ ok: false, error: "该 agent 插件不支持终端模式。" });

    // common() refuses unsupported command /compact for dsh, allows /status and /new
    const badCmd = route(
      makeState("dsh", { state: "idle" }),
      { kind: "im", message: { bot: "b1", chat: "u1", sender: "u1", messageId: "m2", at: ctx.now, text: "/compact" } },
      ctx,
    );
    expect(outboundTexts(badCmd).join("\n")).toContain("该 agent 不支持此命令。");

    const okCmd = route(
      makeState("dsh", { state: "idle" }),
      { kind: "im", message: { bot: "b1", chat: "u1", sender: "u1", messageId: "m3", at: ctx.now, text: "/status" } },
      ctx,
    );
    expect(okCmd.effects.some((e) => e.kind === "command" && e.command === "status")).toBe(true);

    // steer: false queues with after_turn when running, then turn_end restores turnChat & turnInbound for human input
    const runningDecision = route(
      makeState("dsh", { state: "running", turnChat: "ch-other", turnInbound: "old-m" }),
      { kind: "im", message: { bot: "b1", chat: "u1", sender: "u1", messageId: "m4", at: ctx.now, text: "follow up" } },
      ctx,
    );
    expect(runningDecision.effects.some((e) => e.kind === "deliver")).toBe(false);
    const queuedWrite = runningDecision.writes.find((w) => w.op === "insert" && w.table === "agentInput");
    expect(queuedWrite).toBeDefined();
    if (queuedWrite?.op === "insert" && queuedWrite.table === "agentInput") {
      expect(queuedWrite.row.queueReason).toBe("after_turn");
    }

    const queuedRow: AgentInput = {
      id: "in-1",
      machine: "",
      conversation: "c1",
      source: "human",
      status: "queued",
      queueReason: "after_turn",
      body: "follow up",
      trace: "m4",
      images: null,
      resentAt: null,
      typedAt: null,
      typed: null,
      noticedAt: null,
    };
    const endDecision = route(
      makeState("dsh", { state: "running", turnChat: "ch-other", turnInbound: "old-m" }, [queuedRow], { "in-1": "ch1" }),
      { kind: "agent", event: { type: "turn_end", conv: "c1", proc: 1, reply: "done1" } },
      ctx,
    );
    expect(slotPatch(endDecision)).toMatchObject({
      state: "running",
      turnChat: "ch1",
      turnInbound: "m4",
    });
    expect(endDecision.effects.some((e) => e.kind === "deliver")).toBe(true);

    // Quick-Fix / Must-Fix 1: starting queues AFTER_TURN, turn_end releases ONLY 1st AFTER_TURN row, AFTER_INTERRUPT keeps AFTER_TURN queued, wake() queues AFTER_TURN even with turnChat === null
    const startingQueued = route(
      makeState("dsh", { state: "starting", turnChat: "ch1", turnInbound: "m0" }),
      { kind: "im", message: { bot: "b1", chat: "u1", sender: "u1", messageId: "m-start-2", at: ctx.now, text: "second while starting" } },
      ctx,
    );
    expect(startingQueued.effects.some((e) => e.kind === "deliver")).toBe(false);
    expect(startingQueued.writes.find((w) => w.op === "insert" && w.table === "agentInput")).toMatchObject({
      row: { queueReason: "after_turn" },
    });

    const queuedRow2: AgentInput = { ...queuedRow, id: "in-2", body: "third turn", trace: "m5" };
    const multiEnd = route(
      makeState("dsh", { state: "running", turnChat: "ch-other", turnInbound: "old-m" }, [queuedRow, queuedRow2], { "in-1": "ch1", "in-2": "ch2" }),
      { kind: "agent", event: { type: "turn_end", conv: "c1", proc: 1, reply: "done-m" } },
      ctx,
    );
    const releasedWrites = multiEnd.writes.filter(
      (w): w is Extract<Decision["writes"][number], { op: "update"; table: "agentInput" }> =>
        w.op === "update" && w.table === "agentInput" && (w.patch as { queueReason?: unknown }).queueReason === null,
    );
    expect(releasedWrites).toHaveLength(1);
    expect(releasedWrites[0]!.where).toMatchObject({ id: "in-1" });
    expect(slotPatch(multiEnd)).toMatchObject({ state: "running", turnChat: "ch1", turnInbound: "m4" });

    const intrRow: AgentInput = { ...queuedRow, id: "in-int", queueReason: "after_interrupt", body: "bang", trace: "m-int" };
    const intrEnd = route(
      makeState("dsh", { state: "running", interruptedAt: ctx.now - 100, turnChat: "ch1", turnInbound: "m-int" }, [intrRow, queuedRow]),
      { kind: "agent", event: { type: "turn_end", conv: "c1", proc: 1, reply: "cut" } },
      ctx,
    );
    const intrReleased = intrEnd.writes.filter(
      (w): w is Extract<Decision["writes"][number], { op: "update"; table: "agentInput" }> =>
        w.op === "update" && w.table === "agentInput" && (w.patch as { queueReason?: unknown }).queueReason === null,
    );
    expect(intrReleased.some((w) => (w.where as { id?: string; queueReason?: string }).queueReason === "after_turn" || (w.where as { id?: string }).id === "in-1")).toBe(false);

    const wakeInternalTurn = route(
      makeState("dsh", { state: "running", turnChat: null, turnInbound: null }),
      { kind: "rh", id: "r-wake", caller: AT_BOARD, argv: ["send", "work/main", "internal ping"] },
      ctx,
    );
    expect(wakeInternalTurn.effects.some((e) => e.kind === "deliver")).toBe(false);
    expect(wakeInternalTurn.writes.find((w) => w.op === "insert" && w.table === "agentInput")).toMatchObject({
      row: { queueReason: "after_turn", source: "rh" },
    });

    // Must-Fix 2: [plugins.claude] disabled/failed in ctx.plugins never breaks built-in claude
    const shadowedCtx = routerCtx(root, {
      ...reg,
      plugins: {
        ...reg.plugins,
        claude: { id: "claude", status: "disabled", dir: "/tmp/shadow-claude" },
      },
    });
    expect(rhReply(route(makeState("claude"), { kind: "rh", id: "r-builtin-new", caller: AT_BOARD, argv: ["new", "work/c2", "--agent", "claude"] }, shadowedCtx))?.ok).toBe(true);
    const claudeIm = route(
      makeState("claude"),
      { kind: "im", message: { bot: "b1", chat: "u1", sender: "u1", messageId: "m-cl", at: ctx.now, text: "hi claude" } },
      shadowedCtx,
    );
    expect(claudeIm.effects.some((e) => e.kind === "deliver")).toBe(true);
    expect(rhReply(route(makeState("claude"), { kind: "board", id: "b-cl", act: { kind: "common", slot: "s1", name: "compact" } }, shadowedCtx))).toBeUndefined();

    // Must-Fix 3: boardCommon on disabled / failed plugin slot reports plugin disabled/load-failed error instead of unsupported command
    const boardCommonDisabled = route(
      makeState("offp"),
      { kind: "board", id: "b-offp", act: { kind: "common", slot: "s1", name: "compact" } },
      ctx,
    );
    expect(rhReply(boardCommonDisabled)).toEqual({ ok: false, error: "插件 offp 已禁用，请启用或切换对话" });

    const boardCommonFailed = route(
      makeState("badp"),
      { kind: "board", id: "b-badp", act: { kind: "common", slot: "s1", name: "model" } },
      ctx,
    );
    const bcfReply = rhReply(boardCommonFailed);
    expect(bcfReply?.ok).toBe(false);
    if (bcfReply && !bcfReply.ok) expect(bcfReply.error).toStartWith("插件 badp 加载失败：");

    // Safe non-builtin transcript fallbacks
    expect(await hasTranscript("dsh", "s1")).toBe(false);
    expect(await transcriptFile("/tmp", "dsh", "s1")).toBeNull();
    expect(await listConversations("dsh")).toEqual([]);
  });

  test("records configErrors when [bots.<name>].platform references an agent plugin or [programs].<id> references an IM plugin while keeping valid plugins loaded", () => {
    const root = tempDir();
    const cfgPath = join(root, "config.toml");
    const echoDir = resolve(import.meta.dir, "../examples/plugins/echo-agent");
    const localImDir = resolve(import.meta.dir, "../examples/plugins/local-im");
    writeFileSync(
      cfgPath,
      [
        `stateDir = ${JSON.stringify(join(root, "state"))}`,
        `[plugins.echo-agent]`,
        `path = ${JSON.stringify(echoDir)}`,
        `[plugins.local-im]`,
        `path = ${JSON.stringify(localImDir)}`,
        `[programs]`,
        `local-im = "foo"`,
        `[bots.x]`,
        `platform = "echo-agent"`,
        `[bots.ok]`,
        `platform = "local-im"`,
      ].join("\n"),
      { mode: 0o600 },
    );
    const cfg = loadConfig(cfgPath);
    const reg = loadPlugins(cfg.plugins, {
      coreVersion: "1.5.0",
      agentPath: process.env.PATH ?? "",
      bots: cfg.bots,
      programs: cfg.programs,
      register: true,
    });
    expect(reg.loaded.map((p) => p.id).sort()).toEqual(["echo-agent", "local-im"]);
    expect(reg.configErrors.map((e) => e.key)).toEqual(["bots.x.platform", "programs.local-im"]);
    const doc = pluginFindings(reg);
    expect(doc.findings).toContainEqual({
      level: "错误",
      text: "bots.x.platform 引用了 agent 插件 echo-agent，不能作为 IM 平台",
    });
    expect(doc.findings).toContainEqual({
      level: "错误",
      text: "programs.local-im 引用了 im 插件 local-im，不能作为 agent 程序",
    });
  });

  test("a live plugin's negotiated capabilities and fatal exit govern routing", () => {
    registerAgentPlugin("demo", { name: "demo", statusName: "demo", steer: true, supportedCommands: ["model"] });
    const ctx = { ...routerCtx(tempDir(), loadPlugins({})), pluginCaps: () => ({ steer: false, commands: [] }) };
    const state = makeState("demo", { state: "running", turnChat: "ch1" });
    const im = (text: string) => route(state, { kind: "im", message: { bot: "b1", chat: "u1", sender: "u1", messageId: "m", at: ctx.now, text } }, ctx);
    expect(im("later").writes).toContainEqual(expect.objectContaining({ table: "agentInput", row: expect.objectContaining({ queueReason: "after_turn" }) }));
    expect(outboundTexts(im("/model")).join(" ")).toContain("该 agent 不支持此命令");
    for (const background of [true, false]) {
      const end = route(state, { kind: "agent", event: { type: "turn_end", proc: 1, conv: "c1", ...(background && { background: true }) } }, ctx);
      expect(end.writes).toContainEqual({ op: "update", table: "conversation", where: { id: "c1" }, patch: { background: background ? 1 : 0 } });
    }
    const died = route(state, { kind: "agent", event: { type: "exit", from: "agent", conv: "c1", proc: 1, code: 1, signal: null, why: "bad config", retryable: false } }, ctx);
    expect(slotPatch(died).state).toBe("off");
    expect(died.effects.some((e) => e.kind === "start")).toBe(false);
  });
});
