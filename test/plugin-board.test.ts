import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { BoardData, MessagesData, RhodiumData, SlotData } from "../src/board";
import { boardAct, BOARD_LOGIN, newInstance, until } from "./instance";

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
      expect(metadata?.agents.at(-1)).toMatchObject({ name: "Echo Agent", tui: false, importable: true, icon: "api/plugin-icon?id=echo-agent&v=0.1.0" });
      expect(metadata?.agents[0]).not.toHaveProperty("icon");
      expect(metadata?.platforms).toContainEqual({ id: "local-im", label: "Local IM", icon: "api/plugin-icon?id=local-im&v=0.1.0" });
      expect(metadata?.platforms.find(p => p.id === "qq")).not.toHaveProperty("icon");
      expect(metadata?.plugins).toContainEqual({ id: "offline", status: "disabled" });
      expect(metadata?.plugins).toContainEqual({ id: "broken", status: "failed", error: expect.stringContaining("missing-dir") });
      expect(JSON.stringify(metadata)).not.toContain("private-test-value");
    }
    const icon = await fetch(base + "/api/plugin-icon?id=echo-agent&v=0.1.0", { headers: { "Tailscale-User-Login": BOARD_LOGIN } });
    expect(icon.status).toBe(200);
    expect(icon.headers.get("content-type")).toBe("image/svg+xml");
    expect(icon.headers.get("x-content-type-options")).toBe("nosniff");
    expect(icon.headers.get("content-security-policy")).toBe("sandbox");
    expect(icon.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(await icon.text()).toBe(readFileSync(resolve(import.meta.dir, "../examples/plugins/echo-agent/icon.svg"), "utf8"));
    for (const id of ["nope", "offline", "broken", "claude"]) {
      expect((await fetch(base + "/api/plugin-icon?id=" + id, { headers: { "Tailscale-User-Login": BOARD_LOGIN } })).status).toBe(404);
    }
  } finally { await r.cleanup(); }
}, 20_000);

test("a plugin conversation keeps its IM badge with a shared label, disabled plugins and a replacement bot", async () => {
  let send = false;
  const platform = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/updates") return Response.json(send && !url.searchParams.get("cursor")
      ? { messages: [{ messageId: "one", sender: "owner", channel: "dm-99", at: Date.now(), text: "check the board" }], nextCursor: "1" }
      : { messages: [], nextCursor: url.searchParams.get("cursor") ?? "" });
    return Response.json({ status: "sent", messageId: "posted" });
  } });
  const example = (id: string) => JSON.stringify(resolve(import.meta.dir, "../examples/plugins", id));
  const alternate = '[plugins.other-im]\nenabled = true\npath = "alternate"';
  const r = newInstance({ toml: [alternate,
    "[plugins.echo-agent]", "enabled = true", 'path = "echo-fixture"', "[plugins.local-im]", "enabled = true", "path = " + example("local-im"),
    "[bots.local]", 'platform = "local-im"', 'owner = "owner"', 'target = "w/echo"', "endpoint = " + JSON.stringify(platform.url.origin),
  ].join("\n") });
  const im = resolve(import.meta.dir, "../examples/plugins/local-im");
  const sameLabel = { ...JSON.parse(readFileSync(resolve(im, "plugin.json"), "utf8")), id: "other-im", command: [process.execPath, resolve(im, "index.ts")] };
  mkdirSync(resolve(r.dir, "alternate"));
  writeFileSync(resolve(r.dir, "alternate/plugin.json"), JSON.stringify(sameLabel));
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
    const base = "http://" + daemon.logs.find(l => l.msg === "ready")!.board;
    const result = await (await boardAct(base, { kind: "common", slot: id, name: "status" })).json();
    expect(result.card.actions).toEqual(["/model", "/new"]);
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
    await r.stop();
    const config = readFileSync(r.config, "utf8").replaceAll("enabled = false", "enabled = true").replace(alternate, "")
      .replace('platform = "local-im"', 'platform = "fake"\nlike = "qq"\nsocket = ' + JSON.stringify(resolve(r.dir, "fake-im.sock")));
    writeFileSync(r.config, config);
    daemon = await r.start();
    const after = await get<MessagesData>("/api/messages?slot=" + id);
    expect(after.blocks[0]).toMatchObject({ source: "Local IM 私聊", from: { platform: "local-im", botAvatar: null, avatar: null } });
  } finally { await r.cleanup(); platform.stop(true); }
}, 20_000);
