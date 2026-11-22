// The one-shot import query (spec plugins §3.5): rhodium starts the plugin itself, not under a holder,
// writes one query, and takes its one query_result within durations.pluginRpc.
import { IMPORT_ID_RE, isImportBlock, type ImportBlock, type ImportConversation } from "@rhodium-oss/plugin-sdk";
import { isAbsolute } from "node:path";
import { headlessEnv } from "./agents";
import type { Config } from "./config";
import type { LoadedPlugin } from "./plugin-loader";
import { agentBaseEnv } from "./runner";

type Query = { query: "list"; dir: string | null } | { query: "read"; session: string };

let serial = 0;

/** env without the slot variables rhodium itself may have been started with. */
const noSlot = (env: Record<string, string>) => Object.fromEntries(Object.entries(env).filter(([k]) => !/^RHODIUM_(SOCKET|SLOT|TOKEN)$/i.test(k)));

/** The plugin's answer to q, or an Error with its reason: its own, the last line of its stderr, or the timeout. */
async function ask(p: LoadedPlugin, cfg: Config, q: Query): Promise<Record<string, unknown>> {
  const config = cfg.plugins[p.id]?.config ?? {};
  const redact = (text: string) => {
    for (const v of Object.values(config).sort((a, b) => b.length - a.length)) if (v) text = text.replaceAll(v, "[redacted]");
    return text.slice(0, 1000);
  };
  const id = `q-${process.pid}-${++serial}`;
  const spawn = () => Bun.spawn(p.command, {
    cwd: (q.query === "list" && q.dir) || p.dir,
    // As a slot's launch (PluginAgentDriver.spawn), but with no slot: no RHODIUM_SOCKET, _SLOT or _TOKEN.
    env: { ...noSlot(headlessEnv(p.id, agentBaseEnv(cfg))), RHODIUM_PLUGIN_DIR: p.dir, PYTHONUTF8: "1" },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  let proc: ReturnType<typeof spawn>;
  try {
    proc = spawn();
  } catch (e) {
    throw new Error(`启动不了插件：${(e as Error).message}`);
  }
  let err = "";
  const errDone = (async () => {
    for await (const chunk of proc.stderr.pipeThrough(new TextDecoderStream())) err = (err + chunk).slice(-8192);
  })().catch(() => {});
  const lastErr = () => redact(err.trim().split(/\r?\n/).at(-1) ?? "");
  // Close stdin, then TERM and KILL a stopGrace apart, unless it exits first.
  const reap = async () => {
    try {
      proc.stdin.end();
    } catch {}
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(cfg.durations.stopGrace).then(() => false)]);
      if (exited) return;
      proc.kill(signal);
    }
  };
  const program = cfg.programs[p.id] ?? (p.manifest.kind === "agent" ? p.manifest.program : null);
  proc.stdin.write(JSON.stringify({ type: "query", proto: 1, id, ...q, program, config }) + "\n");
  proc.stdin.flush();

  const answer = (async () => {
    let buf = "";
    for await (const chunk of proc.stdout.pipeThrough(new TextDecoderStream())) {
      buf += chunk;
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        let m: any;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m?.type === "query_result" && m.id === id) return m as Record<string, unknown>;
      }
    }
    return null;
  })();
  let timer: Timer | undefined;
  const timeout = new Promise<"timeout">((r) => (timer = setTimeout(() => r("timeout"), cfg.durations.pluginRpc)));
  const r = await Promise.race([answer, timeout]).finally(() => clearTimeout(timer));
  void reap();
  if (r === "timeout") {
    const why = lastErr();
    throw new Error(`查询超时${why ? `：${why}` : ""}`);
  }
  if (r === null) {
    const code = await proc.exited;
    await errDone;
    throw new Error(lastErr() || `插件没有回答就退出了（退出码 ${code}）`);
  }
  if (r.ok === false) throw new Error(typeof r.error === "string" && r.error ? redact(r.error) : "插件没有说原因");
  if (r.ok !== true) throw new Error("插件的回答不符合协议");
  return r;
}

/** The plugin's conversations started in dir (any, for null); those with an id or dir an import cannot use are dropped. */
export async function listPluginConversations(p: LoadedPlugin, cfg: Config, dir: string | null): Promise<ImportConversation[]> {
  const r = await ask(p, cfg, { query: "list", dir });
  if (!Array.isArray(r.conversations)) throw new Error("插件的回答不符合协议");
  return r.conversations.filter(
    (c: any): c is ImportConversation =>
      !!c && typeof c.id === "string" && IMPORT_ID_RE.test(c.id) && typeof c.dir === "string" && isAbsolute(c.dir)
      && typeof c.title === "string" && Number.isFinite(c.updatedAt)
      && (c.count === undefined || Number.isFinite(c.count)) && (c.busy === undefined || typeof c.busy === "boolean"),
  );
}

/** What was said in the plugin's conversation session, as standard blocks. */
export async function readPluginConversation(p: LoadedPlugin, cfg: Config, session: string): Promise<ImportBlock[]> {
  const r = await ask(p, cfg, { query: "read", session });
  if (!Array.isArray(r.blocks) || !r.blocks.every(isImportBlock)) throw new Error("插件的回答不符合协议");
  return r.blocks;
}
