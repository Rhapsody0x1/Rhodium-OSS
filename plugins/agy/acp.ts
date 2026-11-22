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

export class AcpError extends Error {
  constructor(method: string, readonly code: number) {
    super(code === -32000
      ? "Antigravity requires login. Run agy acp --login yourself and retry."
      : `Antigravity ${method} failed (ACP error ${code}).`);
  }
}

export class AcpPeer {
  private serial = 0;
  private readonly pending = new Map<number, { method: string; resolve: (value: Wire) => void; reject: (error: Error) => void }>();
  private readonly child;
  private readonly closed: Promise<void>;
  private problem?: Error;

  constructor(command: [string, ...string[]], cwd: string, env: NodeJS.ProcessEnv, onMessage: (method: string, params: Wire, id?: RpcId) => void) {
    this.child = spawn(command[0], command.slice(1), { cwd, env, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
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
        if (typeof object(frame.error).code === "number") pending.reject(new AcpError(pending.method, object(frame.error).code as number));
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

  async close(): Promise<void> {
    this.fail(new Error("Antigravity ACP was closed."));
    this.child.stdin.end();
    try {
      await within(this.closed, 500, "ACP close timeout");
    } catch {
      this.child.kill("SIGKILL");
      await this.closed;
    }
  }
}
