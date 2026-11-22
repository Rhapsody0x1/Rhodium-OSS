import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImContext, ImInboundMessage } from "../../packages/plugin-sdk";
import { startMock } from "./mock-weixin-server";
import { Weixin } from "./weixin";

function core() {
  const kept = new Map<string, string>();
  const seen = new Map<string, ImInboundMessage>();
  const attempts: string[] = [];
  let reject = "";
  const ctx: ImContext = {
    connected() {},
    log() {},
    async keptGet(key) { return kept.get(key) ?? null; },
    async keptSet(key, value) {
      if (value === null) kept.delete(key);
      else kept.set(key, value);
    },
    async inbound(msg) {
      attempts.push(msg.messageId);
      if (msg.messageId === reject) throw new Error("Interrupted before durable receipt");
      seen.set(msg.messageId, msg);
    },
  };
  return { ctx, kept, seen, attempts, reject(id: string) { reject = id; } };
}

async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 250; attempt++) {
    if (check()) return;
    await Bun.sleep(10);
  }
  throw new Error("Timed out waiting for adapter state");
}

test("replays an interrupted batch and restores context and cursor on restart", async () => {
  const mock = startMock();
  const state = core();
  const first = new Weixin(), second = new Weixin();
  const params = { proto: 1 as const, botId: "test", botName: "test", config: mock.config };
  try {
    mock.queue([{ id: 101, text: "A" }, { id: 102, text: "B" }]);
    state.reject("102");
    await first.init(params, state.ctx);
    await until(() => state.attempts.includes("102"));
    await first.shutdown();
    expect(state.kept.has("sync_buf")).toBe(false);
    expect([...state.seen.keys()]).toEqual(["101"]);

    state.reject("");
    await second.init(params, state.ctx);
    await until(() => state.kept.get("sync_buf") === "1");
    expect(state.attempts).toEqual(["101", "102", "101", "102"]);
    expect([...state.seen.keys()]).toEqual(["101", "102"]);
    expect(state.seen.get("102")).toMatchObject({ chat: mock.chat, sender: mock.chat, text: "B" });
    await second.shutdown();

    const restored = new Weixin();
    try {
      const polls = mock.cursors.length;
      await restored.init(params, state.ctx);
      await until(() => mock.cursors.length > polls);
      expect(mock.cursors[polls]).toBe("1");
      expect(await restored.send(mock.chat, { text: "after restart" }, state.ctx)).toMatchObject({ status: "sent" });
      expect(mock.sent.at(-1)).toMatchObject({ to_user_id: mock.chat, context_token: mock.contextToken });
    } finally { await restored.shutdown(); }
  } finally {
    await first.shutdown();
    await second.shutdown();
    await mock.server.stop(true);
  }
});

test("refuses missing context without a request and never retries a lost receipt", async () => {
  const mock = startMock();
  const { ctx, kept } = core();
  const plugin = new Weixin();
  try {
    await plugin.init({ proto: 1, botId: "test", botName: "test", config: mock.config }, ctx);
    expect(await plugin.send("stranger", { text: "no context" }, ctx)).toMatchObject({ status: "failed" });
    expect(mock.sent).toHaveLength(0);
    kept.set(`ctx:${mock.chat}`, mock.contextToken);
    mock.loseNextReceipt();
    expect(await plugin.send(mock.chat, { text: "received once" }, ctx)).toMatchObject({ status: "unknown" });
    expect(mock.sent).toHaveLength(1);
  } finally {
    await plugin.shutdown();
    await mock.server.stop(true);
  }
});

test("uploads encrypted media and downloads it only on attachment request", async () => {
  const root = await mkdtemp(join(tmpdir(), "rhodium-weixin-media-"));
  const mock = startMock({ seed: true });
  const state = core();
  const plugin = new Weixin();
  try {
    await plugin.init({ proto: 1, botId: "test", botName: "test", config: mock.config }, state.ctx);
    await until(() => state.kept.get("sync_buf") === "1");
    const source = join(root, "source.png"), dest = join(root, "dest.png");
    const content = Buffer.from("mock image bytes");
    await Bun.write(source, content);
    expect(await plugin.send(mock.chat, { text: "", file: { kind: "image", path: source, name: "source.png" } }, state.ctx))
      .toMatchObject({ status: "sent" });
    const media = mock.sent[0]?.item_list[0]?.image_item?.media;
    expect(media?.encrypt_type).toBe(1);
    mock.queue([{ id: 2, items: [{ type: 2, image_item: { media: {
      ...media, full_url: `${mock.config.cdnBaseUrl}/download?encrypted_query_param=${media?.encrypt_query_param}`,
    } } }] }]);
    await until(() => state.seen.has("2"));
    const id = state.seen.get("2")?.attachments?.[0]?.id;
    expect(id).toBeTruthy();
    expect(await Bun.file(dest).exists()).toBe(false);
    expect(await plugin.fetchAttachment(id!, dest)).toEqual({ ok: true, size: content.length });
    expect(await Bun.file(dest).bytes()).toEqual(new Uint8Array(content));
  } finally {
    await plugin.shutdown();
    await mock.server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});
