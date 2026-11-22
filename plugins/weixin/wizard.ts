import type { ImWizardContext, ImWizardParams } from "../../packages/plugin-sdk";
import { defaultBase, getQr, qrStatus, replyCode, serviceUrl } from "./api";

export const pinPrompt = "输入手机上显示的数字";

export async function wizard({ config }: ImWizardParams, ctx: ImWizardContext) {
  const base = config.baseUrl || defaultBase;
  for (let refresh = 0; refresh <= 3; refresh++) {
    const qr = await getQr(base, ctx.signal);
    if (replyCode(qr) || !qr.qrcode || !qr.qrcode_img_content) throw new Error("微信未返回绑定二维码");
    ctx.qr(qr.qrcode_img_content, "用手机微信扫码");
    let pollBase = base, pin = "", previous = "";
    while (!ctx.signal.aborted) {
      const reply = await qrStatus(pollBase, qr.qrcode, pin, ctx.signal);
      const status = reply.status;
      if (replyCode(reply) && !status) throw new Error("微信扫码状态查询失败");
      if (status === "expired" || status === "verify_code_blocked") break;
      if (status?.includes("need_verifycode")) {
        do { pin = (await ctx.input(pinPrompt, { secret: false })).trim(); } while (!/^\d+$/.test(pin));
      } else if (status === "scaned_but_redirect" && reply.redirect_host) {
        const next = serviceUrl(`https://${reply.redirect_host}`);
        if (next.pathname !== "/" || next.search || next.hash) throw new Error("微信返回的跳转地址无效");
        pollBase = next.origin;
      } else if (status === "confirmed") {
        if (!reply.bot_token || !reply.baseurl || !reply.ilink_bot_id) throw new Error("微信未返回完整的 Bot 凭据");
        serviceUrl(reply.baseurl);
        return { config: { token: reply.bot_token, baseUrl: reply.baseurl, accountId: reply.ilink_bot_id } };
      } else if (status === "binded_redirect") {
        throw new Error("这个微信已经绑定过 Bot，没有新的凭据");
      } else if (status === "wait" || status === "scaned") {
        if (status === "scaned") pin = "";
        if (previous !== status) ctx.waiting(status === "wait" ? "等待扫码" : "已扫码，请在手机上确认");
        await Bun.sleep(200);
      } else {
        throw new Error("微信返回未知扫码状态");
      }
      previous = status;
    }
    ctx.signal.throwIfAborted();
  }
  throw new Error("二维码过期太多次，请重新运行 rh bot");
}
