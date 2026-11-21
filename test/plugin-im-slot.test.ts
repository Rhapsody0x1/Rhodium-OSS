import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join, resolve } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { newInstance, until } from "./instance";

type Update = { sender: string; channel: string; messageId: string; text: string; at: number; attachments?: { id: string; kind: "file"; name: string }[] };

function platform() {
  const batches: Update[][] = [];
  const cursors: string[] = [];
  const downloads: string[] = [];
  const received: { channel: string; message: { text: string } }[] = [];
  const http = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/attachments/")) {
        downloads.push(url.pathname);
        return new Response("fixture");
      }
      if (url.pathname === "/updates") {
        const cursor = url.searchParams.get("cursor") ?? "";
        cursors.push(cursor);
        const i = Number(cursor);
        return Response.json({ messages: batches[i] ?? [], nextCursor: batches[i] ? String(i + 1) : cursor });
      }
      if (url.pathname === "/send" || url.pathname === "/edit") {
        received.push(await req.json());
        return Response.json({ status: "sent", messageId: "msg-" + received.length });
      }
      return Response.json({ ok: true });
    },
  });
  const start = (owner?: string) => newInstance({ toml: [
    "[plugins.local-im]", "path = " + JSON.stringify(resolve(import.meta.dir, "../examples/plugins/local-im")),
    "[bots.local]", 'platform = "local-im"', 'target = "w/a"', "endpoint = " + JSON.stringify(http.url.origin),
    ...(owner ? ["owner = " + JSON.stringify(owner)] : []),
  ].join("\n") });
  return { batches, cursors, received, downloads, http, start };
}
const dm = (messageId: string, text: string, sender = "user-1", channel = "dm-channel-99"): Update =>
  ({ sender, channel, text, messageId, at: Date.now() });

test("pairing a plugin DM binds its sender, and a fresh plugin sends to its saved platform channel", async () => {
  const p = platform();
  const r = p.start();
  try {
    await r.start();
    await r.slots("a");
    const code = (await r.ok("pair", "local")).match(/配对码：(\S+)/)![1]!;
    p.batches.push([dm("s", "stranger message", "stranger", "other-channel"), dm("pair", code)]);
    await until(() => p.cursors.includes("1"));
    expect((await r.ok("pair", "local", "--list"))).toContain("user-1");
    expect(readFileSync(r.config, "utf8")).toContain("user-1");
    expect(r.claude.runs()).toHaveLength(0);
    await until(() => p.received.some((m) => m.channel === "dm-channel-99" && m.message.text.includes("已配对")));
    await r.stop();
    await r.start();
    await r.ok("send", "me", "after restart");
    expect(p.received.filter((m) => m.message.text.includes("after restart")).map((m) => m.channel)).toEqual(["dm-channel-99"]);
    const receipt = await r.rh(["send", "me", "[simulate-unknown]"]);
    expect(receipt.out + receipt.err).toContain("不知道");
    expect(p.received.filter((m) => m.message.text.includes("[simulate-unknown]"))).toHaveLength(1);
  } finally {
    await r.cleanup();
    p.http.stop(true);
  }
}, 30_000);

test("a rejected SQLite transaction leaves the batch cursor before A; after restart A is deduplicated and B commits", async () => {
  const p = platform();
  const r = p.start("user-1");
  let db: Database | undefined;
  try {
    const daemon = await r.start();
    await r.slots("a");
    db = new Database(join(r.dir, "state/rh.db"));
    db.exec("CREATE TRIGGER reject_b BEFORE INSERT ON inbound WHEN NEW.platformMsgId = 'B' BEGIN SELECT RAISE(ABORT, 'batch-test-B'); END");
    const withFile = (msg: Update) => ({ ...msg, attachments: [{ id: msg.messageId, kind: "file" as const, name: "sample.txt" }] });
    p.batches.push([withFile(dm("stranger", "ignore", "other", "other-channel")), withFile(dm("A", "first input")), dm("B", "second input")]);
    await until(() => daemon.logs.some((l) => l.msg === "input failed" && String(l.error).includes("batch-test-B")));
    await r.stop();
    expect(db.query("SELECT platformMsgId FROM inbound WHERE sender = 'user-1' ORDER BY id").all()).toEqual([{ platformMsgId: "A" }]);
    expect(db.query("SELECT value FROM meta WHERE id LIKE 'plugin:%:sync_buf'").get()).toBeNull();
    db.exec("DROP TRIGGER reject_b");
    await r.start();
    await until(() => p.cursors.includes("1"));
    expect(db.query("SELECT platformMsgId FROM inbound WHERE sender = 'user-1' ORDER BY id").all()).toEqual([{ platformMsgId: "A" }, { platformMsgId: "B" }]);
    expect(p.downloads).toEqual(["/attachments/A"]);
    const hash = new Bun.CryptoHasher("sha256").update("fixture").digest("hex");
    expect(readFileSync(join(r.dir, "state/media", hash), "utf8")).toBe("fixture");
    expect(db.query("SELECT COUNT(*) AS n FROM agentInput WHERE source = 'human'").get()).toEqual({ n: 2 });
  } finally {
    db?.close();
    await r.cleanup();
    p.http.stop(true);
  }
}, 30_000);

test("a bad plugin handshake faults only that bot and tells the main chat that reconnecting stopped", async () => {
  const r = newInstance({
    bots: { good: { like: "telegram", owner: "user" } },
    toml: ['mainChat = "good/user"', "[plugins.local-im]", "path = " + JSON.stringify(resolve(import.meta.dir, "../examples/plugins/local-im")),
      "[bots.bad]", 'platform = "local-im"', 'endpoint = "invalid-url"'].join("\n"),
  });
  try {
    const daemon = await r.start();
    await until(async () => (await r.im.log("good", "user")).some((m) => m.text.includes("Bot bad")));
    const [notice] = await r.im.log("good", "user");
    expect(notice?.text).toContain("已停止重连");
    expect(daemon.logs.some((l) => l.msg === "plugin im init failed")).toBe(true);
    await r.ok("send", "me", "healthy");
    expect((await r.im.log("good", "user")).at(-1)?.text).toBe("healthy");
  } finally {
    await r.cleanup();
  }
}, 15_000);

test.skipIf(process.platform !== "linux")("rh doctor audits the live IM plugin process", async () => {
  const example = resolve(import.meta.dir, "../examples/plugins/local-im");
  const r = newInstance({ toml: '[plugins.probe]\npath = "."\n[bots.probe]\nplatform = "probe"' });
  const manifest = JSON.parse(readFileSync(join(example, "plugin.json"), "utf8"));
  writeFileSync(join(r.dir, "plugin.json"), JSON.stringify({ ...manifest, id: "probe",
    command: ["env", "Anthropic_Base_Url=synthetic", process.execPath, join(example, "index.ts")] }));
  try {
    await r.start();
    const report = await r.ok("doctor");
    expect(report).toMatch(/插件 probe 进程 \d+ 合规异常：携带 ANTHROPIC_\/CLAUDE 环境变量/);
  } finally {
    await r.cleanup();
  }
}, 30_000);

test("two bots sharing a plugin get separate config, kept keys and a filtered environment", async () => {
  const r = newInstance({ env: { Anthropic_Api_Key: "test-only", CLAUDE_code_oauth_token: "test-only" }, toml: [
    "[plugins.probe]", 'path = "."', "[plugins.probe.config]", 'shared = "default"',
    "[bots.first]", 'platform = "probe"', 'owner = "user-1"', 'target = "w/a"', 'shared = "override"', 'first = "1"',
    "[bots.second]", 'platform = "probe"', 'second = "2"',
  ].join("\n") });
  const manifest = JSON.parse(readFileSync(resolve(import.meta.dir, "../examples/plugins/local-im/plugin.json"), "utf8"));
  writeFileSync(join(r.dir, "plugin.json"), JSON.stringify({ ...manifest, id: "probe", command: [process.execPath, "${PLUGIN_DIR}/init.ts"] }));
  writeFileSync(join(r.dir, "init.ts"), `
    import { runImPlugin } from ${JSON.stringify(resolve(import.meta.dir, "../packages/plugin-sdk/index.ts"))};
    runImPlugin({
      async init(p, ctx) {
        await ctx.keptSet("fixture", JSON.stringify({ keys: Object.keys(p.config).sort(), shared: p.config.shared,
          filtered: !process.env.Anthropic_Api_Key && !process.env.CLAUDE_code_oauth_token }));
        ctx.connected(true);
        return ${JSON.stringify(manifest.capabilities)};
      }
    });
  `);
  let db: Database | undefined;
  try {
    await r.start();
    db = new Database(join(r.dir, "state/rh.db"), { readonly: true });
    const q = db.query<{ name: string; value: string }, []>("SELECT name,value FROM bot JOIN meta ON meta.id = 'plugin:' || bot.id || ':fixture' ORDER BY name");
    await until(() => q.all().length === 2);
    expect(q.all().map(({ name, value }) => [name, JSON.parse(value)])).toEqual([
      ["first", { keys: ["first", "shared"], shared: "override", filtered: true }],
      ["second", { keys: ["second", "shared"], shared: "default", filtered: true }],
    ]);
  } finally {
    db?.close();
    await r.cleanup();
  }
}, 15_000);
