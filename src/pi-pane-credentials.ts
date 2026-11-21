// Yes-or-no questions about a running process's arguments and environment: whether a pi carries the
// Anthropic keys it reads (#811), whether a claude runs bare (rh doctor). Linux reads /proc/<pid>,
// macOS the kernel's copy of both (KERN_PROCARGS2), Windows its process parameters block. Only the
// answer leaves this file, and each buffer is wiped once looked at.
import { dlopen, toArrayBuffer } from "bun:ffi";
import { descendantPids } from "../scripts/lib/process-tree";
import { readFileSync } from "node:fs";
import { READ_BY_PI } from "./agents";
import { refuseBare } from "./claude";

const CLAUDE_ENV_PREFIX = /^(ANTHROPIC_|CLAUDE)/;

function hasClaudeEnv(entries: Iterable<string>, ignoreCase = false): boolean {
  for (const kv of entries) {
    const eq = kv.indexOf("=", 1);
    if (eq < 0 || eq === kv.length - 1) continue;
    const key = ignoreCase ? kv.slice(0, eq).toUpperCase() : kv.slice(0, eq);
    if (CLAUDE_ENV_PREFIX.test(key)) return true;
  }
  return false;
}

/** Whether entries ("NAME=value") set any of pi's four keys to something nonempty. Windows names
 *  ignore case. */
export function anthropicSet(entries: Iterable<string>, ignoreCase = false): boolean {
  const keys = ignoreCase ? READ_BY_PI.map((k) => k.toUpperCase()) : READ_BY_PI;
  for (const kv of entries) {
    const eq = kv.indexOf("=", 1); // Windows keeps entries like "=C:=C:\" for drive directories
    if (eq < 0 || eq === kv.length - 1) continue;
    if (keys.includes(ignoreCase ? kv.slice(0, eq).toUpperCase() : kv.slice(0, eq))) return true;
  }
  return false;
}

/** Whether a claude with these arguments and environment runs bare (src/claude.ts refuseBare). */
export function bareIn(argv: string[], entries: string[], ignoreCase = false): boolean {
  const env = Object.fromEntries(entries.map((kv) => [ignoreCase ? kv.slice(0, kv.indexOf("=")).toUpperCase() : kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]));
  try {
    refuseBare({ argv, env, cwd: "" });
    return false;
  } catch {
    return true;
  }
}

/** The arguments and environment strings of a KERN_PROCARGS2 reply: argc, the executable's path, NUL
 *  padding, argc arguments, then the environment up to an empty string or the end. Null if malformed. */
export function procargs(buf: Buffer): { argv: string[]; env: string[] } | null {
  if (buf.length < 4) return null;
  const argc = buf.readInt32LE(0);
  let at = buf.indexOf(0, 4); // end of the executable's path
  if (argc < 0 || at < 0) return null;
  while (at < buf.length && buf[at] === 0) at++;
  const argv: string[] = [];
  for (let i = 0; i < argc; i++) {
    const end = buf.indexOf(0, at);
    if (end < 0) return null;
    argv.push(buf.toString("utf8", at, end));
    at = end + 1;
  }
  const env: string[] = [];
  while (at < buf.length) {
    const end = buf.indexOf(0, at);
    if (end <= at) break; // the empty string, or no terminator
    env.push(buf.toString("utf8", at, end));
    at = end + 1;
  }
  return { argv, env };
}

/** The strings of a Windows environment block: UTF-16, each NUL-terminated, an empty one at the end. */
export function windowsEnv(block: Buffer): string[] {
  return block.toString("utf16le").split("\0").filter(Boolean);
}

/** What look answers of argv and the "NAME=value" entries; names ignore case where ignoreCase. */
type Look<T> = (argv: string[], env: string[], ignoreCase: boolean) => T;

function linux<T>(pid: number, look: Look<T>): T | null {
  try {
    const args = readFileSync(`/proc/${pid}/cmdline`);
    const raw = readFileSync(`/proc/${pid}/environ`);
    const answer = look(args.toString("utf8").split("\0").slice(0, -1), raw.toString("utf8").split("\0"), false);
    args.fill(0);
    raw.fill(0);
    return answer;
  } catch {
    return null;
  }
}

const openMac = () => dlopen("/usr/lib/libSystem.B.dylib", {
  sysctl: { args: ["ptr", "u32", "ptr", "ptr", "ptr", "u64"], returns: "i32" },
});
let mac: ReturnType<typeof openMac>;

function macos<T>(pid: number, look: Look<T>): T | null {
  const { sysctl } = (mac ??= openMac()).symbols;
  // <sys/sysctl.h>: CTL_KERN 1, KERN_ARGMAX 8, KERN_PROCARGS2 49. Same user only, which a pane of yours is.
  const argmax = Buffer.alloc(4);
  const size = new BigUint64Array([4n]);
  if (sysctl(new Int32Array([1, 8]), 2, argmax, size, null, 0) !== 0) return null;
  const buf = Buffer.alloc(argmax.readInt32LE(0));
  size[0] = BigInt(buf.length);
  if (sysctl(new Int32Array([1, 49, pid]), 3, buf, size, null, 0) !== 0) return null;
  const got = procargs(buf.subarray(0, Number(size[0])));
  const answer = got && look(got.argv, got.env, false);
  buf.fill(0);
  return answer;
}

const openKernel = () => dlopen("kernel32.dll", {
  OpenProcess: { args: ["u32", "i32", "u32"], returns: "u64" },
  CloseHandle: { args: ["u64"], returns: "i32" },
  ReadProcessMemory: { args: ["u64", "u64", "ptr", "u64", "ptr"], returns: "i32" },
  IsWow64Process: { args: ["u64", "ptr"], returns: "i32" },
  LocalFree: { args: ["ptr"], returns: "ptr" },
  lstrlenW: { args: ["ptr"], returns: "i32" },
});
const openShell = () => dlopen("shell32.dll", {
  CommandLineToArgvW: { args: ["ptr", "ptr"], returns: "ptr" },
});
let shell: ReturnType<typeof openShell>;
const openNt = () => dlopen("ntdll.dll", {
  NtQueryInformationProcess: { args: ["u64", "u32", "ptr", "u32", "ptr"], returns: "i32" },
});
let kernel: ReturnType<typeof openKernel>;
let nt: ReturnType<typeof openNt>;
/** Most of an environment block read: larger, and it is taken as unreadable. */
const MAX_BLOCK = 1 << 20;

/** A command line split as Windows programs split theirs (CommandLineToArgvW). */
function windowsArgv(line: Buffer): string[] | null {
  const { CommandLineToArgvW } = (shell ??= openShell()).symbols;
  const { LocalFree, lstrlenW } = (kernel ??= openKernel()).symbols;
  const count = new Int32Array(1);
  const list = CommandLineToArgvW(Buffer.concat([line, Buffer.alloc(2)]), count);
  if (!list) return null;
  try {
    const at = new BigUint64Array(toArrayBuffer(list, 0, count[0]! * 8));
    return [...at].map((p) => Buffer.from(toArrayBuffer(Number(p) as any, 0, lstrlenW(Number(p) as any) * 2)).toString("utf16le"));
  } finally {
    LocalFree(list);
  }
}

function windows<T>(pid: number, look: Look<T>): T | null {
  const api = (kernel ??= openKernel()).symbols;
  const { NtQueryInformationProcess } = (nt ??= openNt()).symbols;
  const handle = api.OpenProcess(0x1010, 0, pid); // PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ
  if (!handle) return null;
  const read = (address: bigint, size: number): Buffer | null => {
    const out = Buffer.alloc(size);
    return api.ReadProcessMemory(handle, address, out, BigInt(size), null) ? out : null;
  };
  try {
    // A 32-bit process keeps a second, 32-bit layout: not pi's, so unknown rather than guessed.
    const wow = new Int32Array(1);
    if (!api.IsWow64Process(handle, wow) || wow[0]) return null;
    // 64-bit layouts: PROCESS_BASIC_INFORMATION.PebBaseAddress at 8; PEB.ProcessParameters at 0x20;
    // RTL_USER_PROCESS_PARAMETERS.CommandLine at 0x70 (Length, then Buffer at 0x78), Environment at
    // 0x80 and EnvironmentSize at 0x3F0.
    const basic = Buffer.alloc(48);
    if (NtQueryInformationProcess(handle, 0, basic, basic.length, null) !== 0) return null;
    const params = read(basic.readBigUInt64LE(8) + 0x20n, 8)?.readBigUInt64LE(0);
    if (!params) return null;
    const env = read(params + 0x80n, 8)?.readBigUInt64LE(0);
    const size = read(params + 0x3f0n, 8)?.readBigUInt64LE(0);
    if (!env || !size || size > BigInt(MAX_BLOCK)) return null;
    const length = read(params + 0x70n, 2)?.readUInt16LE(0);
    const text = read(params + 0x78n, 8)?.readBigUInt64LE(0);
    const line = length && text ? read(text, length) : null;
    const argv = line && windowsArgv(line);
    const block = read(env, Number(size));
    const answer = argv && block && look(argv, windowsEnv(block), true);
    line?.fill(0);
    block?.fill(0);
    return answer ?? null;
  } finally {
    api.CloseHandle(handle);
  }
}

function inspect<T>(pid: number, look: Look<T>): T | null {
  try {
    if (process.platform === "linux") return linux(pid, look);
    if (process.platform === "darwin") return macos(pid, look);
    if (process.platform === "win32") return windows(pid, look);
  } catch {
    // A library or call that is not there: unknown.
  }
  return null;
}

/** True if any of the four values is nonempty, false if all are empty or absent, null if unknown,
 *  and then the import is refused. */
export async function piPaneHasCredentials(pid: number): Promise<boolean | null> {
  return inspect(pid, (_, env, ignoreCase) => anthropicSet(env, ignoreCase));
}

/** Whether the process rh doctor started as claude runs bare, as it really got its arguments and
 *  environment, a wrapper's additions included when it execs claude; null if unknown. */
export function doctorBare(pid: number): boolean | null {
  return inspect(pid, bareIn);
}

const CLAUDE_BIN_RE = /^claude(?:\.(?:exe|cmd|bat))?$/i;
const CLAUDE_SCRIPT_RE = /^claude\.(?:[cm]?js)$/i;
const CLAUDE_PKG_RE = /(?:^|[\\/])@anthropic-ai[\\/]claude-code(?:$|[\\/@])/i;
const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SHELL_NAMES = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "cmd", "powershell", "pwsh"]);
const RUNNER_NAMES = new Set(["node", "bun", "deno", "npx", "bunx"]);
const RUNNER_VALUE_FLAGS = new Set([
  "-r",
  "--require",
  "--import",
  "--loader",
  "--experimental-loader",
  "--conditions",
  "-C",
  "--config",
  "-c",
  "--cwd",
  "--env-file",
  "--preload",
  "--package",
  "-p",
]);
const ENV_VALUE_FLAGS = new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string", "-a", "--argv0"]);
const SHELL_PREFIX_WORDS = new Set(["exec", "command", "builtin", "nohup", "time", "nice"]);

function stripOuterQuotes(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1).trim();
  }
  return t;
}

function basenameOfPath(pathOrName: string): string {
  const cleaned = stripOuterQuotes(pathOrName).replace(/[\\/]+$/, "");
  const slash = Math.max(cleaned.lastIndexOf("/"), cleaned.lastIndexOf("\\"));
  return slash >= 0 ? cleaned.slice(slash + 1) : cleaned;
}

function normalizedExeName(pathOrName: string): string {
  return basenameOfPath(pathOrName).toLowerCase().replace(/\.(?:exe|cmd|bat)$/i, "");
}

/** Whether a single executable path or program name resolves to the claude binary (never splitting on spaces in parent directories). */
export function isClaudeExecutable(pathOrName: string): boolean {
  const base = basenameOfPath(pathOrName);
  return CLAUDE_BIN_RE.test(base);
}

function isClaudeTarget(target: string): boolean {
  const unquoted = stripOuterQuotes(target);
  if (!unquoted) return false;
  if (isClaudeExecutable(unquoted)) return true;
  if (CLAUDE_PKG_RE.test(unquoted)) return true;
  return CLAUDE_SCRIPT_RE.test(basenameOfPath(unquoted));
}

// ponytail: recognize simple quoted arguments and command separators; use a shell parser if nested syntax is needed.
function* shellCommands(segment: string, windowsCmd: boolean): Generator<string[]> {
  let tokens: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (!windowsCmd && ch === "\\" && quote === '"' && i + 1 < segment.length) cur += segment[++i]!;
      else cur += ch;
    } else if (ch === '"' || (!windowsCmd && ch === "'")) {
      quote = ch;
    } else if (!windowsCmd && ch === "\\" && i + 1 < segment.length) {
      cur += segment[++i]!;
    } else if (";|&\n`()".includes(ch)) {
      if (cur) tokens.push(cur);
      if (tokens.length) yield tokens;
      tokens = [];
      cur = "";
    } else if (/\s/.test(ch)) {
      if (cur) {
        tokens.push(cur);
        cur = "";
      }
    } else {
      cur += ch;
    }
  }
  if (cur) tokens.push(cur);
  if (tokens.length) yield tokens;
}

function shellCommandLaunchesClaude(cmdStr: string, windowsCmd = false): boolean {
  for (const tokens of shellCommands(cmdStr, windowsCmd)) {
    let idx = 0;
    while (idx < tokens.length) {
      const tok = tokens[idx]!;
      if (ENV_ASSIGN_RE.test(tok) || SHELL_PREFIX_WORDS.has(tok.toLowerCase())) {
        idx++;
        continue;
      }
      break;
    }
    if (idx < tokens.length && launchesClaude(tokens.slice(idx))) return true;
  }
  return false;
}

/** Whether a process's argv launches Claude directly or via env, node/bun/deno/npx/bunx, or a shell command. */
export function launchesClaude(argv: string[]): boolean {
  if (!argv.length) return false;
  const head = argv[0] ?? "";
  if (isClaudeExecutable(head)) return true;
  const exe = normalizedExeName(head);

  if (exe === "env") {
    let i = 1;
    while (i < argv.length) {
      const a = argv[i]!;
      if (a === "--") {
        i++;
        break;
      }
      if ((a === "-S" || a === "--split-string") && i + 1 < argv.length) {
        if (shellCommandLaunchesClaude(argv[i + 1]!)) return true;
        i += 2;
        continue;
      }
      if (a.startsWith("--split-string=")) {
        if (shellCommandLaunchesClaude(a.slice("--split-string=".length))) return true;
        i++;
        continue;
      }
      if (ENV_VALUE_FLAGS.has(a)) {
        i += 2;
        continue;
      }
      if (a.startsWith("-")) {
        i++;
        continue;
      }
      if (ENV_ASSIGN_RE.test(a)) {
        i++;
        continue;
      }
      break;
    }
    return i < argv.length ? launchesClaude(argv.slice(i)) : false;
  }

  if (RUNNER_NAMES.has(exe)) {
    let i = 1;
    if ((exe === "bun" || exe === "deno") && (argv[i] === "run" || argv[i] === "x")) i++;
    while (i < argv.length) {
      const a = argv[i]!;
      if (a === "--") {
        i++;
        break;
      }
      if (a === "-e" || a === "--eval" || a === "-p" || a === "--print") {
        return false;
      }
      if (RUNNER_VALUE_FLAGS.has(a)) {
        if (i + 1 < argv.length && isClaudeTarget(argv[i + 1]!)) return true;
        i += 2;
        continue;
      }
      if (a.startsWith("--require=") || a.startsWith("--import=") || a.startsWith("--package=")) {
        const val = a.slice(a.indexOf("=") + 1);
        if (isClaudeTarget(val)) return true;
        i++;
        continue;
      }
      if (a.startsWith("-")) {
        i++;
        continue;
      }
      return isClaudeTarget(a);
    }
    return i < argv.length ? isClaudeTarget(argv[i]!) : false;
  }

  if (SHELL_NAMES.has(exe)) {
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i]!;
      const lower = a.toLowerCase();
      if (exe === "cmd" && /^\/[dsq]$/.test(lower)) continue;
      if (
        lower === "-c" ||
        lower === "/c" ||
        lower === "/k" ||
        lower === "-command" ||
        /^-[a-z]*c$/.test(lower)
      ) {
        return i + 1 < argv.length ? shellCommandLaunchesClaude(argv[i + 1]!, exe === "cmd") : false;
      }
      if (!a.startsWith("-")) return isClaudeTarget(a);
    }
    return false;
  }

  return false;
}

/** Checks a single process's argv/env for bare mode, Anthropic/Claude credentials (case-insensitive by
 *  default), and forbidden claude executable launches. */
export function checkProcessCompliance(
  argv: string[],
  env: string[],
  ignoreCase = true,
): { bare: boolean; anthropic: boolean; claudeExec: boolean } {
  return {
    bare: bareIn(argv, env, ignoreCase),
    anthropic: anthropicSet(env, ignoreCase) || hasClaudeEnv(env, ignoreCase),
    claudeExec: launchesClaude(argv),
  };
}

/** Audits rootPid and its live descendants for bare mode, Anthropic/Claude env leaks, and claude launches. */
export function auditPluginProcessTree(
  rootPid: number,
): { pid: number; bare: boolean; anthropic: boolean; claudeExec: boolean }[] {
  const out: { pid: number; bare: boolean; anthropic: boolean; claudeExec: boolean }[] = [];
  for (const pid of descendantPids(rootPid)) {
    const res = inspect(pid, (argv, env) => checkProcessCompliance(argv, env, true));
    if (res) out.push({ pid, ...res });
  }
  return out;
}
