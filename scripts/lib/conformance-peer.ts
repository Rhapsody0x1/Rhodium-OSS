// The offline checker drives one plugin through its public stdio, never through core modules.
import { readJsonLines, type PluginManifest, expandPluginCommand } from "@rhodium-oss/plugin-sdk";
import { descendantPids } from "./process-tree";

export type Frame = Record<string, unknown>;
export const object = (v: unknown): v is Frame => v !== null && typeof v === "object" && !Array.isArray(v);
export const nonempty = (v: unknown): v is string => typeof v === "string" && !!v.trim();
export function check(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new Error(detail);
}

export async function bounded<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: Timer | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), Math.max(1, ms));
    })]);
  } finally { clearTimeout(timer); }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (err) { return (err as NodeJS.ErrnoException).code !== "ESRCH"; }
}

export const sensitiveKey = (key: string) => /^(anthropic_|claude|herdr_)/i.test(key);

export function childEnv(dir: string): Record<string, string> {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter((kv): kv is [string, string] => kv[1] !== undefined && !sensitiveKey(kv[0]) && kv[0].toUpperCase() !== "RHODIUM_TOKEN")),
    RHODIUM_PLUGIN_DIR: dir, PYTHONUTF8: "1",
  };
}

export type Options = { manifest: PluginManifest; dir: string; cwd: string; ms: number; config: Record<string, string> };

function spawn(o: Options) {
  return Bun.spawn(expandPluginCommand(o.manifest, o.dir), {
    cwd: o.cwd, env: childEnv(o.dir), stdin: "pipe", stdout: "pipe", stderr: "ignore", windowsHide: true,
  });
}

export class Peer {
  readonly frames: Frame[] = [];
  readonly proc: ReturnType<typeof spawn>;
  private readonly reader: Promise<void>;
  private changed = Promise.withResolvers<void>();
  private closed = false;
  private problem?: Error;
  private children: number[] = [];
  private serial = 0;

  constructor(readonly options: Options, reverse?: (frame: Frame, peer: Peer) => void) {
    this.proc = spawn(options);
    this.reader = readJsonLines(this.proc.stdout, { onMessage: frame => {
      check(object(frame), "Plugin output must be a JSON object");
      this.frames.push(frame);
      reverse?.(frame, this);
      this.changed.resolve();
      this.changed = Promise.withResolvers();
    } }).catch(() => { this.problem = new Error("Invalid plugin stdout or reverse RPC"); }).finally(() => {
      this.closed = true;
      this.changed.resolve();
    });
  }

  write(frame: Frame): void {
    this.proc.stdin.write(JSON.stringify(frame) + "\n");
  }

  async wait(from: number, accept: (frame: Frame) => boolean, label: string): Promise<Frame> {
    const deadline = Date.now() + this.options.ms;
    for (;;) {
      if (this.problem) throw this.problem;
      while (from < this.frames.length) {
        const frame = this.frames[from++]!;
        if (accept(frame)) return frame;
        if (frame.type === "fatal") throw new Error(`Agent reported fatal before ${label}`);
      }
      check(!this.closed, `Plugin closed stdout before ${label}`);
      check(Date.now() < deadline, `Timed out waiting for ${label}`);
      await bounded(this.changed.promise, deadline - Date.now(), label);
    }
  }

  async rpc(method: string, params: Frame): Promise<Frame> {
    const id = ++this.serial, from = this.frames.length;
    this.write({ jsonrpc: "2.0", id, method, params });
    const m = await this.wait(from, f => f.id === id && !("method" in f), method);
    check(m.jsonrpc === "2.0" && object(m.result) && !("error" in m), `Invalid response to ${method}`);
    return m.result;
  }

  // ponytail: snapshot before close; a child created during shutdown would need OS job/process-group tracking.
  observeChildren(): void { this.children = descendantPids(this.proc.pid).filter(p => p !== this.proc.pid); }

  async exited(): Promise<void> {
    const code = await bounded(this.proc.exited, this.options.ms, "graceful plugin exit");
    check(code === 0, `Plugin exited with code ${code}`);
    const end = Date.now() + this.options.ms;
    while (this.children.some(alive) && Date.now() < end) await Bun.sleep(20);
    check(!this.children.some(alive), "Plugin left a child process alive after shutdown");
    await bounded(this.reader, this.options.ms, "end of plugin output");
    if (this.problem) throw this.problem;
  }

  async clean(): Promise<void> {
    if (this.proc.exitCode === null && this.proc.signalCode === null) {
      this.observeChildren();
      this.proc.kill("SIGTERM");
      try { await bounded(this.proc.exited, Math.min(300, this.options.ms), "plugin cleanup"); }
      catch { this.proc.kill("SIGKILL"); await bounded(this.proc.exited, 1500, "plugin cleanup"); }
    }
    for (const pid of this.children) if (alive(pid)) {
      try { process.kill(pid, "SIGKILL"); } catch {} // May have just exited.
    }
    this.proc.stdin.end();
  }
}
