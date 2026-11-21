import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { BoardData, MessagesData, RhodiumData, SlotData } from "../src/board";
import { BOARD_LOGIN, newInstance, until } from "./instance";

test("the board, slot and service report the selectable plugins and load failures without exposing bot config", async () => {
  const plugin = (id: string) => JSON.stringify(resolve(import.meta.dir, "../examples/plugins", id));
  const r = newInstance({ toml: [
    "[plugins.echo-agent]", "path = " + plugin("echo-agent"), "[plugins.local-im]", "path = " + plugin("local-im"),
    "[plugins.offline]", "enabled = false", "[plugins.broken]", 'path = "missing-dir"',
    "[bots.local]", 'platform = "local-im"', 'token = "private-test-value"',
  ].join("\n") });
  try {
    const daemon = await r.start();
    await r.slots("main");
    await r.ok("new", "w/echo", "--agent", "echo-agent");
    const base = "http://" + daemon.logs.find(l => l.msg === "ready")!.board;
    const get = async <T>(url: string) => (await fetch(base + url, { headers: { "Tailscale-User-Login": BOARD_LOGIN } })).json() as Promise<T>;
    const board = await get<BoardData>("/api/board");
    const id = board.workspaces.flatMap(w => Object.values(w.groups).flat()).find(s => s.name === "echo")!.id;
    for (const { metadata } of [board, await get<SlotData>("/api/slot?id=" + id), await get<RhodiumData>("/api/rhodium")]) {
      expect(metadata?.agents.map(a => a.id)).toEqual(["claude", "pi", "codex", "echo-agent"]);
      expect(metadata?.agents.at(-1)).toMatchObject({ name: "Echo Agent", tui: false, importable: false });
      expect(metadata?.platforms).toContainEqual({ id: "local-im", label: "Local IM" });
      expect(metadata?.plugins).toContainEqual({ id: "offline", status: "disabled" });
      expect(metadata?.plugins).toContainEqual({ id: "broken", status: "failed", error: expect.stringContaining("missing-dir") });
      expect(JSON.stringify(metadata)).not.toContain("private-test-value");
    }
  } finally { await r.cleanup(); }
}, 20_000);

test("a plugin conversation keeps its IM badge and transcript after disabling both plugins", async () => {
  let send = false;
  const platform = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/updates") return Response.json(send && !url.searchParams.get("cursor")
      ? { messages: [{ messageId: "one", sender: "owner", channel: "dm-99", at: Date.now(), text: "check the board" }], nextCursor: "1" }
      : { messages: [], nextCursor: url.searchParams.get("cursor") ?? "" });
    return Response.json({ status: "sent", messageId: "posted" });
  } });
  const example = (id: string) => JSON.stringify(resolve(import.meta.dir, "../examples/plugins", id));
  const r = newInstance({ toml: [
    "[plugins.echo-agent]", "enabled = true", 'path = "echo-fixture"', "[plugins.local-im]", "enabled = true", "path = " + example("local-im"),
    "[bots.local]", 'platform = "local-im"', 'owner = "owner"', 'target = "w/echo"', "endpoint = " + JSON.stringify(platform.url.origin),
  ].join("\n") });
  const echo = resolve(import.meta.dir, "../examples/plugins/echo-agent");
  const manifest = JSON.parse(readFileSync(resolve(echo, "plugin.json"), "utf8"));
  manifest.capabilities.commands.push("usage");
  manifest.command = [process.execPath, resolve(echo, "index.ts")];
  mkdirSync(resolve(r.dir, "echo-fixture"));
  writeFileSync(resolve(r.dir, "echo-fixture/plugin.json"), JSON.stringify(manifest));
  try {
    let daemon = await r.start();
    await r.slots("main");
    await r.ok("new", "w/echo", "--agent", "echo-agent");
    const get = async <T>(path: string): Promise<T> => (await fetch("http://" + daemon.logs.find(l => l.msg === "ready")!.board + path, { headers: { "Tailscale-User-Login": BOARD_LOGIN } })).json();
    const id = Object.values((await get<BoardData>("/api/board")).workspaces[0]!.groups).flat().find(s => s.name === "echo")!.id;
    const commands = async () => (await get<SlotData>("/api/slot?id=" + id)).commands.map(c => c.name);
    expect(await commands()).toContain("usage");
    send = true;
    await until(async () => (await r.ok("read", "w/echo")).includes("Echo:"));
    expect(await commands()).not.toContain("usage");
    for (const enabled of [true, false]) {
      if (!enabled) {
        await r.stop();
        writeFileSync(r.config, readFileSync(r.config, "utf8").replaceAll("enabled = true", "enabled = false"));
        daemon = await r.start();
      }
      const data = await get<MessagesData>("/api/messages?slot=" + id);
      expect(data.blocks[0]).toMatchObject({ kind: "user", text: "check the board", from: { platform: "local-im", bot: "local" } });
      expect(data.blocks.at(-1)).toMatchObject({ kind: "assistant", text: expect.stringContaining("check the board") });
    }
  } finally { await r.cleanup(); platform.stop(true); }
}, 20_000);
