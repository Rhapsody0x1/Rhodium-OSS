import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { headlessEnv, registerAgentPlugin, resetAgentPlugins, terminalUnset } from "../src/agents";
import { pluginFindings } from "../src/doctor";
import { auditPluginProcessTree, checkProcessCompliance, descendantPids, isClaudeExecutable, launchesClaude } from "../src/pi-pane-credentials";
import { resetPluginRegistry } from "../src/plugin-loader";

const dirs: string[] = [];
const procs: { pid: number; kill: () => void }[] = [];

afterEach(() => {
  resetPluginRegistry();
  resetAgentPlugins();
  while (procs.length) {
    try {
      procs.pop()!.kill();
    } catch {}
  }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("mixed-case credential and session env isolation", () => {
  const dirtyEnv: Record<string, string> = {
    PATH: "/usr/bin:/bin",
    HOME: "/tmp/safe-home",
    SAFE_PLUGIN_VAR: "keep-me",
    Anthropic_Api_Key: "sk-ant-mixed-1",
    anthropic_base_url: "https://example.invalid",
    CLAUDE_code_oauth_token: "oauth-mixed-2",
    ClaudeCode: "1",
    Claude_Effort: "high",
    CLAUDE_CODE_RESUME_INTERRUPTED_TURN: "1",
    HERDR_SESSION: "sess-1",
    Herdr_Socket: "/tmp/herdr.sock",
    Codex_Thread_Id: "codex-1",
    Ai_Agent: "1",
  };

  test("strips Anthropic, Claude, Herdr, and parent session vars case-insensitively for plugins, unregistered agents, and pi, while preserving Claude auth on claude", () => {
    registerAgentPlugin("dsh", { name: "DeepSeek Harness", statusName: "DeepSeek Harness" });

    for (const kind of ["dsh", "unregistered-plugin", "pi"] as const) {
      const cleaned = headlessEnv(kind, dirtyEnv);
      expect(cleaned).toEqual({
        PATH: "/usr/bin:/bin",
        HOME: "/tmp/safe-home",
        SAFE_PLUGIN_VAR: "keep-me",
      });

      const unset = terminalUnset(kind, dirtyEnv);
      expect(unset).toContain("Anthropic_Api_Key");
      expect(unset).toContain("anthropic_base_url");
      expect(unset).toContain("CLAUDE_code_oauth_token");
      expect(unset).toContain("ClaudeCode");
      expect(unset).toContain("Claude_Effort");
      expect(unset).toContain("CLAUDE_CODE_RESUME_INTERRUPTED_TURN");
      expect(unset).not.toContain("SAFE_PLUGIN_VAR");
    }

    const claudeEnv = headlessEnv("claude", dirtyEnv);
    expect(claudeEnv).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/tmp/safe-home",
      SAFE_PLUGIN_VAR: "keep-me",
      Anthropic_Api_Key: "sk-ant-mixed-1",
      anthropic_base_url: "https://example.invalid",
      CLAUDE_CODE_RESUME_INTERRUPTED_TURN: "1",
    });
    expect(terminalUnset("claude", dirtyEnv)).toEqual([]);
  });

  test("async Bun.spawn child spawned with headlessEnv sees stripped mixed-case variables absent", async () => {
    registerAgentPlugin("dsh", { name: "DeepSeek Harness", statusName: "DeepSeek Harness" });
    const child = Bun.spawn([process.execPath, "-e", "console.log(JSON.stringify(process.env))"], {
      env: headlessEnv("dsh", dirtyEnv),
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(child.stdout).text();
    const code = await child.exited;
    expect(code).toBe(0);
    const seen = JSON.parse(out) as Record<string, string | undefined>;
    expect(seen.SAFE_PLUGIN_VAR).toBe("keep-me");
    expect(seen.Anthropic_Api_Key).toBeUndefined();
    expect(seen.anthropic_base_url).toBeUndefined();
    expect(seen.CLAUDE_code_oauth_token).toBeUndefined();
    expect(seen.Herdr_Socket).toBeUndefined();
    expect(seen.HERDR_SESSION).toBeUndefined();
    expect(seen.ClaudeCode).toBeUndefined();
  });
});

describe("plugin process subtree compliance audit and doctor findings", () => {
  test("checkProcessCompliance flags --bare, CLAUDE_CODE_SIMPLE, mixed-case Anthropic/Claude keys, and path-aware claude launches without false positives", () => {
    expect(isClaudeExecutable("/opt/Claude Tools/pi")).toBe(false);
    expect(isClaudeExecutable("/opt/Claude Tools/claude")).toBe(true);
    expect(isClaudeExecutable("claude.exe")).toBe(true);
    expect(isClaudeExecutable("claude.cmd")).toBe(true);

    expect(checkProcessCompliance(["bun", "run", "/tmp/dsh/index.js"], ["PATH=/usr/bin", "HOME=/tmp/h"])).toEqual({
      bare: false,
      anthropic: false,
      claudeExec: false,
    });

    // Negative controls: "claude" as a grep argument or parent directory name must not trigger claudeExec
    expect(checkProcessCompliance(["rg", "-n", "claude", "README.md"], ["PATH=/usr/bin"])).toEqual({
      bare: false,
      anthropic: false,
      claudeExec: false,
    });
    expect(checkProcessCompliance(["/opt/Claude Tools/pi", "--version"], ["PATH=/usr/bin"])).toEqual({
      bare: false,
      anthropic: false,
      claudeExec: false,
    });

    expect(checkProcessCompliance(["node", "p.js", "--bare"], ["PATH=/usr/bin"])).toEqual({
      bare: true,
      anthropic: false,
      claudeExec: false,
    });

    expect(checkProcessCompliance(["bun", "p.js"], ["Claude_Code_Simple=1"])).toEqual({
      bare: true,
      anthropic: true,
      claudeExec: false,
    });

    expect(checkProcessCompliance(["bun", "p.js"], ["Anthropic_Api_Key=", "Claude_Effort=high"])).toEqual({
      bare: false,
      anthropic: true,
      claudeExec: false,
    });

    expect(checkProcessCompliance(["bun", "p.js"], ["Anthropic_Api_Key=secret"])).toEqual({
      bare: false,
      anthropic: true,
      claudeExec: false,
    });

    // Positive controls for direct and wrapper-launched claude
    for (const argv of [
      ["claude"],
      ["/usr/local/bin/claude.exe", "-p", "hi"],
      ["/usr/bin/env", "FOO=1", "claude"],
      ["node", "/opt/node_modules/@anthropic-ai/claude-code/cli.js"],
      ["sh", "-c", "exec claude -p hi"],
    ]) {
      expect(launchesClaude(argv)).toBe(true);
      expect(checkProcessCompliance(argv, ["PATH=/usr/bin"])).toEqual({
        bare: false,
        anthropic: false,
        claudeExec: true,
      });
    }
  });

  test("descendantPids, auditPluginProcessTree, and pluginFindings catch rogue descendant process", async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "rhodium-proc-"));
    dirs.push(tmpHome);
    const pkgDir = join(tmpHome, "node_modules", "@anthropic-ai", "claude-code");
    mkdirSync(pkgDir, { recursive: true });
    const sleeper = join(pkgDir, "cli.js");
    writeFileSync(sleeper, "setInterval(() => {}, 1000);\n");
    // Spawn parent plugin-like bun process which itself spawns a child holding --bare, mixed-case env, and @anthropic-ai/claude-code target (never running real claude).
    const parent = Bun.spawn(
      [
        process.execPath,
        "-e",
        [
          `const child = Bun.spawn([process.execPath, "run", ${JSON.stringify(sleeper)}, "--bare"], {`,
          `  env: { ...process.env, Anthropic_Api_Key: "bad-key" },`,
          `  stdout: "ignore", stderr: "ignore"`,
          `});`,
          `console.log(String(child.pid));`,
          `process.on("SIGTERM", () => { try { child.kill(); } catch {} process.exit(0); });`,
          `setInterval(() => {}, 1000);`,
        ].join("\n"),
      ],
      { stdout: "pipe", stderr: "ignore", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: tmpHome } },
    );
    procs.push({ pid: parent.pid, kill: () => parent.kill() });

    const reader = parent.stdout.getReader();
    let buf = "";
    while (!buf.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
    }
    reader.releaseLock();
    const childPid = Number(buf.trim());
    expect(Number.isInteger(childPid) && childPid > 0).toBe(true);
    procs.push({
      pid: childPid,
      kill: () => process.kill(childPid, "SIGKILL"),
    });

    // Brief settle so child /proc/<pid>/cmdline and environ are populated before audit.
    await Bun.sleep(50);

    const pids = descendantPids(parent.pid);
    expect(pids).toContain(parent.pid);
    if (process.platform === "linux") {
      expect(pids).toContain(childPid);

      const results = auditPluginProcessTree(parent.pid);
      const childRes = results.find((r) => r.pid === childPid);
      expect(childRes).toBeDefined();
      expect(childRes).toMatchObject({
        pid: childPid,
        bare: true,
        anthropic: true,
        claudeExec: true,
      });

      const doc = pluginFindings(
        {
          plugins: {
            dsh: {
              id: "dsh",
              status: "loaded",
              dir: "/tmp/dsh",
              command: ["bun", "run", "/tmp/dsh/index.js"],
              manifest: {
                manifestVersion: 1,
                kind: "agent",
                id: "dsh",
                name: "DeepSeek Harness",
                statusName: "DeepSeek Harness",
                version: "0.1.0",
                protocol: "rh-agent/1",
                minRhodium: "1.5.0",
                program: "dsh",
                command: ["bun", "run", "${PLUGIN_DIR}/index.js"],
                capabilities: {},
              },
            },
            offp: { id: "offp", status: "disabled", dir: "/tmp/offp" },
            badp: { id: "badp", status: "failed", dir: "/tmp/badp", error: "bad manifest" },
          },
          loaded: [],
          failed: [{ id: "badp", error: "bad manifest" }],
          disabled: ["offp"],
          configErrors: [],
        },
        [{ id: "dsh", pid: parent.pid }],
      );

      expect(doc.info.some((l) => l.includes("dsh"))).toBe(true);
      expect(doc.info.some((l) => l.includes("offp") && l.includes("已禁用"))).toBe(true);
      expect(doc.findings).toContainEqual({ level: "错误", text: "插件 badp 加载失败：bad manifest" });
      expect(doc.findings.some((f) => f.level === "错误" && f.text.includes("dsh") && f.text.includes(String(childPid)))).toBe(true);
    }
  });
});
