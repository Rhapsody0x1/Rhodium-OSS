import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { newInstance, until } from "./instance";

test("plugin menus follow each handshake's scope and limit, including a restart with global hashes", async () => {
  const r = newInstance({ toml: '[plugins.local-im]\npath = "."\n[bots.local]\nplatform = "local-im"\nowner = "user-1"' });
  const manifest = JSON.parse(readFileSync(resolve(import.meta.dir, "../examples/plugins/local-im/plugin.json"), "utf8"));
  const log = join(r.dir, "calls.jsonl");
  const phase = join(r.dir, "phase");
  type Call = { method: string; chat?: string; items?: unknown[]; pid: number };
  const calls = (): Call[] => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)) : [];
  writeFileSync(join(r.dir, "plugin.json"), JSON.stringify({ ...manifest, command: [process.execPath, "${PLUGIN_DIR}/im.ts"] }));
  writeFileSync(join(r.dir, "im.ts"), `
    import { appendFileSync, readFileSync } from "node:fs";
    import { createInterface } from "node:readline";
    const caps = JSON.parse(readFileSync("plugin.json", "utf8")).capabilities;
    const menu = JSON.parse(readFileSync("phase","utf8"));
    for await (const line of createInterface({input:process.stdin})) {
      const m = JSON.parse(line);
      appendFileSync("calls.jsonl", JSON.stringify({method:m.method, pid:process.pid, ...m.params})+"\\n");
      const result = m.method === "init" ? {proto:1, capabilities:{...caps, menu}} : {ok:true};
      console.log(JSON.stringify({jsonrpc:"2.0",id:m.id,result}));
      if (m.method === "shutdown") break;
    }`);
  writeFileSync(phase, JSON.stringify({ scope: "per_chat", maxItems: 1, row: "custom_menu" }));
  const menuCalls = (before: number) => calls().slice(before).filter(c => c.method === "set_menu" || c.method === "set_row");
  const checkPerChat = async (before: number) => {
    await until(() => menuCalls(before).some(c => c.method === "set_menu"));
    const seen = menuCalls(before);
    expect(seen.map(c => [c.method, c.chat])).toEqual([["set_row","user-1"],["set_menu","user-1"]]);
    expect(seen[1]!.items).toHaveLength(1);
    return seen[1]!.pid;
  };
  try {
    await r.start();
    await checkPerChat(0);
    await r.stop();
    const db = new Database(join(r.dir, "state/rh.db"));
    try { db.run("UPDATE bot SET menuHash = '1oldhash', rowHash = '2oldhash' WHERE name = 'local'"); }
    finally { db.close(); }
    const before = calls().length;
    await r.start();
    const pid = await checkPerChat(before);
    const next = calls().length;
    writeFileSync(phase, JSON.stringify({ scope: "global", maxItems: 2 }));
    process.kill(pid, "SIGKILL");
    await until(() => menuCalls(next).some(c => c.method === "set_menu"));
    const after = menuCalls(next);
    expect(after.map(c => [c.method, c.chat])).toEqual([["set_menu",undefined]]);
    expect(after[0]!.items).toHaveLength(2);
  } finally { await r.cleanup(); }
}, 30_000);
