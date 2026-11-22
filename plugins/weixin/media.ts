import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { OutboundMessageWire } from "../../packages/plugin-sdk";
import {
  endpoint, HttpError, HttpInterrupted, HttpTimeout, ILink, type Item, type Media, replyCode, type Reply, request, serviceUrl,
} from "./api";

export const maxFileBytes = { image: 10 * 1024 * 1024, file: 25 * 1024 * 1024 };

export type Attachment = { media: Media; key?: string; kind: "image" | "file" };

function cdnUrl(root: string, path: string, full?: string, query?: string, filekey?: string) {
  if (full) {
    // Never echo the address: it may carry tokens.
    try { return serviceUrl(full); } catch { throw new Error("Invalid Weixin media address"); }
  }
  if (!query) throw new Error("Weixin media address missing");
  const url = endpoint(root, path);
  url.searchParams.set("encrypted_query_param", query);
  if (filekey) url.searchParams.set("filekey", filekey);
  return url;
}

function decodeKey(attachment: Attachment) {
  if (attachment.key) {
    if (!/^[\da-f]{32}$/i.test(attachment.key)) throw new Error("Invalid Weixin image key");
    return Buffer.from(attachment.key, "hex");
  }
  if (!attachment.media.aes_key) return null;
  const key = Buffer.from(attachment.media.aes_key, "base64");
  if (key.length === 16) return key;
  if (/^[\da-f]{32}$/i.test(key.toString())) return Buffer.from(key.toString(), "hex");
  throw new Error("Invalid Weixin media key");
}

class TooLarge extends Error {
  constructor() { super("Weixin attachment exceeds the size limit"); }
}

const transient = (error: unknown) => error instanceof HttpTimeout || error instanceof HttpInterrupted ||
  (error instanceof HttpError && error.status >= 500);

export async function download(root: string, attachment: Attachment, dest: string, signal: AbortSignal) {
  try {
    return await downloadOnce(root, attachment, dest, signal);
  } catch (error) {
    if (signal.aborted || !transient(error)) throw error;
    await Bun.sleep(1_000);
    return downloadOnce(root, attachment, dest, signal);
  }
}

async function downloadOnce(root: string, attachment: Attachment, dest: string, signal: AbortSignal) {
  const { media, kind } = attachment;
  const key = decodeKey(attachment);
  if (!key && kind !== "image") throw new Error("Weixin media key missing");
  // The deadline covers the body too: 20 s plus about 100 KB/s up to the size limit.
  const timeout = 20_000 + maxFileBytes[kind] / 100;
  const response = await request(cdnUrl(root, "download", media.full_url, media.encrypt_query_param), {}, signal, timeout);
  if (!response.ok) throw new HttpError(response.status);
  const max = maxFileBytes[kind];
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Weixin media response body missing");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max + (key ? 16 : 0)) throw new TooLarge();
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof TooLarge) throw error;
    if (error instanceof DOMException && error.name === "TimeoutError") throw new HttpTimeout("Weixin HTTP request timed out");
    throw new HttpInterrupted("Weixin HTTP request interrupted");
  } finally { reader.releaseLock(); }
  let bytes = Buffer.concat(chunks);
  if (key) {
    const cipher = createDecipheriv("aes-128-ecb", key, null);
    bytes = Buffer.concat([cipher.update(bytes), cipher.final()]);
  }
  if (bytes.length > max) throw new TooLarge();
  await Bun.write(dest, bytes);
  return { ok: true as const, size: bytes.length };
}

export async function upload(api: ILink, root: string, chat: string, file: NonNullable<OutboundMessageWire["file"]>): Promise<Item> {
  const source = Bun.file(file.path);
  if (source.size > maxFileBytes[file.kind]) throw new Error("Weixin attachment exceeds the size limit");
  const bytes = await source.bytes();
  if (bytes.length > maxFileBytes[file.kind]) throw new Error("Weixin attachment exceeds the size limit");
  const key = randomBytes(16), filekey = randomBytes(16).toString("hex");
  const cipher = createCipheriv("aes-128-ecb", key, null);
  const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
  const mediaType = file.kind === "image" ? 1 : /\.mp4$/i.test(file.name) ? 2 : 3;
  const result = await api.post<Reply & { upload_full_url?: string; upload_param?: string }>("getuploadurl", {
    filekey, media_type: mediaType, to_user_id: chat, rawsize: bytes.length,
    rawfilemd5: createHash("md5").update(bytes).digest("hex"), filesize: encrypted.length,
    no_need_thumb: true, aeskey: key.toString("hex"),
  }, 8_000);
  if (replyCode(result)) throw new Error("Weixin rejected media upload");
  const response = await request(cdnUrl(root, "upload", result.upload_full_url, result.upload_param, filekey), {
    method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: encrypted,
  }, api.signal, 15_000);
  const param = response.headers.get("x-encrypted-param");
  await response.body?.cancel();
  if (response.status !== 200 || !param) throw new Error("Weixin media upload receipt missing");
  const media: Media = { encrypt_query_param: param, aes_key: Buffer.from(key.toString("hex")).toString("base64"), encrypt_type: 1 };
  if (mediaType === 1) return { type: 2, image_item: { media, mid_size: encrypted.length } };
  if (mediaType === 2) return { type: 5, video_item: { media, video_size: encrypted.length } };
  return { type: 4, file_item: { media, file_name: file.name, len: String(bytes.length) } };
}
