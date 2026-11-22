import { randomBytes } from "node:crypto";

export const defaultBase = "https://ilinkai.weixin.qq.com";
export const defaultCdn = "https://novac2c.cdn.weixin.qq.com/c2c";
const appHeaders = { "iLink-App-Id": "bot", "iLink-App-ClientVersion": "196609" };
const baseInfo = { channel_version: "3.0.1/rhodium-weixin-0.1.0", bot_agent: "Rhodium" };

export type Reply = { ret?: number; errcode?: number };
export type SendReply = Reply & { message_id?: string };
export type Media = { full_url?: string; encrypt_query_param?: string; aes_key?: string; encrypt_type?: number };
export type Item = {
  type: number;
  msg_id?: string;
  text_item?: { text?: string };
  voice_item?: { text?: string };
  image_item?: { aeskey?: string; media?: Media; mid_size?: number };
  file_item?: { file_name?: string; len?: string; media?: Media };
  video_item?: { media?: Media; video_size?: number };
  ref_msg?: { message_item?: Item; title?: string; svr_id?: string };
};
export type Incoming = {
  from_user_id?: string;
  group_id?: string;
  message_type?: number;
  message_state?: number;
  message_id?: string;
  seq?: number;
  client_id?: string;
  context_token?: string;
  create_time_ms?: number;
  item_list?: Item[];
};
export type Updates = Reply & { msgs?: Incoming[]; get_updates_buf?: string; longpolling_timeout_ms?: number };

export function endpoint(root: string, path: string) {
  return new URL(root.replace(/\/+$/, "") + "/" + path);
}

export function serviceUrl(value: string) {
  const url = new URL(value);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(loopback && url.protocol === "http:")) ||
      url.username || url.password) throw new Error("Invalid Weixin service URL");
  return url;
}

export class HttpError extends Error {
  constructor(readonly status: number) { super(`Weixin HTTP ${status}`); }
}

export class HttpTimeout extends Error {}

export class HttpInterrupted extends Error {}

export async function request(url: URL, options: RequestInit, signal: AbortSignal, timeout: number) {
  const deadline = AbortSignal.timeout(timeout);
  try {
    return await fetch(serviceUrl(url.href), {
      ...options, redirect: "error", signal: AbortSignal.any([signal, deadline]),
    });
  } catch (error) {
    if (!signal.aborted && (deadline.aborted || (error instanceof DOMException && error.name === "TimeoutError"))) {
      throw new HttpTimeout("Weixin HTTP request timed out");
    }
    throw new HttpInterrupted("Weixin HTTP request interrupted");
  }
}

export async function json<T>(url: URL, options: RequestInit, signal: AbortSignal, timeout: number): Promise<T> {
  const response = await request(url, options, signal, timeout);
  if (!response.ok) throw new HttpError(response.status);
  let result: unknown;
  try {
    const body = await response.text();
    // Mirrors Tencent/openclaw-weixin@ffc7ae16 src/api/api.ts LOSSLESS_ID_FIELDS / parseWeixinApiJson.
    result = JSON.parse(body.replace(
      /("(?:message_id|msg_id|svr_id)"\s*:\s*)(\d+)(?=\s*[,}])|"(?:[^"\\]|\\[\s\S])*"/g,
      (token, field?: string, digits?: string) => field === undefined ? token : field + JSON.stringify(digits),
    ));
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") throw new HttpTimeout("Weixin HTTP request timed out");
    throw new Error("Invalid Weixin response");
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Invalid Weixin response");
  return result as T;
}

function jsonHeaders() {
  return {
    ...appHeaders, "Content-Type": "application/json", AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": Buffer.from(String(randomBytes(4).readUInt32BE())).toString("base64"),
  };
}

export class ILink {
  constructor(readonly base: string, private readonly token: string, readonly signal: AbortSignal) {}

  post<T>(path: string, body: object, timeout: number) {
    return json<T>(endpoint(this.base, `ilink/bot/${path}`), {
      method: "POST",
      headers: { ...jsonHeaders(), Authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ ...body, base_info: baseInfo }),
    }, this.signal, timeout);
  }
}

export function getQr(base: string, signal: AbortSignal) {
  return json<Reply & { qrcode?: string; qrcode_img_content?: string }>(
    endpoint(base, "ilink/bot/get_bot_qrcode?bot_type=3"),
    { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ local_token_list: [] }) }, signal, 8_000,
  );
}

export function qrStatus(base: string, code: string, pin: string, signal: AbortSignal) {
  const url = endpoint(base, "ilink/bot/get_qrcode_status");
  url.searchParams.set("qrcode", code);
  if (pin) url.searchParams.set("verify_code", pin);
  return json<Reply & {
    status?: string; redirect_host?: string; bot_token?: string; baseurl?: string; ilink_bot_id?: string;
  }>(url, { headers: appHeaders }, signal, 40_000);
}

export function replyCode(reply: Reply) {
  return reply.errcode || reply.ret || 0;
}
