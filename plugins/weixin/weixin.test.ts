import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImContext, ImInboundMessage } from "../../packages/plugin-sdk";
import { download } from "./media";
import { startMock } from "./mock-weixin-server";
import { Weixin } from "./weixin";
import { wizard } from "./wizard";

function core() {
  const kept = new Map<string, string>();
  const seen = new Map<string, ImInboundMessage>();
  const attempts: string[] = [];
  const connections: boolean[] = [];
  let reject = "";
  const ctx: ImContext = {
    connected(up) { connections.push(up); },
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
  return { ctx, kept, seen, attempts, connections, reject(id: string) { reject = id; } };
}

async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 250; attempt++) {
    if (check()) return;
    await Bun.sleep(10);
  }
  throw new Error("Timed out waiting for adapter state");
}

async function withEndpoint(
  respond: (path: string) => Response,
  verify: (plugin: Weixin, state: ReturnType<typeof core>) => Promise<void>,
) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => respond(new URL(request.url).pathname) });
  const plugin = new Weixin(), state = core();
  state.kept.set("ctx:test-user", "test-context");
  try {
    await plugin.init({ proto: 1, botId: "test", botName: "test", config: { baseUrl: server.url.origin, token: "test-token" } }, state.ctx);
    await verify(plugin, state);
  } finally {
    await plugin.shutdown();
    await server.stop(true);
  }
}

test("accepts a success object without a status and returns the exact server message ID", async () => {
  const replies = ["{}", '{"message_id":18446744073709551615}', '{"errcode":-1}'];
  await withEndpoint(path => path.endsWith("/sendmessage")
    ? new Response(replies.shift())
    : Response.json({ msgs: [] }), async (plugin, { ctx }) => {
    expect(await plugin.send("test-user", { text: "test message" }, ctx)).toMatchObject({ status: "sent" });
    expect(await plugin.send("test-user", { text: "test message" }, ctx)).toEqual({
      status: "sent", messageId: "18446744073709551615",
    });
    expect(await plugin.send("test-user", { text: "test message" }, ctx)).toMatchObject({ status: "failed" });
  });
});

test("delivers new private messages with exact uint64 IDs and quoted text", async () => {
  let polls = 0;
  const batch = `{"get_updates_buf":"next","msgs":[
    {"from_user_id":"test-user","message_id":9007199254740992,"message_state":0,
     "item_list":[{"type":1,"text_item":{"text":"First"},"ref_msg":{"svr_id":18446744073709551615,"title":"Reference"}}]},
    {"from_user_id":"test-user","message_id":9007199254740993,"message_type":1,"message_state":2,
     "item_list":[{"type":1,"text_item":{"text":"Message includes \\"msg_id\\":123"},"ref_msg":{"message_item":{"msg_id":18446744073709551614}}}]},
    {"from_user_id":"test-user","message_id":3,"message_type":2},
    {"from_user_id":"test-user","message_id":4,"group_id":"group"}
  ]}`;
  await withEndpoint(() => polls++ === 0 ? new Response(batch) : Response.json({ msgs: [] }), async (_plugin, state) => {
    await until(() => state.kept.get("sync_buf") === "next");
    expect([...state.seen.keys()]).toEqual(["9007199254740992", "9007199254740993"]);
    expect(state.seen.get("9007199254740992")?.quote).toEqual({ ref: "18446744073709551615", text: "Reference" });
    expect(state.seen.get("9007199254740993")).toMatchObject({
      text: 'Message includes "msg_id":123', quote: { ref: "18446744073709551614" },
    });
  });
});

test("reports a short outage once and restores online status after retrying", async () => {
  let polls = 0;
  await withEndpoint(() => {
    polls++;
    if (polls === 2 || polls === 3) return new Response(null, { status: 503 });
    return Response.json({ msgs: [] });
  }, async (_plugin, state) => {
    for (let attempt = 0; polls < 4 && attempt < 100; attempt++) await Bun.sleep(50);
    expect(polls).toBeGreaterThanOrEqual(4);
    await until(() => state.connections.at(-1) === true);
    expect(state.connections).toEqual([true, false, true]);
  });
}, 8_000);

test("wizard renews expired QR codes and follows redirects after a status timeout", async () => {
  const redirectHost = "redirect.mock.test";
  const mock = startMock({ wizardRedirectHost: redirectHost });
  const fetchOriginal = globalThis.fetch;
  const redirects: string[] = [];
  let statusRequests = 0;
  const fetchMock: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/get_qrcode_status") && ++statusRequests === 1) {
      throw new DOMException("Mock long poll timed out", "TimeoutError");
    }
    if (url.hostname === redirectHost) {
      redirects.push(url.href);
      return fetchOriginal(new URL(url.pathname + url.search, mock.config.baseUrl), options);
    }
    return fetchOriginal(input, options);
  }, { preconnect: fetchOriginal.preconnect });
  const intercept = spyOn(globalThis, "fetch").mockImplementation(fetchMock);
  const codes: string[] = [];
  try {
    const done = await wizard({ botName: "test", config: mock.config }, {
      signal: AbortSignal.timeout(5_000),
      qr(data) { codes.push(data); },
      waiting() {},
      link() {},
      async input() { return "123456"; },
    });
    expect(codes).toHaveLength(2);
    expect(redirects).toEqual([`https://${redirectHost}/ilink/bot/get_qrcode_status?qrcode=mock-qr-2`]);
    expect(done.config).toEqual({ token: mock.config.token, baseUrl: mock.config.baseUrl, accountId: "mock-bot" });
  } finally {
    intercept.mockRestore();
    await mock.server.stop(true);
  }
});

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
    expect(await plugin.send(mock.chat, { text: "caption", file: { kind: "image", path: source, name: "source.png" } }, state.ctx))
      .toMatchObject({ status: "sent" });
    expect(mock.sent[0]?.item_list[0]?.text_item?.text).toBe("caption");
    const media = mock.sent[1]?.item_list[0]?.image_item?.media;
    expect(media?.encrypt_type).toBe(1);
    const hexKey = Buffer.from(media!.aes_key!, "base64").toString("ascii");
    mock.queue([{ id: 2, items: [{ type: 2, image_item: { aeskey: hexKey, media: {
      ...media, aes_key: "unused", full_url: `${mock.config.cdnBaseUrl}/download?encrypted_query_param=${media?.encrypt_query_param}`,
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

async function withImage(full: (cdn: string) => string, verify: (
  fetchIt: () => Promise<unknown>, mock: ReturnType<typeof startMock>,
) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "rhodium-weixin-fetch-"));
  const mock = startMock({ seed: true });
  const state = core();
  const plugin = new Weixin();
  try {
    await plugin.init({ proto: 1, botId: "test", botName: "test", config: mock.config }, state.ctx);
    mock.putBlob("plain", Buffer.from("plain image"));
    mock.queue([{ id: 2, items: [{ type: 2, image_item: { media: { full_url: full(mock.config.cdnBaseUrl) } } }] }]);
    await until(() => state.seen.has("2"));
    const id = state.seen.get("2")!.attachments![0]!.id;
    await verify(() => plugin.fetchAttachment(id, join(root, "dest.png")), mock);
  } finally {
    await plugin.shutdown();
    await mock.server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}

test("retries an attachment download once after a server error", async () => {
  await withImage(cdn => `${cdn}/download?encrypted_query_param=plain`, async (fetchIt, mock) => {
    mock.failDownloads(503);
    expect(await fetchIt()).toEqual({ ok: true, size: 11 });
  });
});

test("does not retry a rejected attachment download and reports why", async () => {
  await withImage(cdn => `${cdn}/download?encrypted_query_param=plain`, async (fetchIt, mock) => {
    mock.failDownloads(403);
    await expect(fetchIt()).rejects.toThrow("Weixin HTTP 403");
  });
});

test("both download attempts share one deadline", async () => {
  const root = await mkdtemp(join(tmpdir(), "rhodium-weixin-deadline-"));
  const mock = startMock();
  try {
    mock.putBlob("plain", Buffer.from("plain image"));
    mock.failDownloads(503);
    mock.slowDownloads(5_000);
    const dest = join(root, "dest.png"), started = Date.now();
    await expect(download(mock.config.cdnBaseUrl, { kind: "image", media: { encrypt_query_param: "plain" } },
      dest, new AbortController().signal, 2_500)).rejects.toThrow("Weixin HTTP request timed out");
    expect(Date.now() - started).toBeLessThan(3_500);
    expect(await Bun.file(dest).exists()).toBe(false);
  } finally {
    await mock.server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

test("reports a wrong attachment key without the raw cipher error", async () => {
  const root = await mkdtemp(join(tmpdir(), "rhodium-weixin-key-"));
  const mock = startMock();
  try {
    mock.putBlob("sealed", new Uint8Array(32).fill(7));
    await expect(download(mock.config.cdnBaseUrl, { kind: "image", key: "00".repeat(16), media: { encrypt_query_param: "sealed" } },
      join(root, "dest.png"), new AbortController().signal)).rejects.toThrow(/^Weixin attachment could not be decrypted$/);
  } finally {
    await mock.server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

test("never echoes a malformed attachment URL in the error", async () => {
  await withImage(() => "http://[secret-token", async fetchIt => {
    const error = await fetchIt().catch((e: Error) => e) as Error;
    expect(error.message).not.toContain("secret-token");
    expect(error.message).toBe("Invalid Weixin media address");
  });
});
