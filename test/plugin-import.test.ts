// Importing an agent plugin's own conversations (spec plugins §3.5): rh import and the board's import
// dialog list what echo-agent finds in a folder of sample conversations, and an import writes the
// conversation's history at the start of the slot's managed transcript before the slot resumes it.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ImportableData, ImportPreviewData } from "../src/board";
import { claudeProjectDir } from "./fake-agent/fake-agent";
import { BOARD_LOGIN, newInstance, until, type Instance } from "./instance";

const ECHO = resolve(import.meta.dir, "../examples/plugins/echo-agent");
let rhodium: Instance;
afterEach(() => rhodium.cleanup());

type Sample = { id: string; dir: string; title: string; updatedAt: number; busy?: true; blocks?: object[] };
const HISTORY = [
  { kind: "user", text: "整理 README", at: 1_700_000_000_000 },
  { kind: "tool", id: "t1", name: "read_file", input: { path: "README.md" }, result: { text: "# Demo" } },
  { kind: "assistant", text: "已整理好了。" },
];

/** An instance with echo-agent (and echo2, a second copy) reading sample conversations, and broken, a
 *  plugin whose every query fails; started. Returns the project directory the samples are in. */
async function begin(): Promise<string> {
  rhodium = newInstance({ toml: "" });
  const at = (...p: string[]) => join(rhodium.dir, ...p);
  const proj = at("proj");
  for (const d of ["proj", "conv1", "conv2", "echo2", "broken"]) mkdirSync(at(d), { recursive: true });
  const sample = (folder: string, s: Sample) => writeFileSync(at(folder, `${s.id.replace(/\W/g, "_")}.json`), JSON.stringify(s));
  sample("conv1", { id: "conv_a1", dir: proj, title: "整理 README", updatedAt: 1_700_000_100_000, blocks: HISTORY });
  sample("conv1", { id: "busy_b2", dir: proj, title: "修登录页", updatedAt: 1_700_000_050_000, busy: true, blocks: HISTORY });
  sample("conv1", { id: "bad:id", dir: proj, title: "坏 ID", updatedAt: 1_700_000_000_000 });
  sample("conv2", { id: "conv_a9", dir: proj, title: "另一个", updatedAt: 1_700_000_000_000, blocks: HISTORY });
  const manifest = JSON.parse(readFileSync(join(ECHO, "plugin.json"), "utf8"));
  writeFileSync(at("echo2", "plugin.json"), JSON.stringify({ ...manifest, id: "echo2", program: "echo2", icon: undefined, command: ["bun", "run", join(ECHO, "index.ts")] }));
  writeFileSync(at("broken", "plugin.json"), JSON.stringify({ ...manifest, id: "broken", program: "broken", icon: undefined, command: [process.execPath, "${PLUGIN_DIR}/broken.js"] }));
  writeFileSync(at("broken", "broken.js"), `console.error("store locked"); process.exit(1);`);
  writeFileSync(
    at("config.toml"),
    readFileSync(at("config.toml"), "utf8") + "\n" +
      [
        `[plugins.echo-agent]`, `path = ${JSON.stringify(ECHO)}`, `[plugins.echo-agent.config]`, `conversations = ${JSON.stringify(at("conv1"))}`,
        `[plugins.echo2]`, `path = ${JSON.stringify(at("echo2"))}`, `[plugins.echo2.config]`, `conversations = ${JSON.stringify(at("conv2"))}`,
        `[plugins.broken]`, `path = ${JSON.stringify(at("broken"))}`,
      ].join("\n") + "\n",
  );
  return proj;
}

/** A Claude conversation on disk started in dir, copied from the recorded fixture. */
function claudeOnDisk(dir: string): string {
  const fixtures = join(import.meta.dir, "fixtures/transcripts/claude");
  const [file] = readdirSync(fixtures);
  const id = file!.replace(/\.jsonl$/, "").replace(/^[^_]*_/, "");
  const session = crypto.randomUUID();
  const text = readFileSync(join(fixtures, file!), "utf8").replace(/"cwd":"[^"]*"/g, `"cwd":${JSON.stringify(dir)}`).replaceAll(id, session);
  const into = join(rhodium.home, ".claude/projects", claudeProjectDir(dir));
  mkdirSync(into, { recursive: true });
  writeFileSync(join(into, `${session}.jsonl`), text);
  return session;
}

const imports = async (...args: string[]) => rhodium.rh(["import", ...args]);

test("rh import lists plugin conversations beside the built-in ones, marks busy ones, drops bad ids and names a failing plugin", async () => {
  const proj = await begin();
  const claude = claudeOnDisk(proj);
  await rhodium.start();
  const shown = await rhodium.ok("import", "--dir", proj);
  expect(shown).toContain(`rh import ${claude.slice(0, 8)}  claude`);
  expect(shown).toContain("rh import conv_a1  echo-agent");
  expect(shown).toContain("整理 README");
  expect(shown).toContain("rh import conv_a9  echo2");
  expect(shown).toMatch(/rh import busy_b2 .*正被别的进程使用/);
  expect(shown).not.toContain("bad:id");
  expect(shown).toContain("插件 broken 列不出对话：store locked");
}, 30_000);

test("rh import of a plugin conversation by id: ambiguity and busy are refused; an import seeds the history once and the slot resumes it", async () => {
  const proj = await begin();
  await rhodium.start();

  const ambiguous = await imports("conv_a");
  expect(ambiguous.code).toBe(1);
  expect(ambiguous.err).toContain("写长一点");
  const busy = await imports("busy_b2");
  expect(busy.err).toContain("对话 busy_b2 正被别的进程使用，先关掉它再导入");
  const none = await imports("nothing_here");
  expect(none.err).toContain("磁盘上没有对话 nothing_here");
  expect(none.err).toContain("store locked");

  expect(await rhodium.ok("import", "conv_a1", "--name", "imp")).toContain("已导入成 proj/imp");
  expect(await rhodium.ok("import", "--dir", proj)).not.toContain("conv_a1");
  const read = () => rhodium.ok("read", "proj/imp");
  const history = await read();
  expect(history).toContain("整理 README");
  expect(history).toContain("已整理好了。");

  await rhodium.ok("send", "proj/imp", "接着来");
  await until(async () => (await read()).includes("Echo: "), 15_000);
  const after = await read();
  expect(after.indexOf("已整理好了。")).toBeLessThan(after.indexOf("Echo: "));
  const hold = join(rhodium.dir, "state/hold");
  const journals = readdirSync(hold).map((d) => readFileSync(join(hold, d, "in.log"), "utf8"));
  expect(journals.some((j) => j.includes(`"resume":"conv_a1"`))).toBe(true);

  await rhodium.stop();
  await rhodium.start();
  const again = await read();
  expect(again.split("已整理好了。").length - 1).toBe(1);
  expect(again.split("Echo: ").length - 1).toBe(after.split("Echo: ").length - 1);
}, 60_000);

test("the board's import dialog lists and previews plugin conversations; a failing plugin answers 502", async () => {
  const proj = await begin();
  const daemon = await rhodium.start();
  const url = `http://${daemon.logs.find((l) => l.msg === "ready")!.board}`;
  const get = (path: string) => fetch(url + path, { headers: { "Tailscale-User-Login": BOARD_LOGIN, "sec-fetch-site": "same-origin" } });

  const listed = (await (await get(`/api/importable?agent=echo-agent&dir=${encodeURIComponent(proj)}`)).json()) as ImportableData;
  expect(listed.list.map((r) => r.session)).toEqual(["conv_a1", "busy_b2"]);
  expect(listed.list[0]).toMatchObject({ title: "整理 README", at: 1_700_000_100_000 });
  expect(listed.list[0]!.count).toBeUndefined();
  expect(listed.list[1]!.busy).toBe(true);
  const found = (await (await get(`/api/importable?agent=echo-agent&q=${encodeURIComponent("登录")}`)).json()) as ImportableData;
  expect(found.list.map((r) => r.session)).toEqual(["busy_b2"]);

  const preview = (await (await get(`/api/importable/messages?agent=echo-agent&session=conv_a1`)).json()) as ImportPreviewData;
  expect(preview.blocks.map((b) => [b.kind, b.text])).toEqual([
    ["user", "整理 README"],
    ["assistant", "已整理好了。"],
  ]);

  const failed = await get(`/api/importable?agent=broken&dir=${encodeURIComponent(proj)}`);
  expect(failed.status).toBe(502);
  expect(await failed.text()).toContain("store locked");
}, 30_000);
