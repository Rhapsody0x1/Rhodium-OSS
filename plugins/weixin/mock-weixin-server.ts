import type { Incoming, Item } from "./api";

export const mockToken = "mock-weixin-token";
const mockChat = "conf-user-1";
const mockContext = "mock-context";

type MockInput = { id: number; text?: string; sender?: string; items?: Item[] };
type MockOutput = { to_user_id: string; context_token: string; item_list: Item[] };
type MockUpload = { param: string; expected: number };

export function startMock({ port = 0, seed = false } = {}) {
  const batches: Incoming[][] = [];
  const cursors: string[] = [];
  const sent: MockOutput[] = [];
  const uploads = new Map<string, MockUpload>();
  const blobs = new Map<string, ArrayBuffer>();
  const qrPolls = new Map<string, number>();
  let qrCount = 0, loseReceipt = false;
  const queue = (inputs: MockInput[]) => batches.push(inputs.map(input => ({
    from_user_id: input.sender ?? mockChat, message_id: input.id, message_type: 1, message_state: 2,
    create_time_ms: Date.now(), context_token: mockContext,
    item_list: input.items ?? [{ type: 1, text_item: { text: input.text } }],
  })));
  if (seed) queue([{ id: 1, text: "offline fixture" }]);

  const server = Bun.serve({ hostname: "127.0.0.1", port, async fetch(req, server) {
    const url = new URL(req.url);
    const route = url.pathname;
    const reject = (status = 400) => Response.json({ ret: -1 }, { status });
    if (route === "/mock/inbound" && req.method === "POST") {
      const input = await req.json() as MockInput[];
      if (!Array.isArray(input) || input.some(msg => !Number.isSafeInteger(msg.id))) return reject();
      queue(input);
      return Response.json({ ok: true });
    }
    if (route === "/mock/sent" && req.method === "GET") return Response.json(sent);

    if (route === "/c2c/upload" && req.method === "POST") {
      const upload = uploads.get(url.searchParams.get("filekey") ?? "");
      if (!upload || upload.param !== url.searchParams.get("encrypted_query_param")) return reject();
      const bytes = await req.arrayBuffer();
      if (bytes.byteLength !== upload.expected) return reject();
      blobs.set(upload.param, bytes);
      return new Response(null, { headers: { "x-encrypted-param": upload.param } });
    }
    if (route === "/c2c/download" && req.method === "GET") {
      const bytes = blobs.get(url.searchParams.get("encrypted_query_param") ?? "");
      return bytes ? new Response(bytes) : reject(404);
    }

    if (req.headers.get("iLink-App-Id") !== "bot" || req.headers.get("iLink-App-ClientVersion") !== "196609") return reject();
    if (route === "/ilink/bot/get_qrcode_status" && req.method === "GET") {
      if (req.headers.has("authorization") || req.headers.has("authorizationtype") || req.headers.has("x-wechat-uin")) return reject();
      const code = url.searchParams.get("qrcode") ?? "";
      const polls = qrPolls.get(code);
      if (polls === undefined) return reject(404);
      qrPolls.set(code, polls + 1);
      if (polls === 0) return Response.json({ status: "wait" });
      if (polls === 1 && url.searchParams.get("verify_code") !== "123456") {
        qrPolls.set(code, 1);
        return Response.json({ status: "need_verifycode" });
      }
      if (polls === 1) return Response.json({ status: "scaned" });
      return Response.json({ status: "confirmed", bot_token: mockToken, baseurl: server.url.origin, ilink_bot_id: "mock-bot" });
    }
    if (req.method !== "POST" || req.headers.get("authorizationtype") !== "ilink_bot_token" ||
        !req.headers.get("x-wechat-uin")) return reject();
    const body = await req.json();
    if (route === "/ilink/bot/get_bot_qrcode") {
      if (req.headers.has("authorization") || url.searchParams.get("bot_type") !== "3" ||
          !Array.isArray(body.local_token_list) || body.base_info) return reject();
      const code = `mock-qr-${++qrCount}`;
      qrPolls.set(code, 0);
      return Response.json({ qrcode: code, qrcode_img_content: `${server.url.origin}/${code}` });
    }

    if (req.headers.get("authorization") !== `Bearer ${mockToken}`) return reject(401);
    if (!body.base_info?.channel_version?.startsWith("3.0.1/") || body.base_info?.bot_agent !== "Rhodium") return reject();
    if (route === "/ilink/bot/getupdates") {
      const cursor = body.get_updates_buf;
      if (typeof cursor !== "string" || "sync_buf" in body) return reject();
      cursors.push(cursor);
      const index = Number(cursor);
      const batch = batches[index];
      if (!batch) await Bun.sleep(100);
      return Response.json({ ret: 0, msgs: batch ?? [], ...(batch && { get_updates_buf: String(index + 1) }) });
    }
    if (route === "/ilink/bot/sendmessage") {
      const msg = body.msg;
      if (!msg?.to_user_id || msg.context_token !== mockContext || !msg.client_id ||
          msg.message_type !== 2 || msg.message_state !== 2 || !msg.item_list?.length) return reject();
      sent.push(msg);
      if (loseReceipt) {
        loseReceipt = false;
        return new Response(null);
      }
      return Response.json({ ret: 0 });
    }
    if (route === "/ilink/bot/getuploadurl") {
      const { filekey, rawsize, filesize, rawfilemd5, aeskey, media_type } = body;
      if (!/^[a-f0-9]{32}$/.test(filekey) || !/^[a-f0-9]{32}$/.test(rawfilemd5) || !/^[a-f0-9]{32}$/.test(aeskey) ||
          ![1, 2, 3].includes(media_type) || !Number.isSafeInteger(rawsize) ||
          filesize !== (Math.floor(rawsize / 16) + 1) * 16) return reject();
      const param = `mock-media-${filekey}`;
      uploads.set(filekey, { param, expected: filesize });
      return Response.json({ upload_param: param, upload_full_url:
        `${server.url.origin}/c2c/upload?encrypted_query_param=${param}&filekey=${filekey}` });
    }
    return reject(404);
  } });
  return { server, queue, sent, cursors, chat: mockChat, contextToken: mockContext,
    config: { token: mockToken, baseUrl: server.url.origin, cdnBaseUrl: `${server.url.origin}/c2c` },
    loseNextReceipt() { loseReceipt = true; },
  };
}

if (import.meta.main) {
  const port = Number(Bun.argv[2] ?? 18080);
  const mock = startMock({ port, seed: Bun.argv.includes("--seed") });
  console.log(mock.server.url.origin);
}
