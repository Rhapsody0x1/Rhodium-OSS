import { expect, test } from "bun:test";
import { until } from "./instance";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capabilities } from "@rhodium-oss/plugin-sdk";
import { PluginImAdapter } from "../src/plugin-im";
import type { Kept } from "../src/contracts";

const caps: Capabilities = { progress: "append", buttons: false, sendLimit: { kind: "rate", perChatPerSecond: 1 },
  maxTextLength: 2000, maxFileBytes: { image: 1000, file: 1000 }, menu: { scope: "global", maxItems: 0 }, markdown: null };

function fixture(code: string, opts: { rpcMs?: number; botFailures?: number } = {}, viaCmd = false) {
  const dir = mkdtempSync(join(tmpdir(), "rhodium-test-im "));
  const file = join(dir, "im.ts");
  writeFileSync(file, `
    import { createInterface } from "node:readline";
    const send = (m) => console.log(JSON.stringify({ jsonrpc: "2.0", ...m }));
    const caps = ${JSON.stringify(caps)};
    for await (const line of createInterface({ input: process.stdin })) {
      const m = JSON.parse(line);
      if (m.method === "shutdown") { send({ id: m.id, result: { ok: true } }); break; }
      ${code}
    }`);
  const saved = new Map<string, string>();
  const kept: Kept = { get: k => saved.get(k), set: (k, v) => { if (v === undefined) saved.delete(k); else saved.set(k, v); }, event() {} };
  let command = [process.execPath, file];
  if (viaCmd && process.platform === "win32") {
    writeFileSync(join(dir, "launch.cmd"), `@echo off\r\n"${process.execPath}" "%~dp0im.ts"\r\n`);
    command = [process.env.ComSpec ?? join(process.env.SystemRoot!, "System32/cmd.exe"), "/d", "/c", "launch.cmd"];
  }
  const adapter = new PluginImAdapter({
    id: "bot1", name: "local", plugin: { id: "test-im", dir, command, manifest: {
      id: "test-im", kind: "im", manifestVersion: 1, protocol: "rh-im/1", name: "Test IM", label: "Test IM",
      version: "1.0.0", minRhodium: "1.5.0", command, capabilities: caps,
    } },
    kept, env: {}, config: { token: "test-credential" }, handshakeMs: 2000, rpcMs: 500, stopGrace: 250, botFailures: 1, ...opts,
  });
  const stop = new AbortController();
  return { adapter, saved, stop, dir, async close() { stop.abort(); await adapter.shutdown(); rmSync(dir, { recursive: true, force: true }); } };
}

test("each plugin bot negotiates before sending and keeps its process id only while running", async () => {
  const f = fixture(`
    if (m.method === "init") {
      send({method:"connected", params:{up:true}});
      send({id:m.id, result:{proto:1, capabilities:{...caps,maxTextLength:800}}});
    }
    if (m.method === "send") send({id:m.id,result:{status:"sent",messageId:m.params.chat + "-" + m.params.message.text}});
  `, {}, true);
  try {
    const sent = f.adapter.send("owner", { text: "你好" });
    const connected = Promise.withResolvers<boolean>();
    f.adapter.messages(up => connected.resolve(up), f.stop.signal);
    expect(await connected.promise).toBe(true);
    expect(f.adapter.pid).toBeGreaterThan(0);
    expect(f.adapter.capabilities.maxTextLength).toBe(800);
    expect(await sent).toEqual({ status: "sent", messageId: "owner-你好" });
  } finally { await f.close(); }
  expect(f.adapter.pid).toBeNull();
});

test("inbound stays unacknowledged during attachment RPCs; only a committed message gets ok", async () => {
  const f = fixture(`
    if (m.method === "init") {
      send({id:m.id,result:{proto:1,capabilities:caps}});
      send({id:"stash",method:"kept_set",params:{key:"dm:u",value:"chan"}});
    }
    if (m.id === "stash") send({id:"mapping",method:"kept_get",params:{key:"dm:u"}});
    if (m.id === "mapping") send({id:"incoming",method:"inbound",params:{chat:"u",sender:"u",messageId:"A",text:m.result.value,at:1,
      attachments:[{id:"opaque",kind:"file",name:"../never-a-path"},{id:"missing",kind:"file"}]}});
    if (m.method === "fetch_attachment") {
      send({id:"track",method:"kept_set",params:{key:"fetched",value:m.params.destPath}});
      if (m.params.attachmentId === "opaque") {
        await Bun.write(m.params.destPath, "hello");
        send({id:m.id,result:{ok:true,size:5}});
      } else send({id:m.id,error:{code:-32000,message:"invalid test-credential"}});
    }
    if (m.id === "incoming") send({id:"saved",method:"kept_set",params:{key:"ack",value:String(m.result?.ok)}});
  `);
  try {
    const messages = f.adapter.messages(undefined, f.stop.signal)[Symbol.asyncIterator]();
    const { value: m } = await messages.next();
    expect(m).toMatchObject({ bot: "bot1", text: "chan", chat: "u", sender: "u" });
    const key = "plugin:bot1:";
    expect([...f.saved.entries()]).toEqual([[key + "dm:u", "chan"]]);
    expect(Buffer.from(await m!.attachments![0]!.fetch()).toString()).toBe("hello");
    const dest = f.saved.get(key + "fetched")!;
    expect(dest).not.toContain("never-a-path");
    expect(await Bun.file(dest).exists()).toBe(false);
    await expect(m!.attachments![1]!.fetch()).rejects.toThrow("invalid [redacted]");
    expect(f.saved.has(key + "ack")).toBe(false);
    m!.acknowledge?.();
    await until(() => f.saved.has(key + "ack"));
    expect(f.saved.get(key + "ack")).toBe("true");
  } finally { await f.close(); }
});

test("a lost platform receipt or RPC timeout remains unknown, without repeating send", async () => {
  const f = fixture(`
    if (m.method === "init") send({id:m.id,result:{proto:1,capabilities:caps}});
    if (m.method === "send") {
      const body = m.params.message.text;
      send({id:"kept", method:"kept_set", params:{key:"delivered",value:body + ":" + (globalThis.n = (globalThis.n ?? 0) + 1)}});
      if (body === "lost") send({id:m.id,result:{status:"unknown",error:"lost test-credential"}});
    }
    if (m.method === "edit") send({id:m.id,result:{status:"sent",messageId:"should-not-edit"}});
  `, { rpcMs: 100 });
  try {
    f.adapter.messages(undefined, f.stop.signal);
    expect(await f.adapter.send("u", { text: "lost" })).toEqual({ status: "unknown", error: "lost [redacted]" });
    expect(await f.adapter.send("u", { text: "timeout" })).toMatchObject({ status: "unknown" });
    expect(f.saved.get("plugin:bot1:delivered")).toBe("timeout:2");
    expect(await f.adapter.edit("u", "id", { text: "hello" })).toMatchObject({ status: "failed" });
  } finally { await f.close(); }
});

test("an invalid init capability table faults only its bot and cannot publish an early connected notification", async () => {
  const f = fixture(`
    if (m.method === "init") {
      send({method:"connected",params:{up:true}});
      send({id:m.id,result:{proto:1,capabilities:{...caps,sendLimit:{kind:"qq_quota"}}}});
    }
  `, { botFailures: 10 });
  try {
    const status: boolean[] = [];
    for await (const _ of f.adapter.messages(up => status.push(up), f.stop.signal)) {}
    expect(status).toEqual([false]);
    expect(f.adapter.faulted).toBe(true);
    expect(f.adapter.pid).toBeNull();
  } finally { await f.close(); }
});

test("a plugin that keeps exiting after init backs off and stops at the bot failure limit", async () => {
  const f = fixture(`
    if (m.method === "init") {
      send({id:m.id,result:{proto:1,capabilities:caps}});
      setTimeout(() => process.exit(1), 10);
    }
  `, { botFailures: 2 });
  try {
    const status: number[] = [];
    for await (const _ of f.adapter.messages(up => { if (!up) status.push(Date.now()); }, f.stop.signal)) {}
    expect(status).toHaveLength(2);
    expect(status[1]! - status[0]!).toBeGreaterThanOrEqual(950);
    expect(f.adapter.faulted).toBe(true);
    expect(f.adapter.pid).toBeNull();
  } finally { await f.close(); }
});

test("a rejected inbound transaction gets an RPC error while the next request still works", async () => {
  const f = fixture(`
    if (m.method === "init") {
      send({id:m.id,result:{proto:1,capabilities:caps}});
      send({id:"A",method:"inbound",params:{chat:"u",sender:"u",messageId:"A",at:1,text:"first"}});
    }
    if (m.id === "A") send({id:"B",method:"inbound",params:{chat:"u",sender:"u",messageId:"B",at:2,text:m.error ? "rejected" : "accepted"}});
  `);
  try {
    const messages = f.adapter.messages(undefined, f.stop.signal)[Symbol.asyncIterator]();
    (await messages.next()).value!.acknowledge!(new Error("database failed test-credential"));
    expect((await messages.next()).value).toMatchObject({ text: "rejected", messageId: "B" });
  } finally { await f.close(); }
});

test("a plugin reporting consecutive platform failures trips the breaker even while its process is alive", async () => {
  const f = fixture(`
    if (m.method === "init") {
      send({id:m.id,result:{proto:1,capabilities:caps}});
      for (const up of [false,true,false,false]) send({method:"connected",params:{up,error:"test-credential"}});
    }
  `, { botFailures: 2 });
  try {
    const status: boolean[] = [];
    for await (const _ of f.adapter.messages((up, why) => {
      expect(why).toBe("[redacted]");
      status.push(up);
    }, f.stop.signal)) {}
    expect(status).toEqual([false,true,false,false]);
    expect(f.adapter.faulted).toBe(true);
    expect(f.adapter.initFailed).toBe(false);
  } finally { await f.close(); }
});

test("negotiated edit, buttons, menus and profile use the SDK wire shapes", async () => {
  const f = fixture(`
    if (m.method === "init") send({id:m.id,result:{proto:1,capabilities:{...caps,
      progress:"edit",buttons:true,menu:{scope:"per_chat",maxItems:5,row:"reply_keyboard"}}}});
    if (m.method === "edit" || m.method === "drop_buttons")
      send({id:m.id,result:{status:"sent",messageId:m.params.messageId}});
    if (m.method === "answer_press" || m.method === "set_menu" || m.method === "set_row") {
      send({id:"log",method:"kept_set",params:{key:m.method,value:JSON.stringify(m.params)}});
      send({id:m.id,result:{ok:true}});
    }
    if (m.method === "profile") send({id:m.id,result:{name:m.params.you,botBase64:"aGk="}});
  `);
  try {
    f.adapter.messages(undefined, f.stop.signal);
    expect(await f.adapter.edit("u", "reply", { text: "edited" })).toEqual({ status: "sent", messageId: "reply" });
    expect(await f.adapter.dropButtons("u", "buttons")).toEqual({ status: "sent", messageId: "buttons" });
    await f.adapter.answerPress("u", "press", "ok");
    const items = [{ command: "new", description: "New" }];
    const row = [{ command: "new", label: "New" }];
    await f.adapter.setMenu(items, "u");
    await f.adapter.setRow(row, "u");
    expect(JSON.parse(f.saved.get("plugin:bot1:answer_press")!)).toEqual({ chat: "u", press: "press", text: "ok" });
    expect(JSON.parse(f.saved.get("plugin:bot1:set_menu")!)).toEqual({ chat: "u", items });
    expect(JSON.parse(f.saved.get("plugin:bot1:set_row")!)).toEqual({ chat: "u", row });
    expect(await f.adapter.profile("user")).toEqual({ name: "user", bot: Buffer.from("hi") });
  } finally { await f.close(); }
});
