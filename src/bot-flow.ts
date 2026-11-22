// The bot-making flow, in rhodium (product §5.11, architecture §8.5.1). rh bot at your terminal and the
// board's wizard each start one and show its state; this does the rest, once for both: the scan (QQ,
// Feishu), a new QR code when one expires, the check of what you paste (Telegram's getMe, Feishu's
// tenant token), writing the bot in through the router, as rh bot did, and its pairing code. A flow
// lives in memory alone: a restart drops one unfinished. Credentials stay in memory only till the
// config has them: never in a reply, an event, a log line or the database. An IM plugin that declares
// the wizard runs its own steps (spec plugins §3.6, pluginWizard below); the rest is the same.
import type * as Lark from "@larksuiteoapi/node-sdk";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { readJsonLines, writeJsonLine } from "@rhodium-oss/plugin-sdk";
import { Api } from "grammy";
import type { RhCaller } from "./contracts";
import { amid, platformLabel, type Made } from "./platforms";
import type { LoadedPlugin } from "./plugin-loader";
import type { RhReply } from "./router";
import type { Store } from "./store";

export type FlowState = "scan" | "paste" | "checking" | "writing" | "pairing" | "done" | "failed" | "cancelled";
const ENDED: FlowState[] = ["done", "failed", "cancelled"];
/** What rh bot shows at the terminal, in order: a line, or a QR code to draw. */
export type Said = { text: string } | { qr: string };
/** A flow as rh and the board see it. scan: url, the QR code's link; svg, it as a picture; expires,
 *  when it does, where the platform says (Feishu). paste: error, why the last paste was turned down.
 *  failed: error, why. pairing: the code and when it stops working. pairing, done: target, the slot the
 *  bot was bound to. log: what rh bot shows; the board leaves it out. prompt: what a plugin's wizard
 *  asks for in paste, and whether it is secret. platform: a built-in one, or an IM plugin's id. */
export type FlowView = {
  id: string;
  name: string;
  platform: string;
  state: FlowState;
  url?: string;
  svg?: string;
  expires?: number;
  error?: string;
  code?: string;
  until?: number;
  target?: string;
  prompt?: { label: string; secret: boolean };
  statusText?: string;
  log: Said[];
};

/** How a scan or check tells the flow what it does: say, a line for the terminal; qr, a QR code to
 *  scan, which expires at expires (ms) where the platform says; input, a line a plugin's wizard waits
 *  for. signal: the flow was cancelled. */
export type Tell = { say(text: string): void; qr(url: string, expires?: number): void; input?(label: string, secret: boolean): Promise<string>; progress?(text: string, url?: string): void; signal: AbortSignal };

/** A plugin platform's wizard, run for the bot name; what it gives is written as a scan's credentials. */
export type PluginWizard = (platform: string, name: string, tell: Tell) => Promise<Record<string, string>>;

/** How a platform's credentials are had (apiRoot: --api-root): by a scan, or by checking what was
 *  pasted; then what is said once the bot is in. afterPaste: what to set up, said before the pairing
 *  code, for a bot whose credentials were pasted. */
type Onboard = {
  scan?(apiRoot: string | undefined, tell: Tell): Promise<Record<string, string>>;
  check?(pasted: Record<string, string>, apiRoot: string | undefined, tell: Tell): Promise<Record<string, string>>;
  afterPaste?: string;
  done?(credentials: Record<string, string>, apiRoot: string | undefined, tell: Tell): Promise<void>;
};

const FEISHU_SETUP = [
  "在开发者后台给这个应用做完这几步，再私聊 Bot 发配对码：",
  "1. 添加机器人能力。",
  "2. 事件与回调：订阅方式选长连接；加事件“接收消息”（im.message.receive_v1）；加回调“卡片回传交互”（card.action.trigger）。",
  "3. 发布一个版本。",
].join("\n");

export const ONBOARD: Record<Made, Onboard> = {
  qq: { scan: (_, tell) => scan(tell) },
  telegram: { check: telegramCheck },
  feishu: {
    scan: feishuScan,
    check: feishuCheck,
    afterPaste: FEISHU_SETUP,
    async done(credentials, apiRoot, tell) {
      if (await readsYou(credentials, apiRoot)) return;
      tell.say("看板要显示你的飞书头像和名字，还要在开发者后台给这个应用加权限“获取用户基本信息”（contact:user.base:readonly），再发布一个版本。");
    },
  },
};

/** One rh call to the main loop, as caller made it; credentials: what a scan or paste gave. */
export type AskLoop = (caller: RhCaller, argv: string[], credentials?: Record<string, string>) => Promise<RhReply>;

const NO_FLOW: RhReply = { ok: false, error: "没有这个建 Bot 的流程：它结束很久了，或 rhodium 重启过。" };
// ponytail: fixed spans; settings if they turn out too short or too long.
const UNFINISHED = 30 * 60_000; // a flow not written in by then is dropped, as one whose page closed without a word would scan on
const KEPT = 10 * 60_000; // an ended flow is kept this long, for a page or rh to read how it ended

type Flow = { view: FlowView; caller: RhCaller; argv: string[]; apiRoot?: string; paste: boolean; abort: AbortController; unwatch?: () => void; answer?: (value: string) => void };

/** The flows rhodium runs. ask: the main loop, which checks and writes the bot as rh bot's call; store:
 *  the bot's pairing code and its bot_paired event; target: the slot a bot in the config is bound to. */
export function botFlows(ask: AskLoop, store: Store, target: (bot: string) => string | undefined, wizard?: PluginWizard) {
  const flows = new Map<string, Flow>();
  const watchers = new Set<(id: string) => void>();
  const changed = (f: Flow) => watchers.forEach((w) => w(f.view.id));
  const set = (f: Flow, patch: Partial<FlowView>) => {
    // A state's own fields go with it; the log stays.
    const { id, name, platform, log } = f.view;
    f.view = { id, name, platform, log, state: f.view.state, ...patch };
    changed(f);
  };
  const ended = (f: Flow) => ENDED.includes(f.view.state);
  const end = (f: Flow, state: FlowState, error?: string) => {
    if (ended(f)) return;
    f.abort.abort();
    f.unwatch?.();
    set(f, { ...(state === "done" && { target: f.view.target }), state, ...(error !== undefined && { error }) });
    setTimeout(() => flows.delete(f.view.id), KEPT);
  };
  const tell = (f: Flow): Tell => ({
    say(text) {
      if (f.abort.signal.aborted) return;
      f.view.log.push({ text });
      changed(f);
    },
    qr(url, expires) {
      if (f.abort.signal.aborted) return;
      f.view.log.push({ qr: url });
      set(f, { state: "scan", url, svg: qrSvg(url), ...(expires !== undefined && { expires }) });
    },
    progress(text, url) {
      if (f.abort.signal.aborted) return;
      f.view.statusText = text;
      if (url) f.view.url = url;
      if (f.view.state === "checking") f.view.state = "scan";
      changed(f);
    },
    input(label, secret) {
      return new Promise((resolve) => {
        if (f.abort.signal.aborted) return;
        f.answer = resolve;
        set(f, { state: "paste", prompt: { label, secret } });
      });
    },
    signal: f.abort.signal,
  });

  /** The bot written in with credentials, then its pairing code where it has no owner yet. Throws why not. */
  async function finish(f: Flow, credentials: Record<string, string>): Promise<void> {
    if (f.abort.signal.aborted) return; // cancelled meanwhile: nothing is written
    const { name, platform } = f.view;
    const t = tell(f);
    set(f, { state: "writing" });
    const added = await ask(f.caller, ["bot", ...f.argv], credentials);
    if (!added.ok) throw new Error(added.error);
    if (ended(f)) return; // cancelled as it was written: no pairing code
    t.say(added.text);
    const bound = target(name);
    let pairing: Partial<FlowView> | undefined;
    const onboard = Object.hasOwn(ONBOARD, platform) ? ONBOARD[platform as Made] : undefined;
    if (credentials.owner) t.say(`扫码的${amid(platformLabel(platform))}账号已记为你，Bot ${name} 不用再配对。`);
    else {
      // Only now: Feishu's console saves the long connection only once a program holds one.
      const setup = f.paste && onboard?.afterPaste;
      if (setup) t.say(setup);
      const after = store.lastSeq();
      const pair = await ask(f.caller, ["pair", name]);
      if (!pair.ok) throw new Error(pair.error);
      t.say(pair.text);
      const row = store.tx((tx) => tx.find("bot", { name })[0]);
      pairing = { state: "pairing", code: row?.pairCode ?? undefined, until: row?.pairUntil ?? undefined, target: bound };
      // Done once you send the code; dropped once it no longer works.
      const off = store.subscribe(after, (e) => {
        if (e.type === "bot_paired" && (e.data as { bot?: string })?.bot === name) end(f, "done");
      });
      const timer = setTimeout(() => end(f, "failed", "配对码过期了。"), Math.max(0, (row?.pairUntil ?? 0) - Date.now()));
      f.unwatch = () => (off(), clearTimeout(timer));
    }
    await onboard?.done?.(credentials, f.apiRoot, t);
    if (ended(f)) return;
    // Last, so rh has every line before it sees the flow through.
    f.view.target = bound;
    if (pairing) set(f, pairing);
    else end(f, "done");
  }

  return {
    /** Tells watch each flow's id as its state changes (the board's bot_flow). */
    watch: (w: (id: string) => void) => watchers.add(w),

    /** Starts a flow for rh bot's arguments, checked as rh bot's are first: the reply's text is what
     *  the router says to them. caller: who asked, whose rh calls the flow makes. */
    async start(argv: string[], caller: RhCaller): Promise<RhReply> {
      // Else the router would take it as rh bot rm and take a bot out.
      if (argv[0] === "rm") return { ok: false, error: "Bot 不能叫 rm：rh bot rm 是去掉 Bot 用的。" };
      const first = await ask(caller, ["bot", ...argv]);
      if (!first.ok) return first;
      const { values, positionals } = parseArgs({ args: argv, options: { "api-root": { type: "string" }, paste: { type: "boolean" } }, allowPositionals: true });
      // The router took them: a name and a platform rh bot makes, built in or a plugin's with a wizard.
      const [name, platform] = positionals as [string, string];
      if ([...flows.values()].some((f) => f.view.name === name && !ended(f))) return { ok: false, error: `Bot ${name} 正在建：同一个名字同时只能建一个。` };
      const how: Onboard = Object.hasOwn(ONBOARD, platform) ? ONBOARD[platform as Made]
        : { scan: (_, t) => (wizard ? wizard(platform, name, t) : Promise.reject(new Error("这里不能跑插件的建 Bot 向导。"))) };
      const paste = !how.scan || values.paste === true;
      const f: Flow = { view: { id: crypto.randomUUID(), name, platform, state: paste ? "paste" : "scan", log: [] }, caller, argv, apiRoot: values["api-root"], paste, abort: new AbortController() };
      flows.set(f.view.id, f);
      setTimeout(() => ["scan", "paste", "checking"].includes(f.view.state) && end(f, "failed", "30 分钟内没有建完，这次作废了。"), UNFINISHED);
      if (!paste)
        void how
          .scan!(f.apiRoot, tell(f))
          .then((c) => finish(f, c))
          .catch((err) => !f.abort.signal.aborted && end(f, "failed", (err as Error).message));
      return { ok: true, text: first.text, flow: f.view };
    },

    get(id: string): RhReply {
      const f = flows.get(id);
      return f ? { ok: true, text: "", flow: f.view } : NO_FLOW;
    },

    /** What was pasted, checked; then the bot written in. Turned down, the flow waits for another paste. */
    async credentials(id: string, pasted: Record<string, string>): Promise<RhReply> {
      const f = flows.get(id);
      if (!f) return NO_FLOW;
      if (f.view.state !== "paste") return { ok: false, error: "这个流程现在不收粘贴的凭据。" };
      // A plugin's wizard waits for this one line: it goes on from there.
      const answer = f.answer;
      if (answer && typeof pasted.value !== "string") return { ok: false, error: "请填写向导要求的内容。" };
      set(f, { state: "checking" });
      if (answer) {
        f.answer = undefined;
        answer(pasted.value ?? "");
        return { ok: true, text: "", flow: f.view };
      }
      try {
        await finish(f, await ONBOARD[f.view.platform as Made].check!(pasted, f.apiRoot, tell(f)));
      } catch (err) {
        const error = (err as Error).message;
        if (!ended(f)) set(f, { state: "paste", error });
        return { ok: false, error };
      }
      return { ok: true, text: "", flow: f.view };
    },

    /** Cancels a flow not ended yet: nothing more is written. */
    cancel(id: string): RhReply {
      const f = flows.get(id);
      if (!f) return NO_FLOW;
      end(f, "cancelled");
      return { ok: true, text: "", flow: f.view };
    },
  };
}
export type BotFlows = ReturnType<typeof botFlows>;

const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string";

/** An IM plugin's bot wizard (spec plugins §3.6): the plugin is started for this alone and asked
 *  wizard; its steps go to tell, each input it asks for is tell's, and its done fields come back.
 *  Throws why not: no first step in handshakeMs, its error, a step not understood, its exit before
 *  done, or the flow cancelled. Whichever way it ends, the plugin is asked to shut down, then TERM and
 *  KILL a stopGrace apart. What was typed and the done fields never go into a reason. */
export function pluginWizard(
  p: LoadedPlugin,
  o: { botName: string; config: Record<string, string>; env: Record<string, string>; handshakeMs: number; stopGrace: number },
  tell: Tell,
): Promise<Record<string, string>> {
  const [program, ...args] = p.command;
  const child = spawn(program!, args, { cwd: p.dir, windowsHide: true, env: { ...o.env, RHODIUM_PLUGIN_DIR: p.dir, PYTHONUTF8: "1" }, stdio: "pipe" });
  let err = "";
  child.stderr.on("data", (c) => (err = (err + c).slice(-8192)));
  child.stdin.on("error", () => {});
  const exited = new Promise<number | null>((resolve) => child.once("close", (code) => resolve(code)));
  child.once("error", () => {}); // close follows, as an exit before done
  const typed: string[] = [];
  const redact = (text: string) => {
    for (const v of [...typed, ...Object.values(o.config)].sort((a, b) => b.length - a.length)) if (v) text = text.replaceAll(v, "[redacted]");
    return text.slice(0, 500);
  };
  const write = (m: object) => {
    try {
      writeJsonLine(child.stdin, { jsonrpc: "2.0", ...m });
    } catch {} // gone: its close says so
  };
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    write({ id: 2, method: "shutdown", params: {} });
    child.stdin.end();
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      if (await Promise.race([exited.then(() => true), Bun.sleep(o.stopGrace).then(() => false)])) return;
      child.kill(signal);
    }
  };
  const its = `插件 ${p.id} 的向导`;
  return new Promise((resolve, reject) => {
    let over = false;
    const end = (e: Error | undefined, config?: Record<string, string>) => {
      if (over) return;
      over = true;
      clearTimeout(first);
      tell.signal.removeEventListener("abort", cancelled);
      void stop();
      if (e) reject(e);
      else resolve(config!);
    };
    const first = setTimeout(() => end(new Error(`${its}没有响应。`)), o.handshakeMs);
    const cancelled = () => end(new Error("已取消。"));
    tell.signal.addEventListener("abort", cancelled, { once: true });
    const bad = () => end(new Error(`${its}报了看不懂的一步。`));
    const onMessage = (m: unknown) => {
      if (over) return;
      if (!object(m)) return bad();
      const v = m.params;
      if (m.method === "wizard_step") {
        if (!object(v) || !(v.text === undefined || str(v.text))) return bad();
        if (v.kind === "qr" && str(v.data)) {
          tell.qr(v.data);
          if (v.text) tell.say(v.text);
          if (v.text) tell.progress?.(v.text);
        } else if (v.kind === "link" && str(v.url)) {
          tell.say(v.text ? `${v.text}：${v.url}` : v.url);
          tell.progress?.(v.text || "打开链接完成绑定", v.url);
        } else if (v.kind === "waiting" && str(v.text)) {
          tell.say(v.text);
          tell.progress?.(v.text);
        }
        else return bad();
        clearTimeout(first);
      } else if (m.method === "wizard_input") {
        if ((!str(m.id) && typeof m.id !== "number") || !object(v) || !str(v.label) || !(v.secret === undefined || typeof v.secret === "boolean")) return bad();
        clearTimeout(first); // from here on, only the flow's 30 minutes: you may take your time
        if (!tell.input) return bad();
        void tell.input(v.label, v.secret === true).then((value) => {
          typed.push(value);
          write({ id: m.id, result: { value } });
        });
      } else if (m.method !== undefined) {
        if (m.id !== undefined) write({ id: m.id, error: { code: -32601, message: `Method not found: ${String(m.method)}` } });
      } else if (m.id === 1) {
        const r = m.result;
        if ("error" in m) return end(new Error(redact(object(m.error) && str(m.error.message) && m.error.message ? m.error.message : `${its}出错了。`)));
        if (!object(r) || !object(r.config) || !Object.values(r.config).every(str) || !(r.text === undefined || str(r.text))) return bad();
        if (r.text) tell.say(r.text);
        end(undefined, { ...(r.config as Record<string, string>) });
      }
    };
    const reading = readJsonLines(child.stdout, { onMessage, onError: bad }).catch(bad);
    void exited.then(async (code) => {
      await reading; // its last lines first: an error it answered before exiting is its reason
      const last = redact(err.trim().split(/\r?\n/).at(-1) ?? "");
      end(new Error(`${its}中途退出（退出码 ${code}）${last ? `：${last}` : ""}`));
    });
    write({ id: 1, method: "wizard", params: { proto: 1, botName: o.botName, config: o.config } });
  });
}

/** text's QR code as an SVG picture, drawn by the encoder qrcode-terminal draws rh's with: a dark
 *  square per dark module, in a light border 4 modules wide. */
export function qrSvg(text: string): string {
  type Code = { addData(t: string): void; make(): void; getModuleCount(): number; modules: boolean[][] };
  const QRCode = require("qrcode-terminal/vendor/QRCode") as new (type: number, level: number) => Code;
  const { L } = require("qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel") as { L: number };
  const qr = new QRCode(-1, L);
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  let d = "";
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.modules[y]![x]) d += `M${x + 4} ${y + 4}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + 8} ${n + 8}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

// QQ's QR flow is ported from src/qqbot_agent_sdk/onboard.py of Tencent's qqbot-agent-sdk
// (github.com/tencent-connect/qqbot-agent-sdk, commit 6163b5d), under this notice:
//
// MIT License
//
// Copyright (c) 2025 walli
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

/** One call to QQ's QR service: its data, or an error with its reason. A try with no answer in 10 s
 *  (offline, timed out, not JSON) is tried again 2 s later; the fifth in a row gives up, saying
 *  "连不上 QQ 的扫码服务。" (with the HTTP status if the last try got a page) and then what else. */
async function qqPortal(path: string, body: object, giveUp = ""): Promise<any> {
  for (let tries = 1; ; tries++) {
    const res = await fetch(`https://q.qq.com/lite/${path}`, {
      method: "POST",
      // Without Accept, q.qq.com answers with a page that checks for bots.
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined);
    // A whole page that is not JSON (a 404, a gateway's 502) is asked again too, but QQ did answer: keep its status.
    let status = "";
    const answer = await res?.json().catch((e: unknown) => {
      if (e instanceof SyntaxError) status = `（HTTP ${res.status}）`;
    });
    if (answer?.retcode === 0) return answer.data ?? {};
    if (answer) throw new Error(`QQ 的扫码服务出错：${answer.msg ?? `HTTP ${res!.status}`}`);
    if (tries === 5) throw new Error(`连不上 QQ 的扫码服务${status}。${giveUp}`);
    await Bun.sleep(2000);
  }
}

/** QQ's QR flow, as qq-cli's `qq init --qr`: QQ makes the bot under a bind task, polled every 2 s
 *  until it is done, a new one when it expires. The secret comes sealed with a key only rhodium has
 *  (AES-256-GCM: IV, ciphertext, tag). The scanner's openid, when QQ gives it, is you under the bot. */
async function scan(tell: Tell): Promise<Record<string, string>> {
  const cancelled = () => {
    if (tell.signal.aborted) throw new Error("已取消。");
  };
  for (;;) {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const task: unknown = (await qqPortal("create_bind_task", { key: Buffer.from(key).toString("base64") })).task_id;
    cancelled();
    if (!task) throw new Error("QQ 的扫码服务没有给二维码。");
    const url = `https://q.qq.com/qqbot/openclaw/connect.html?task_id=${encodeURIComponent(String(task))}&_wv=2`;
    tell.qr(url);
    // The page lists your bots too: one marked 在线 is in use elsewhere, and QQ moves it here if picked.
    tell.say(`用手机 QQ 扫上面的二维码，点“创建新机器人”建一个新的（或在 QQ 里打开这个链接）：${url}\n标“在线”的 Bot 别选：它正被别的服务用着，选了会从那边断开。`);
    let bound: any;
    // 1: not scanned yet, 2: done, 3: expired.
    const poll = () => qqPortal("poll_bind_result", { task_id: task }, "扫了码的话，QQ 那边可能已经建好了 Bot，去 QQ 开放平台（q.qq.com）看看。");
    while (![2, 3].includes((bound = await poll()).status)) {
      cancelled();
      await Bun.sleep(2000);
    }
    cancelled();
    if (bound.status === 3) {
      tell.say("二维码过期了，正在换一个……");
      continue;
    }
    const appId = String(bound.bot_appid ?? "");
    const sealed = Buffer.from(String(bound.bot_encrypt_secret ?? ""), "base64");
    const aes = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["decrypt"]);
    const secret = await crypto.subtle.decrypt({ name: "AES-GCM", iv: sealed.subarray(0, 12) }, aes, sealed.subarray(12)).then(
      (s) => new TextDecoder().decode(s),
      () => "",
    );
    if (!appId || !secret) throw new Error("扫码没有拿到 Bot 的 AppID 和 AppSecret。");
    tell.say(`扫码成功：AppID ${appId}。`);
    return { appId, secret, ...(bound.user_openid && { owner: String(bound.user_openid) }) };
  }
}

/** Telegram: the token as pasted, once getMe takes it. */
async function telegramCheck({ token }: Record<string, string>, apiRoot: string | undefined, tell: Tell): Promise<Record<string, string>> {
  if (!token) throw new Error("没有粘贴 token。");
  try {
    const me = await new Api(token, apiRoot === undefined ? {} : { apiRoot }).getMe();
    tell.say(`token 有效：@${me.username}`);
  } catch (err) {
    // grammY leaves the token out of its errors; this makes sure of it.
    throw new Error(`Telegram 不认这个 token：${String((err as Error).message).replaceAll(token, "<token>")}`);
  }
  return { token };
}

/** Feishu's SDK, its calls given up after 30 s, as the Feishu adapter's (feishu.ts): unset, they have none. */
async function lark(): Promise<typeof Lark> {
  const sdk = await import("@larksuiteoapi/node-sdk");
  sdk.defaultHttpInstance.defaults.timeout = 30_000;
  return sdk;
}

/** One GET to Feishu's open platform as the app, or with no url only its access token: Feishu's
 *  answer, or an error with its reason and never the secret. The SDK logs nothing: its errors hold
 *  the request, secret and all. */
async function feishuGet(c: Record<string, string>, apiRoot: string | undefined, url?: string): Promise<any> {
  const sdk = await lark();
  const quiet = () => {};
  const logger = { error: quiet, warn: quiet, info: quiet, debug: quiet, trace: quiet };
  // No cache: the SDK's own keeps a token by App ID alone for the whole process, so a running bot or
  // an earlier check would let a wrong secret through.
  const cache = { get: async () => undefined, set: async () => true };
  const client = new sdk.Client({ appId: c.appId!, appSecret: c.secret!, domain: apiRoot ?? sdk.Domain.Feishu, logger, cache });
  const call = url === undefined ? client.tokenManager.getTenantAccessToken().then(() => ({ code: 0 })) : client.request({ method: "GET", url });
  const answer = await call.catch((e: any) => e?.response?.data ?? { msg: String(e?.message ?? e) });
  if (answer?.code !== 0) throw new Error(`${answer?.code ?? ""} ${answer?.msg ?? ""}`.trim().replaceAll(c.secret!, "<secret>"));
  return answer;
}

/** Whether the app may read your name and avatar; a list that can't be had is a no. */
const readsYou = (c: Record<string, string>, apiRoot: string | undefined): Promise<boolean> =>
  feishuGet(c, apiRoot, "/open-apis/application/v6/scopes").then(
    (a) => a.data?.scopes?.some((s: any) => s.scope_name === "contact:user.base:readonly" && s.grant_status === 1) === true,
    () => false,
  );

/** Feishu's scan (registerApp), with nothing added to the app: with more, a scan on 2026-10-26 made
 *  the app and gave no credentials (spec "rh bot"). A link that expires gives way to a new one. The
 *  scanner is you, unless it is the bot itself. apiRoot: the scan goes there too. */
async function feishuScan(apiRoot: string | undefined, tell: Tell): Promise<Record<string, string>> {
  const sdk = await lark();
  // ponytail: one rewrite for the whole SDK while it scans; two scans at once with different api roots (tests only) would mix.
  const rewrite =
    apiRoot === undefined ? undefined : sdk.defaultHttpInstance.interceptors.request.use((c) => ((c.url = c.url?.replace(/^https:\/\/accounts\.(feishu\.cn|larksuite\.com)/, apiRoot)), c));
  try {
    tell.say("页面上可以新建应用，也可以选已有的。选已有的，先停掉正连着它的程序：一个应用连着两处时，每条消息只随机推给其中一处。");
    let app: Awaited<ReturnType<typeof Lark.registerApp>> | undefined;
    while (!app) {
      app = await sdk
        .registerApp({
          source: "rhodium",
          signal: tell.signal,
          onQRCodeReady: ({ url, expireIn }) => {
            const within = expireIn % 3600 ? `${Math.round(expireIn / 60)} 分钟` : `${expireIn / 3600} 小时`;
            tell.say(`用飞书扫下面的二维码，或在手机上点这个链接（${within}内有效）：\n${url}`);
            tell.qr(url, Date.now() + expireIn * 1000);
          },
        })
        .catch((e) => {
          if (tell.signal.aborted) throw new Error("已取消。");
          if (e?.code !== "expired_token") throw new Error(`扫码没有建成应用：${e?.description ?? e?.message ?? e}`);
          tell.say("链接过期了，正在换一个……");
          return undefined;
        });
    }
    if (app.user_info?.tenant_brand === "lark") throw new Error("暂不支持 Lark（飞书国际版）。刚建的应用在 Lark 的开发者后台，用不着可以删掉。");
    tell.say(`扫码成功：App ID ${app.client_id}。`);
    const c = { appId: app.client_id, secret: app.client_secret };
    const bot = await feishuGet(c, apiRoot, "/open-apis/bot/v3/info").catch((e) =>
      tell.say(`问不到这个应用的 Bot 信息（${e.message}），认不出扫码的是你还是 Bot 自己，改用配对码。`),
    );
    const scanner = app.user_info?.open_id;
    return { ...c, ...(bot && scanner && scanner !== bot.bot?.open_id && { owner: scanner }) };
  } finally {
    if (rewrite !== undefined) sdk.defaultHttpInstance.interceptors.request.eject(rewrite);
  }
}

/** The App ID and secret of an app made in Feishu's console, as pasted, once Feishu gives an access
 *  token for them: its bot's info would need the bot, which comes only with the steps said after. */
async function feishuCheck({ appId, secret }: Record<string, string>, apiRoot: string | undefined, tell: Tell): Promise<Record<string, string>> {
  if (!appId || !secret) throw new Error("没有粘贴 App ID 和密钥。");
  await feishuGet({ appId, secret }, apiRoot).catch((e) => Promise.reject(new Error(`飞书不认这组 App ID 和密钥：${e.message}`)));
  tell.say("App ID 和密钥有效。");
  return { appId, secret };
}
