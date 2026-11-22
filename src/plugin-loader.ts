import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  AGENT_RESERVED_IDS,
  checkPluginIcon,
  compareSemver,
  expandPluginCommand,
  IM_RESERVED_IDS,
  validateImCapabilities,
  validateManifest,
  type AgentPluginManifest,
  type ImPluginManifest,
  type PluginManifest,
} from "@rhodium-oss/plugin-sdk";
import { version as CORE_VERSION } from "../package.json";
import { isBuiltinAgent, registerAgentPlugin, resetAgentPlugins } from "./agents";
import { locate, type BotConfig, type PluginConfigEntry } from "./config";
import { COMMON, type Capabilities, type CommonCommand } from "./contracts";
import { isBuiltinPlatform, registerPlatformPlugin, resetPlatformPlugins } from "./platforms";

export type { PluginConfigEntry } from "./config";

// icon: the real path of a usable icon; iconError: why the manifest's icon is unusable (spec §4.6).
export type LoadedPlugin = {
  id: string;
  dir: string;
  manifest: PluginManifest;
  command: string[];
  icon?: string;
  iconError?: string;
};

type Source = { source: "scan" | "config" };
export type PluginRecord = Source &
  (
    | ({ status: "loaded" } & LoadedPlugin)
    | { id: string; status: "disabled"; dir: string }
    | { id: string; status: "failed"; dir: string; error: string }
  );

export type PluginRegistry = {
  plugins: Record<string, PluginRecord>;
  loaded: LoadedPlugin[];
  failed: { id: string; error: string }[];
  disabled: string[];
  configErrors: { key: string; pluginId: string; error: string }[];
};

const PLAIN_FALLBACK_CAPABILITIES: Capabilities = {
  progress: "append",
  buttons: false,
  menu: { scope: "global", maxItems: 0 },
  maxTextLength: 2000,
  maxFileBytes: { image: 10 * 1024 * 1024, file: 25 * 1024 * 1024 },
  sendLimit: { kind: "rate", perChatPerSecond: 1 },
  markdown: null,
};

function commandExists(cmd0: string, agentPath: string): string | null {
  if (!cmd0) return "command[0] must be non-empty";
  if (isAbsolute(cmd0) || cmd0.includes("/") || cmd0.includes("\\")) {
    try {
      if (!existsSync(cmd0) || statSync(cmd0).isDirectory()) return `command executable not found: ${cmd0}`;
    } catch {
      return `command executable not found: ${cmd0}`;
    }
    return null;
  }
  const resolved = locate(cmd0, agentPath);
  if (!resolved || !existsSync(resolved)) return `command executable not found on PATH: ${cmd0}`;
  return null;
}

const hasValue = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

function checkRequiredConfig(
  id: string,
  manifest: PluginManifest,
  entry: PluginConfigEntry,
  bots: Record<string, BotConfig>,
): string | null {
  const req = manifest.requiredConfig ?? [];
  if (!req.length) return null;
  if (manifest.kind === "agent") {
    const missing = req.filter((k) => !hasValue(entry.config[k]));
    return missing.length ? `missing required config: ${missing.join(", ")}` : null;
  }
  for (const [botName, bot] of Object.entries(bots)) {
    if (bot.platform !== id) continue;
    const merged: Record<string, unknown> = { ...entry.config, ...bot };
    const missing = req.filter((k) => !hasValue(merged[k]));
    if (missing.length) return `missing required config for bot ${botName}: ${missing.join(", ")}`;
  }
  return null;
}

function loadOne(
  id: string,
  entry: PluginConfigEntry,
  opts: { coreVersion: string; agentPath: string; bots: Record<string, BotConfig>; platform: string },
): { ok: true; plugin: LoadedPlugin } | { ok: false; error: string } {
  const dir = resolve(entry.path);
  let dirExists = false;
  try {
    dirExists = existsSync(dir) && statSync(dir).isDirectory();
  } catch {
    dirExists = false;
  }
  if (!dirExists) return { ok: false, error: `plugin directory not found: ${dir}` };

  const manifestPath = join(dir, "plugin.json");
  if (!existsSync(manifestPath)) return { ok: false, error: `plugin.json not found in ${dir}` };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    return { ok: false, error: `invalid plugin.json: ${(err as Error).message}` };
  }

  const valid = validateManifest(parsed);
  if (!valid.ok) return { ok: false, error: valid.error };

  const { manifest } = valid;
  if (manifest.id !== id) return { ok: false, error: `manifest.id "${manifest.id}" does not match plugins.${id}` };
  if (
    isBuiltinAgent(id) ||
    isBuiltinPlatform(id) ||
    (AGENT_RESERVED_IDS as readonly string[]).includes(id) ||
    (IM_RESERVED_IDS as readonly string[]).includes(id)
  ) {
    return { ok: false, error: `plugin id "${id}" collides with built-in` };
  }
  if (compareSemver(opts.coreVersion, manifest.minRhodium) < 0) {
    return { ok: false, error: `requires rhodium >= ${manifest.minRhodium} (current ${opts.coreVersion})` };
  }

  const command = expandPluginCommand(manifest, dir, opts.platform);
  const cmdErr = commandExists(command[0] ?? "", opts.agentPath);
  if (cmdErr) return { ok: false, error: cmdErr };

  const cfgErr = checkRequiredConfig(id, manifest, entry, opts.bots);
  if (cfgErr) return { ok: false, error: cfgErr };

  if (manifest.icon === undefined) return { ok: true, plugin: { id, dir, manifest, command } };
  const icon = checkPluginIcon(dir, manifest.icon);
  return { ok: true, plugin: { id, dir, manifest, command, ...(icon.ok ? { icon: icon.path } : { iconError: icon.error }) } };
}

function registerAgentFromManifest(m: AgentPluginManifest): void {
  const supported = (m.capabilities.commands ?? []).filter((c): c is CommonCommand =>
    (COMMON as readonly string[]).includes(c),
  );
  registerAgentPlugin(m.id, {
    name: m.name,
    statusName: m.statusName,
    program: m.program,
    liveApproval: m.capabilities.liveApproval ? "now" : false,
    steer: Boolean(m.capabilities.steer),
    modelNames: (m.capabilities.models?.length ?? 0) > 0,
    supportedCommands: supported,
    importable: m.import === true,
  });
}

function registerPlatformFromManifest(m: ImPluginManifest): void {
  const checked = validateImCapabilities(m.capabilities);
  const caps = checked.ok ? checked.capabilities : PLAIN_FALLBACK_CAPABILITIES;
  registerPlatformPlugin(m.id, {
    label: m.label,
    capabilities: () => caps,
  });
}

export function resetPluginRegistry(): void {
  resetAgentPlugins();
  resetPlatformPlugins();
}

export function applyPluginRegistry(registry: PluginRegistry): void {
  resetPluginRegistry();
  for (const p of registry.loaded) {
    if (p.manifest.kind === "agent") registerAgentFromManifest(p.manifest);
    else registerPlatformFromManifest(p.manifest);
  }
}

export function loadPlugins(
  entries: Record<string, PluginConfigEntry>,
  opts: {
    coreVersion?: string;
    agentPath?: string;
    bots?: Record<string, BotConfig>;
    programs?: Record<string, string>;
    platform?: string;
    register?: boolean;
  } = {},
): PluginRegistry {
  const resolvedOpts = {
    coreVersion: opts.coreVersion ?? CORE_VERSION,
    agentPath: opts.agentPath ?? (process.env.PATH ?? ""),
    bots: opts.bots ?? {},
    platform: opts.platform ?? process.platform,
  };
  const records: [string, PluginRecord][] = [];
  const loaded: LoadedPlugin[] = [];
  const failed: { id: string; error: string }[] = [];
  const disabled: string[] = [];

  for (const [id, entry] of Object.entries(entries)) {
    const source = entry.source ?? "config";
    if (!entry.enabled) {
      disabled.push(id);
      records.push([id, { id, status: "disabled", dir: entry.path, source }]);
      continue;
    }
    const fail = (error: string) => {
      failed.push({ id, error });
      records.push([id, { id, status: "failed", dir: entry.path ? resolve(entry.path) : "", error, source }]);
    };
    if (entry.configError) {
      fail(entry.configError);
      continue;
    }
    try {
      const res = loadOne(id, entry, resolvedOpts);
      if (res.ok) {
        loaded.push(res.plugin);
        records.push([id, { ...res.plugin, status: "loaded", source }]);
      } else fail(res.error);
    } catch (err) {
      fail((err as Error).message || String(err));
    }
  }

  const pluginsMap = Object.fromEntries(records);
  const configErrors: { key: string; pluginId: string; error: string }[] = [];
  for (const [botName, bot] of Object.entries(resolvedOpts.bots)) {
    if (isBuiltinPlatform(bot.platform)) continue;
    const rec = pluginsMap[bot.platform];
    if (rec?.status === "loaded" && rec.manifest.kind !== "im") {
      configErrors.push({
        key: `bots.${botName}.platform`,
        pluginId: bot.platform,
        error: `bots.${botName}.platform 引用了 ${rec.manifest.kind} 插件 ${bot.platform}，不能作为 IM 平台`,
      });
    }
  }
  for (const progKey of Object.keys(opts.programs ?? {})) {
    if (isBuiltinAgent(progKey) || progKey === "herdr") continue;
    const rec = pluginsMap[progKey];
    if (rec?.status === "loaded" && rec.manifest.kind !== "agent") {
      configErrors.push({
        key: `programs.${progKey}`,
        pluginId: progKey,
        error: `programs.${progKey} 引用了 ${rec.manifest.kind} 插件 ${progKey}，不能作为 agent 程序`,
      });
    }
  }

  const registry: PluginRegistry = {
    plugins: pluginsMap,
    loaded,
    failed,
    disabled,
    configErrors,
  };
  if (opts.register) applyPluginRegistry(registry);
  return registry;
}
