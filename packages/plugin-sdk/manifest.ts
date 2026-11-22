import { realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, posix, relative, resolve as pathResolve, sep, win32 } from "node:path";

export const AGENT_RESERVED_IDS = ["claude", "pi", "codex", "herdr"] as const;
export const IM_RESERVED_IDS = ["qq", "telegram", "feishu", "fake", "me", "web"] as const;
export const PLUGIN_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;

export type PluginKind = "agent" | "im";

export type MarkdownExtension = "html" | "math" | "spoiler" | "mark" | "emoji" | "heading";

const VALID_MARKDOWN_EXTENSIONS = new Set<string>(["html", "math", "spoiler", "mark", "emoji", "heading"]);

export type MarkdownCapabilities = {
  extensions: MarkdownExtension[];
  links?: "http";
  literal?: true;
  details?: true;
};

export type Capabilities = {
  progress: "append" | "edit";
  editEvery?: number;
  finalEdit?: true;
  draftTtl?: number;
  panels?: true;
  stream?: number;
  buttons: boolean | "markdown";
  maxButtons?: number;
  copy?: number;
  sendLimit: { kind: "rate"; perChatPerSecond: number };
  menu: { scope: "global" | "per_chat"; maxItems: number; row?: "custom_menu" | "reply_keyboard" };
  maxTextLength: number;
  maxFileBytes: { image: number; file: number };
  markdown: MarkdownCapabilities | null;
};

export type AgentCapabilitiesStatic = {
  liveApproval?: boolean;
  steer?: boolean;
  commands?: string[];
  models?: { id: string; label?: string; efforts?: string[] }[];
};

type ManifestBase = {
  manifestVersion: 1;
  id: string;
  name: string;
  version: string;
  minRhodium: string;
  command: string[];
  commandByPlatform?: Record<string, string[]>;
  requiredConfig?: string[];
  optionalConfig?: string[];
  /** An SVG or PNG inside the plugin directory; checkPluginIcon decides whether it is usable. */
  icon?: string;
};

export type AgentPluginManifest = ManifestBase & {
  kind: "agent";
  statusName: string;
  protocol: "rh-agent/1";
  program: string;
  capabilities: AgentCapabilitiesStatic;
  /** Answers the one-shot import query (spec §3.5). */
  import?: boolean;
};

export type ImPluginManifest = ManifestBase & {
  kind: "im";
  label: string;
  protocol: "rh-im/1";
  capabilities: Capabilities;
  /** Runs the rh bot wizard (spec §3.6). */
  wizard?: boolean;
};

export type PluginManifest = AgentPluginManifest | ImPluginManifest;

export type ValidationResult<T> = { ok: true; value: T };
export type ValidationFailure = { ok: false; error: string; errors: string[] };

const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

type ParsedSemver = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
};

function parseSemver(value: string): ParsedSemver | null {
  const m = SEMVER_RE.exec(value);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split(".") : [],
  };
}

/** Check whether a string is a valid SemVer 2.0.0 version. */
export function isValidSemver(value: string): boolean {
  return typeof value === "string" && parseSemver(value) !== null;
}

/** Compare two valid SemVer 2.0.0 strings (-1, 0, or 1). */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) {
    throw new Error(`Invalid semver comparison: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  }
  for (const [x, y] of [
    [pa.major, pb.major],
    [pa.minor, pb.minor],
    [pa.patch, pb.patch],
  ] as const) {
    if (x !== y) return x < y ? -1 : 1;
  }
  if (pa.prerelease.length === 0 && pb.prerelease.length === 0) return 0;
  if (pa.prerelease.length === 0) return 1;
  if (pb.prerelease.length === 0) return -1;

  const len = Math.max(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < len; i++) {
    const ia = pa.prerelease[i];
    const ib = pb.prerelease[i];
    if (ia === undefined) return -1;
    if (ib === undefined) return 1;
    const na = /^\d+$/.test(ia) ? Number(ia) : null;
    const nb = /^\d+$/.test(ib) ? Number(ib) : null;
    if (na !== null && nb !== null) {
      if (na !== nb) return na < nb ? -1 : 1;
    } else if (na !== null) {
      return -1;
    } else if (nb !== null) {
      return 1;
    } else if (ia !== ib) {
      return ia < ib ? -1 : 1;
    }
  }
  return 0;
}

const CLAUDE_BIN_RE = /^claude(?:\.(?:exe|cmd))?$/i;

function isClaudeExecutableLeaf(segment: string): boolean {
  if (!segment) return false;
  const leaf = segment.split(/[\\/]/).pop() ?? "";
  return CLAUDE_BIN_RE.test(leaf);
}

/**
 * Reject claude, claude.exe, and claude.cmd case-insensitively across bare names,
 * filesystem paths, key=value flags/assignments, and shell-embedded tokens.
 */
export function isForbiddenClaudeToken(token: string): boolean {
  if (typeof token !== "string") return false;
  const trimmed = token.trim();
  if (!trimmed) return false;

  const shellParts = trimmed.split(/[\s"'`$|&;()<>]+/).filter(Boolean);
  for (const part of shellParts) {
    if (isClaudeExecutableLeaf(part)) return true;
    const eqIdx = part.indexOf("=");
    if (eqIdx >= 0) {
      const afterFirstEq = part.slice(eqIdx + 1);
      if (isClaudeExecutableLeaf(afterFirstEq)) return true;
      const eqParts = part.split("=").slice(1);
      for (const rhs of eqParts) {
        if (isClaudeExecutableLeaf(rhs)) return true;
        for (const commaItem of rhs.split(",")) {
          if (isClaudeExecutableLeaf(commaItem)) return true;
        }
      }
    }
  }
  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveFiniteInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeFiniteInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function validateStringList(value: unknown, field: string, errors: string[]): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => !isNonEmptyString(item))) {
    errors.push(`${field} must be an array of non-empty strings`);
    return undefined;
  }
  return value as string[];
}

function validateCommandArray(value: unknown, field: string, errors: string[]): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${field} must be a non-empty array of strings`);
    return undefined;
  }
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (!isNonEmptyString(item)) {
      errors.push(`${field}[${i}] must be a non-empty string`);
      return undefined;
    }
    if (isForbiddenClaudeToken(item)) {
      errors.push(`${field}[${i}] references forbidden claude executable`);
    }
  }
  return value as string[];
}

/** Validate runtime and static IM Capabilities according to rh-im/1 rules. */
export function validateImCapabilities(
  raw: unknown,
): { ok: true; capabilities: Capabilities } | ValidationFailure {
  const errors: string[] = [];
  if (!isPlainObject(raw)) {
    return { ok: false, error: "capabilities must be an object", errors: ["capabilities must be an object"] };
  }

  if (raw.progress !== "append" && raw.progress !== "edit") {
    errors.push('capabilities.progress must be "append" or "edit"');
  }
  if (raw.editEvery !== undefined && (typeof raw.editEvery !== "number" || !Number.isFinite(raw.editEvery) || raw.editEvery < 0)) {
    errors.push("capabilities.editEvery must be a finite non-negative number");
  }
  if (raw.finalEdit !== undefined && raw.finalEdit !== true) {
    errors.push("capabilities.finalEdit must be true when specified");
  }
  if (raw.draftTtl !== undefined && (typeof raw.draftTtl !== "number" || !Number.isFinite(raw.draftTtl) || raw.draftTtl <= 0)) {
    errors.push("capabilities.draftTtl must be a positive number");
  }
  if (raw.panels !== undefined && raw.panels !== true) {
    errors.push("capabilities.panels must be true when specified");
  }
  if (raw.stream !== undefined && (typeof raw.stream !== "number" || !Number.isFinite(raw.stream) || raw.stream <= 0)) {
    errors.push("capabilities.stream must be a positive number");
  }
  if (typeof raw.buttons !== "boolean" && raw.buttons !== "markdown") {
    errors.push('capabilities.buttons must be boolean or "markdown"');
  }
  if (raw.maxButtons !== undefined && !isPositiveFiniteInt(raw.maxButtons)) {
    errors.push("capabilities.maxButtons must be a positive integer");
  }
  if (raw.copy !== undefined && !isPositiveFiniteInt(raw.copy)) {
    errors.push("capabilities.copy must be a positive integer");
  }

  if (!isPlainObject(raw.sendLimit)) {
    errors.push("capabilities.sendLimit must be an object");
  } else {
    if (raw.sendLimit.kind === "qq_quota") {
      errors.push('capabilities.sendLimit.kind "qq_quota" is reserved for built-in QQ');
    } else if (raw.sendLimit.kind !== "rate") {
      errors.push('capabilities.sendLimit.kind must be "rate"');
    }
    if (
      typeof raw.sendLimit.perChatPerSecond !== "number" ||
      !Number.isFinite(raw.sendLimit.perChatPerSecond) ||
      raw.sendLimit.perChatPerSecond <= 0
    ) {
      errors.push("capabilities.sendLimit.perChatPerSecond must be a positive number");
    }
  }

  if (!isPlainObject(raw.menu)) {
    errors.push("capabilities.menu must be an object");
  } else {
    if (raw.menu.scope !== "global" && raw.menu.scope !== "per_chat") {
      errors.push('capabilities.menu.scope must be "global" or "per_chat"');
    }
    if (!isNonNegativeFiniteInt(raw.menu.maxItems)) {
      errors.push("capabilities.menu.maxItems must be a non-negative integer");
    }
    if (raw.menu.row !== undefined && raw.menu.row !== "custom_menu" && raw.menu.row !== "reply_keyboard") {
      errors.push('capabilities.menu.row must be "custom_menu" or "reply_keyboard"');
    }
  }

  if (!isPositiveFiniteInt(raw.maxTextLength)) {
    errors.push("capabilities.maxTextLength must be a positive integer");
  }

  if (!isPlainObject(raw.maxFileBytes)) {
    errors.push("capabilities.maxFileBytes must be an object");
  } else {
    if (!isNonNegativeFiniteInt(raw.maxFileBytes.image)) {
      errors.push("capabilities.maxFileBytes.image must be a non-negative integer");
    }
    if (!isNonNegativeFiniteInt(raw.maxFileBytes.file)) {
      errors.push("capabilities.maxFileBytes.file must be a non-negative integer");
    }
  }

  if (!Object.hasOwn(raw, "markdown") || raw.markdown === undefined) {
    errors.push("capabilities.markdown must be explicitly provided (null or object)");
  } else if (raw.markdown !== null) {
    if (!isPlainObject(raw.markdown)) {
      errors.push("capabilities.markdown must be null or an object");
    } else {
      if (!Array.isArray(raw.markdown.extensions)) {
        errors.push("capabilities.markdown.extensions must be an array");
      } else {
        for (const ext of raw.markdown.extensions) {
          if (typeof ext !== "string" || !VALID_MARKDOWN_EXTENSIONS.has(ext)) {
            errors.push(`capabilities.markdown.extensions contains invalid entry: ${String(ext)}`);
          }
        }
      }
      if (raw.markdown.links !== undefined && raw.markdown.links !== "http") {
        errors.push('capabilities.markdown.links must be "http" when specified');
      }
      if (raw.markdown.literal !== undefined && raw.markdown.literal !== true) {
        errors.push("capabilities.markdown.literal must be true when specified");
      }
      if (raw.markdown.details !== undefined && raw.markdown.details !== true) {
        errors.push("capabilities.markdown.details must be true when specified");
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, error: errors.join("; "), errors };
  }
  return { ok: true, capabilities: raw as Capabilities };
}

function validateAgentCapabilitiesStatic(raw: unknown, errors: string[]): void {
  if (!isPlainObject(raw)) {
    errors.push("capabilities must be an object for agent plugins");
    return;
  }
  if (raw.liveApproval !== undefined && typeof raw.liveApproval !== "boolean") {
    errors.push("capabilities.liveApproval must be a boolean");
  }
  if (raw.steer !== undefined && typeof raw.steer !== "boolean") {
    errors.push("capabilities.steer must be a boolean");
  }
  if (raw.commands !== undefined) {
    validateStringList(raw.commands, "capabilities.commands", errors);
  }
  if (raw.models !== undefined) {
    if (!Array.isArray(raw.models)) {
      errors.push("capabilities.models must be an array");
    } else {
      for (let i = 0; i < raw.models.length; i++) {
        const model = raw.models[i];
        if (!isPlainObject(model) || !isNonEmptyString(model.id)) {
          errors.push(`capabilities.models[${i}].id must be a non-empty string`);
          continue;
        }
        if (model.label !== undefined && typeof model.label !== "string") {
          errors.push(`capabilities.models[${i}].label must be a string`);
        }
        if (model.efforts !== undefined) {
          validateStringList(model.efforts, `capabilities.models[${i}].efforts`, errors);
        }
      }
    }
  }
}

export const MAX_ICON_BYTES = 256 * 1024;

/** Where a manifest's icon is (its real path), or why it is unusable (spec §4.6): a relative .svg or
 *  .png path that stays inside the plugin directory after resolving symlinks, a regular file of at most
 *  256KB. An unusable icon never fails the manifest; the plugin just has none. */
export function checkPluginIcon(dir: string, icon: unknown): { ok: true; path: string } | { ok: false; error: string } {
  if (typeof icon !== "string" || !icon) return { ok: false, error: "icon must be a non-empty string" };
  if (isAbsolute(icon) || isWindowsStylePath(icon)) return { ok: false, error: "icon must be a relative path" };
  if (![".svg", ".png"].includes(extname(icon).toLowerCase())) return { ok: false, error: "icon must be an .svg or .png file" };
  let root: string, path: string;
  try {
    root = realpathSync(dir);
    path = realpathSync(pathResolve(dir, icon));
  } catch {
    return { ok: false, error: `icon not found: ${icon}` };
  }
  const rel = relative(root, path);
  if (!rel || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) return { ok: false, error: "icon is outside the plugin directory" };
  const st = statSync(path);
  if (!st.isFile()) return { ok: false, error: "icon is not a regular file" };
  if (st.size > MAX_ICON_BYTES) return { ok: false, error: "icon is larger than 256KB" };
  return { ok: true, path };
}

/** Validate a parsed plugin.json manifest object. */
export function validateManifest(
  json: unknown,
): { ok: true; manifest: PluginManifest } | ValidationFailure {
  const errors: string[] = [];
  if (!isPlainObject(json)) {
    return { ok: false, error: "manifest must be a JSON object", errors: ["manifest must be a JSON object"] };
  }

  if (json.manifestVersion !== 1) {
    errors.push("manifestVersion must be 1");
  }
  const kind = json.kind;
  if (kind !== "agent" && kind !== "im") {
    errors.push('kind must be "agent" or "im"');
  }

  if (typeof json.id !== "string" || !PLUGIN_ID_RE.test(json.id)) {
    errors.push("id must match ^[a-z][a-z0-9_-]{0,31}$");
  } else if (kind === "agent" && (AGENT_RESERVED_IDS as readonly string[]).includes(json.id)) {
    errors.push(`id "${json.id}" is reserved for built-in agents`);
  } else if (kind === "im" && (IM_RESERVED_IDS as readonly string[]).includes(json.id)) {
    errors.push(`id "${json.id}" is reserved for built-in IM platforms`);
  }

  if (!isNonEmptyString(json.name)) {
    errors.push("name must be a non-empty string");
  }
  if (typeof json.version !== "string" || !isValidSemver(json.version)) {
    errors.push("version must be a valid SemVer string");
  }
  if (typeof json.minRhodium !== "string" || !isValidSemver(json.minRhodium)) {
    errors.push("minRhodium must be a valid SemVer string");
  }

  validateCommandArray(json.command, "command", errors);

  if (json.commandByPlatform !== undefined) {
    if (!isPlainObject(json.commandByPlatform)) {
      errors.push("commandByPlatform must be an object mapping platform keys to command arrays");
    } else {
      for (const [plat, cmd] of Object.entries(json.commandByPlatform)) {
        if (!isNonEmptyString(plat)) {
          errors.push("commandByPlatform keys must be non-empty strings");
          continue;
        }
        validateCommandArray(cmd, `commandByPlatform.${plat}`, errors);
      }
    }
  }

  validateStringList(json.requiredConfig, "requiredConfig", errors);
  validateStringList(json.optionalConfig, "optionalConfig", errors);

  if (kind === "agent") {
    if (json.protocol !== "rh-agent/1") {
      errors.push('protocol must be "rh-agent/1" for agent plugins');
    }
    if (!isNonEmptyString(json.statusName)) {
      errors.push("statusName must be a non-empty string for agent plugins");
    }
    if (json.label !== undefined) {
      errors.push("label is only valid for IM plugins; agent plugins must use statusName");
    }
    if (!isNonEmptyString(json.program)) {
      errors.push("program must be a non-empty string for agent plugins");
    } else if (isForbiddenClaudeToken(json.program)) {
      errors.push("program references forbidden claude executable");
    }
    validateAgentCapabilitiesStatic(json.capabilities, errors);
    if (json.import !== undefined && typeof json.import !== "boolean") {
      errors.push("import must be a boolean");
    }
    if (json.wizard !== undefined) {
      errors.push("wizard is only valid for IM plugins");
    }
  } else if (kind === "im") {
    if (json.protocol !== "rh-im/1") {
      errors.push('protocol must be "rh-im/1" for IM plugins');
    }
    if (!isNonEmptyString(json.label)) {
      errors.push("label must be a non-empty string for IM plugins");
    }
    if (json.statusName !== undefined) {
      errors.push("statusName is only valid for agent plugins; IM plugins must use label");
    }
    if (json.program !== undefined) {
      errors.push("program is only valid for agent plugins");
    }
    if (json.import !== undefined) {
      errors.push("import is only valid for agent plugins");
    }
    if (json.wizard !== undefined && typeof json.wizard !== "boolean") {
      errors.push("wizard must be a boolean");
    }
    const capsRes = validateImCapabilities(json.capabilities);
    if (!capsRes.ok) {
      errors.push(...capsRes.errors);
    }
  }

  if (errors.length > 0) {
    return { ok: false, error: errors.join("; "), errors };
  }
  return { ok: true, manifest: json as PluginManifest };
}

function isWindowsStylePath(p: string): boolean {
  return /^[A-Za-z]:(?:[\\/]|$)|^\\\\/.test(p);
}

/**
 * Expand ${PLUGIN_DIR} in the manifest's platform-specific (or default) command array
 * without shell splitting, preserving spaces across Linux, Windows, and macOS.
 */
export function expandPluginCommand(
  manifest: Pick<PluginManifest, "command" | "commandByPlatform">,
  pluginDir: string,
  platform: string = process.platform,
): string[] {
  const template = manifest.commandByPlatform?.[platform] ?? manifest.command;
  const useWin32 = isWindowsStylePath(pluginDir);
  const resolvedDir = useWin32 ? win32.resolve(pluginDir) : pluginDir.startsWith("/") ? posix.resolve(pluginDir) : pathResolve(pluginDir);
  const resolvedUsesWin = isWindowsStylePath(resolvedDir);
  const effectivePath = resolvedUsesWin ? win32 : posix;

  const resolveSubpath = (sub: string): string => {
    const cleaned = sub.replace(/^[\\/]+/, "");
    if (!cleaned) return resolvedDir;
    const normalized = resolvedUsesWin ? cleaned : cleaned.replace(/\\/g, "/");
    return effectivePath.resolve(resolvedDir, normalized);
  };

  return template.map((arg) => {
    if (arg === "${PLUGIN_DIR}") return resolvedDir;
    if ((arg.startsWith("${PLUGIN_DIR}/") || arg.startsWith("${PLUGIN_DIR}\\")) && !arg.slice(13).includes("${PLUGIN_DIR}")) {
      return resolveSubpath(arg.slice(14));
    }
    const eqIdx = arg.indexOf("=");
    if (eqIdx >= 0) {
      const prefix = arg.slice(0, eqIdx + 1);
      const val = arg.slice(eqIdx + 1);
      if (val === "${PLUGIN_DIR}") return `${prefix}${resolvedDir}`;
      if ((val.startsWith("${PLUGIN_DIR}/") || val.startsWith("${PLUGIN_DIR}\\")) && !val.slice(13).includes("${PLUGIN_DIR}")) {
        return `${prefix}${resolveSubpath(val.slice(14))}`;
      }
    }
    // Fallback for any other embedded occurrence without modifying argument boundaries.
    return arg.replaceAll("${PLUGIN_DIR}", resolvedDir);
  });
}
