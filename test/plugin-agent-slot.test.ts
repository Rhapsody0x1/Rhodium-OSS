import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { BoardData, MessagesData, SlotData } from "../src/board";
import { BOARD_LOGIN, newInstance, until } from "./instance";

test("a managed plugin turn, its tool and its answer survive reconnect without replaying history twice", async () => {
  const echoDir = resolve(import.meta.dir, "../examples/plugins/echo-agent");
  const rhodium = newInstance({
    bots: { q: { like: "qq", owner: "owner", target: "w/plug" } },
    toml: `[plugins.echo-agent]\npath = ${JSON.stringify(echoDir)}\n[plugins.echo-agent.config]\ndelayedSession = "true"\n`,
  });
  try {
    let daemon = await rhodium.start();
    await rhodium.slots("main");
    await rhodium.ok("new", "w/plug", "--agent", "echo-agent");
    const read = () => rhodium.ok("read", "w/plug");
    const send = (text: string) => rhodium.im.inject("q", { chat: "owner", sender: "owner", text });
    await send("列出当前目录并确认是否修改");
    await until(async () => (await rhodium.state("w/plug")) === "需要你", 5_000);
    expect(await read()).toContain("列出当前目录并确认是否修改");
    await rhodium.stop();
    daemon = await rhodium.start();
    const url = `http://${daemon.logs.find((l) => l.msg === "ready")!.board}`;
    const get = async <T>(path: string) => (await fetch(url + path, { headers: { "Tailscale-User-Login": BOARD_LOGIN } })).json() as Promise<T>;
    const board = await get<BoardData>("/api/board");
    const cards = Object.values(board.workspaces[0]!.groups).flat();
    const id = cards.find((s) => s.name === "plug")!.id;
    await send("允许");
    await until(async () => (await rhodium.state("w/plug")) === "空闲", 5_000);
    const { blocks } = await get<MessagesData>("/api/messages?slot=" + id);
    expect(blocks.map((b) => b.kind)).toEqual(["user", "tool", "assistant"]);
    expect(blocks[1]).toMatchObject({ result: { text: "allowed" } });
    expect(blocks[2]).toMatchObject({ text: expect.stringContaining("Echo:") });
    expect(await read()).toContain("Echo:");
    const detail = () => get<SlotData>("/api/slot?id=" + id);
    const session = (await detail()).timeline[0]!.short;
    expect(session).toBeTruthy();
    const journal = join(rhodium.dir, "state/hold", (await detail()).timeline[0]!.id, "in.log");
    await rhodium.ok("stop", "w/plug");
    await until(async () => (await rhodium.state("w/plug")) === "未运行");
    await send("second turn");
    await until(async () => (await read()).includes("Echo:") && (await rhodium.state("w/plug")) === "空闲");
    const after = await get<MessagesData>("/api/messages?slot=" + id);
    expect(after.blocks.map((b) => b.kind)).toEqual(["user", "tool", "assistant", "user", "tool", "assistant"]);
    expect((await detail()).timeline[0]!.short).toBe(session);
    expect(readFileSync(journal, "utf8")).toContain(`"resume":"${session}`);
    await rhodium.ok("send", "w/main", "hello builtin");
    await until(() => rhodium.claude.runs().length === 1);
  } finally {
    await rhodium.cleanup();
  }
}, 30_000);

test("after a plugin ignores interrupt the replacement process delivers the waiting user message", async () => {
  const rhodium = newInstance({
    bots: { q: { like: "qq", owner: "owner", target: "w/plug" } },
    toml: '[durations]\npluginInterrupt = "100ms"\nstopGrace = "100ms"\n[plugins.slow]\npath = "."',
  });
  const manifest = JSON.parse(readFileSync(resolve(import.meta.dir, "../examples/plugins/echo-agent/plugin.json"), "utf8"));
  writeFileSync(join(rhodium.dir, "plugin.json"), JSON.stringify({ ...manifest, id: "slow", command: [process.execPath, "${PLUGIN_DIR}/slow.js"] }));
  writeFileSync(join(rhodium.dir, "slow.js"), `
    import { createInterface } from "node:readline";
    const emit = (m) => console.log(JSON.stringify(m));
    for await (const line of createInterface({input: process.stdin})) {
      const m = JSON.parse(line);
      if (m.type === "init") emit({type: "ready", proto: 1, session: "slow-session"});
      if (m.type === "send") {
        emit({type: "taken", inputId: m.id});
        emit({type: "turn_start", input: m.id});
        if (m.text.includes("next")) emit({type: "turn_end", reply: "next delivered"});
      }
      if (m.type === "close") break;
    }
  `);
  try {
    await rhodium.start();
    await rhodium.slots("main");
    await rhodium.ok("new", "w/plug", "--agent", "slow");
    const send = (text: string) => rhodium.im.inject("q", { chat: "owner", sender: "owner", text });
    await send("first");
    await until(async () => (await rhodium.ok("read", "w/plug")).includes("first"));
    await send("!next");
    await until(async () => (await rhodium.im.log("q", "owner")).some((m) => m.text === "next delivered"), 8_000);
    expect(await rhodium.ok("read", "w/plug")).toContain("next delivered");
  } finally {
    await rhodium.cleanup();
  }
}, 20_000);

test("disabling a live plugin on restart closes its old holder and leaves its history readable", async () => {
  const dir = resolve(import.meta.dir, "../examples/plugins/echo-agent");
  const rhodium = newInstance({ toml: `[durations]\naskTimeout = "500ms"\n[plugins.echo-agent]\nenabled = true\npath = ${JSON.stringify(dir)}` });
  try {
    await rhodium.start();
    await rhodium.slots("main");
    await rhodium.ok("new", "w/plug", "--agent", "echo-agent");
    await rhodium.ok("send", "w/plug", "before disabling [ask]");
    await until(async () => (await rhodium.ok("read", "w/plug")).includes("Echo:"));
    const holds = join(rhodium.dir, "state/hold");
    const inputLog = readFileSync(join(holds, readdirSync(holds)[0]!, "in.log"), "utf8").trim().split("\n");
    const timedOut = inputLog.map((line) => JSON.parse(line.slice(line.indexOf(" ") + 1))).find((msg) => msg.type === "answer");
    expect(timedOut?.answer).toMatchObject({ kind: "permission", allow: false, message: "用户暂时无法回答，请按你的最佳判断继续" });
    await rhodium.stop();
    writeFileSync(rhodium.config, readFileSync(rhodium.config, "utf8").replace("[plugins.echo-agent]\nenabled = true", "[plugins.echo-agent]\nenabled = false"));
    await rhodium.start();
    await until(async () => !(await rhodium.units()).some((u) => u.includes("hold-")));
    expect(await rhodium.ok("read", "w/plug")).toContain("before disabling");
    expect((await rhodium.rh(["send", "w/plug", "again"])).err).toContain("已禁用");
  } finally {
    await rhodium.cleanup();
  }
}, 20_000);
