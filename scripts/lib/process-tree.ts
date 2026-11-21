// Inspect PID relationships only. A plugin's arguments and environment stay in the doctor's per-process check.
import { dlopen } from "bun:ffi";
import { readdirSync, readFileSync } from "node:fs";

type Parent = [pid: number, ppid: number];

function* linuxParents(): Iterable<Parent> {
  for (const e of readdirSync("/proc")) {
    if (!/^\d+$/.test(e)) continue;
    try {
      const stat = readFileSync(`/proc/${e}/stat`, "utf8");
      yield [Number(e), Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1])];
    } catch {} // Exited since readdir.
  }
}

function* macParents(): Iterable<Parent> {
  const ps = Bun.spawnSync(["/bin/ps", "-axo", "pid=,ppid="], { stdin: "ignore", stderr: "ignore", timeout: 5000 });
  if (ps.exitCode !== 0) throw new Error("cannot list process parents with ps");
  for (const line of ps.stdout.toString().trim().split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid && ppid !== undefined) yield [pid, ppid];
  }
}

const openSnapshot = () => dlopen("kernel32.dll", {
  CreateToolhelp32Snapshot: { args: ["u32", "u32"], returns: "i64" },
  Process32FirstW: { args: ["i64", "ptr"], returns: "i32" },
  Process32NextW: { args: ["i64", "ptr"], returns: "i32" },
  CloseHandle: { args: ["i64"], returns: "i32" },
});
let api: ReturnType<typeof openSnapshot>;
function* windowsParents(): Iterable<Parent> {
  const k = (api ??= openSnapshot()).symbols;
  const snapshot = k.CreateToolhelp32Snapshot(2, 0); // TH32CS_SNAPPROCESS
  if (snapshot === -1n) throw new Error("cannot take process snapshot");
  try {
    // PROCESSENTRY32W on 64-bit Windows (x64 and ARM64).
    const entry = Buffer.alloc(568);
    entry.writeUInt32LE(entry.length);
    if (!k.Process32FirstW(snapshot, entry)) throw new Error("cannot read process snapshot");
    do {
      yield [entry.readUInt32LE(8), entry.readUInt32LE(32)];
    } while (k.Process32NextW(snapshot, entry));
  } finally { k.CloseHandle(snapshot); }
}

export function descendantPids(rootPid: number): number[] {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return [];
  const parents = process.platform === "win32" ? windowsParents() : process.platform === "darwin" ? macParents() : linuxParents();
  const children = new Map<number, number[]>();
  for (const [pid, ppid] of parents) {
    const list = children.get(ppid);
    if (list) list.push(pid);
    else children.set(ppid, [pid]);
  }
  const tree = new Set([rootPid]);
  for (const pid of tree) for (const child of children.get(pid) ?? []) tree.add(child);
  return [...tree];
}
