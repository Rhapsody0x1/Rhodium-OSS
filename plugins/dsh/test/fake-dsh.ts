// 假 dsh:真实传输层(dsh-runtime)的测试对端,由测试生成的包装脚本以 bun 执行。
// 行为由包装脚本注入的环境变量控制:
//   FAKE_DSH_VERSION   --version 输出的版本(默认 0.2.2-rc.5)
//   FAKE_DSH_MODE      normal | error | crash | hang(默认 normal)
//   FAKE_DSH_PID_FILE  hang 模式下把一个子孙进程的 PID 写到这里,供测试验证整树被清理
//   FAKE_DSH_LOCK_FILE 模拟会话锁:prompt/resume 时占锁(写入自己的 PID),锁主进程还活着就拒绝;
//                      收到 SIGTERM 后 400ms 才退出(模拟刷持久化),退出时释放锁
// prompt 文本含 "need approval" 时先发 approval/request,等插件应答后再回复。

const version = process.env.FAKE_DSH_VERSION ?? "0.2.2-rc.5";
const mode = process.env.FAKE_DSH_MODE ?? "normal";
let sessionId: string | null = null; // 从 prompt/resume 请求里动态取,与插件选择的会话 ID 一致

if (process.argv[2] === "--version") {
  console.log("dsh " + version);
  process.exit(0);
}

if (process.env.FAKE_DSH_PID_FILE) {
  // 挂一个子孙进程:整树清理(taskkill /T)应当把它一并结束。
  const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
    stdin: "ignore", stdout: "ignore", stderr: "ignore",
  });
  await Bun.write(process.env.FAKE_DSH_PID_FILE, String(child.pid));
}

const lockFile = process.env.FAKE_DSH_LOCK_FILE;
if (lockFile) {
  const { rmSync } = await import("node:fs");
  process.on("SIGTERM", () => setTimeout(() => { rmSync(lockFile, { force: true }); process.exit(0); }, 400));
}

/** 占会话锁;别的活进程占着时返回 false。 */
async function takeLock(): Promise<boolean> {
  if (!lockFile) return true;
  const file = Bun.file(lockFile);
  if (await file.exists()) {
    const owner = Number((await file.text()).trim());
    if (owner !== process.pid) {
      try { process.kill(owner, 0); return false; } catch { /* 锁主已退出 */ }
    }
  }
  await Bun.write(lockFile, String(process.pid));
  return true;
}

const encoder = new TextEncoder();
const send = (frame: unknown): void => {
  process.stdout.write(encoder.encode(JSON.stringify(frame) + "\n"));
};
const status = (state: string): void => send({ jsonrpc: "2.0", method: "session.status", params: { sessionId, status: state } });
const event = (type: string, data: unknown): void => send({ jsonrpc: "2.0", method: "session.event", params: { sessionId, event: { type, data } } });

function lastText(frame: { params?: { contentBlocks?: { type?: string; text?: string }[] } }): string {
  const blocks = frame.params?.contentBlocks ?? [];
  return [...blocks].reverse().find((b) => b.type === "text")?.text ?? "";
}

let approvalPrompt: string | null = null;

function reply(text: string): void {
  event("assistant/message", {
    message: { role: "assistant", content: [{ type: "reasoning", text: "" }, { type: "text", text: "Echo: " + text }] },
  });
  status("idle");
}

async function handle(frame: { id?: string | number; method?: string; params?: any; result?: unknown }): Promise<void> {
  if (frame.id === "srv-approval" && frame.method === undefined && approvalPrompt !== null) {
    const text = approvalPrompt;
    approvalPrompt = null;
    reply(text);
    return;
  }
  if (frame.method === "initialize") {
    send({ jsonrpc: "2.0", id: frame.id, result: { serverInfo: { name: "deepseek-harness-sdk-runtime", version: "0.0.1" } } });
    return;
  }
  if (frame.method === "session/resume") {
    sessionId = String(frame.params?.sessionId ?? sessionId);
    if (!(await takeLock())) {
      send({ jsonrpc: "2.0", id: frame.id, error: { code: -32000, message: "session is locked by another process (fake)" } });
      return;
    }
    send({ jsonrpc: "2.0", id: frame.id, result: {} });
    return;
  }
  if (frame.method === "shutdown") {
    send({ jsonrpc: "2.0", id: frame.id, result: {} });
    process.exit(0);
  }
  if (frame.method === "session/query") {
    send({ jsonrpc: "2.0", id: frame.id, result: { kind: "command", execution: { beforeTokens: 100, afterTokens: 10 } } });
    return;
  }
  if (frame.method === "session/prompt") {
    sessionId = String(frame.params?.sessionId ?? sessionId);
    if (!(await takeLock())) {
      send({ jsonrpc: "2.0", id: frame.id, error: { code: -32000, message: "session is locked by another process (fake)" } });
      return;
    }
    send({ jsonrpc: "2.0", id: frame.id, result: { messageId: "fake-msg-" + String(frame.id) } });
    status("running");
    if (mode === "error") {
      event("turn/end", { reason: { kind: "error", error: { code: 401, message: "invalid api key (fake)" } } });
      status("idle");
    } else if (mode === "crash") {
      // running 之后直接死,不发 idle(审查意见 4 的场景);稍等一下让管道里的帧先送达
      setTimeout(() => process.exit(1), 150);
    } else if (mode === "hang") {
      // 永不 idle:测中断与进程树清理(审查意见 3)
    } else if (lastText(frame).includes("need approval")) {
      approvalPrompt = lastText(frame);
      send({ jsonrpc: "2.0", id: "srv-approval", method: "approval/request", params: { toolName: "delete_file", sessionId } });
    } else {
      reply(lastText(frame));
    }
  }
}

const decoder = new TextDecoder();
let buf = "";
for await (const chunk of Bun.stdin.stream()) {
  buf += decoder.decode(chunk, { stream: true });
  for (;;) {
    const nl = buf.indexOf("\n");
    if (nl < 0) break;
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) await handle(JSON.parse(line));
  }
}
