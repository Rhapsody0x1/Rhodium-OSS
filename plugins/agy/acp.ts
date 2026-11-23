import { spawn } from "node:child_process";
import { readJsonLines } from "@rhodium-oss/plugin-sdk";

export type Wire = Record<string, unknown>;
export type RpcId = string | number;
export const object = (value: unknown): Wire => value && typeof value === "object" && !Array.isArray(value) ? value as Wire : {};
export const text = (value: unknown): string => typeof value === "string" ? value : "";
export const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

export async function within<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: Timer | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

const clip = (value: string, max: number) => value.length > max ? `${value.slice(0, max - 1)}…` : value;

export class AcpError extends Error {
  constructor(method: string, readonly code: number, detail: string) {
    super(code === -32000
      ? "Antigravity requires login. Run agy acp --login yourself and retry."
      : `Antigravity ${method} failed (ACP error ${code})${detail.trim() ? `: ${clip(detail.trim(), 300)}` : "."}`);
  }
}

export class AcpPeer {
  private serial = 0;
  private readonly pending = new Map<number, { method: string; resolve: (value: Wire) => void; reject: (error: Error) => void }>();
  private readonly child;
  private readonly closed: Promise<void>;
  private problem?: Error;
  private stderr = "";

  constructor(command: [string, ...string[]], cwd: string, env: NodeJS.ProcessEnv, onMessage: (method: string, params: Wire, id?: RpcId) => void) {
    this.child = spawn(command[0], command.slice(1), { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child.stderr.setEncoding("utf8").on("data", (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-4000); });
    this.closed = new Promise(resolve => this.child.once("close", () => {
      this.fail(new Error("Antigravity ACP exited."));
      resolve();
    }));
    this.child.once("error", () => this.fail(new Error("Could not launch the Antigravity executable in the slot directory.")));
    this.child.stdin.on("error", () => this.fail(new Error("Antigravity ACP input was closed.")));
    void readJsonLines(this.child.stdout, { onMessage: value => {
      const frame = object(value);
      if (frame.jsonrpc !== "2.0") throw new Error("Invalid ACP frame");
      const id = frame.id;
      if (typeof frame.method === "string") {
        onMessage(frame.method, object(frame.params), typeof id === "number" || typeof id === "string" ? id : undefined);
      } else if (typeof id === "number") {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        const error = object(frame.error);
        if (typeof error.code === "number") pending.reject(new AcpError(pending.method, error.code, text(error.message)));
        else if (Object.hasOwn(frame, "result")) pending.resolve(object(frame.result));
        else pending.reject(new Error(`Invalid Antigravity ${pending.method} response.`));
      }
    } }).then(
      () => this.fail(new Error("Antigravity ACP output was closed.")),
      () => {
        this.fail(new Error("Invalid Antigravity ACP output."));
        this.child.kill();
      },
    );
  }

  get alive(): boolean { return this.problem === undefined; }

  /** The last few lines agy wrote to stderr, for errors when it fails to start or dies. */
  get tail(): string { return clip(this.stderr.trim().split(/\r?\n/).slice(-5).join("\n"), 500); }

  private fail(error: Error): void {
    this.problem ??= error;
    for (const request of this.pending.values()) request.reject(this.problem);
    this.pending.clear();
  }

  private write(frame: Wire): Promise<void> {
    if (this.problem) return Promise.reject(this.problem);
    return new Promise<void>((resolve, reject) => this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...frame }) + "\n", error => {
      if (error) reject(new Error("Could not write to Antigravity ACP."));
      else resolve();
    }));
  }

  request(method: string, params: Wire, written?: () => void): Promise<Wire> {
    const id = ++this.serial;
    const reply = Promise.withResolvers<Wire>();
    this.pending.set(id, { method, resolve: reply.resolve, reject: reply.reject });
    const sent = this.write({ id, method, params }).then(written, error => {
      this.pending.delete(id);
      throw error;
    });
    return Promise.all([sent, reply.promise]).then(([, result]) => result);
  }

  notify(method: string, params: Wire): Promise<void> { return this.write({ method, params }); }
  respond(id: RpcId, result: Wire): Promise<void> { return this.write({ id, result }); }
  reject(id: RpcId, code: number, message: string): Promise<void> { return this.write({ id, error: { code, message } }); }

  /** Closes the session first, so agy stops its background tasks, then ends the process tree. */
  async close(sessionId?: string): Promise<void> {
    if (sessionId && this.alive) await within(this.request("session/close", { sessionId }), 1_000, "ACP session close timeout").catch(() => {});
    this.fail(new Error("Antigravity ACP was closed."));
    this.child.stdin.end();
    try {
      await within(this.closed, 500, "ACP close timeout");
    } catch {
      // On Windows a plain kill ends only agy.exe and leaves the commands it started.
      if (process.platform === "win32" && this.child.pid) {
        await Bun.spawn(["taskkill", "/PID", String(this.child.pid), "/T", "/F"], { windowsHide: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exited.catch(() => {});
      }
      this.child.kill("SIGKILL");
      await this.closed;
    }
  }
}
