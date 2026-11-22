// runImPlugin's bot wizard branch (spec plugins §3.6): a first wizard request runs plugin.wizard, never init.
import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { runImPlugin, type ImPlugin, type ImWizardContext } from "@rhodium-oss/plugin-sdk";

function run(plugin: ImPlugin) {
  const stdin = new PassThrough();
  let out = "";
  let exitCode: number | undefined;
  const done = runImPlugin(plugin, {
    stdin,
    stdout: { write: (c: string) => ((out += c), true) },
    stderr: { write: () => true },
    exit: (c) => void (exitCode = c),
    registerSignals: false,
  });
  const lines = () => out.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>);
  const write = (m: object) => stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
  const until = async (ok: () => boolean) => {
    for (const end = Date.now() + 2000; !ok(); await Bun.sleep(5)) if (Date.now() > end) throw new Error("timed out");
  };
  return { stdin, done, lines, write, until, exit: () => exitCode };
}

const base: ImPlugin = {
  init: async () => {
    throw new Error("init must not run");
  },
  send: async () => ({ status: "sent" }),
};

test("wizard never runs init: steps go out in order, input waits for the core's value, the result ends it with 0", async () => {
  let got: unknown;
  const r = run({
    ...base,
    async wizard(params, ctx) {
      got = params;
      ctx.qr("qr-data", "scan it");
      ctx.link("https://example.test/x");
      ctx.waiting("waiting for you");
      const value = await ctx.input("Token", { secret: true });
      return { config: { token: value }, text: "bound" };
    },
  });
  r.write({ id: 1, method: "wizard", params: { proto: 1, botName: "w", config: { a: "b" } } });
  await r.until(() => r.lines().some((m) => m.method === "wizard_input"));
  const steps = r.lines().filter((m) => m.method === "wizard_step").map((m) => m.params);
  expect(steps).toEqual([{ kind: "qr", data: "qr-data", text: "scan it" }, { kind: "link", url: "https://example.test/x" }, { kind: "waiting", text: "waiting for you" }]);
  const input = r.lines().find((m) => m.method === "wizard_input")!;
  expect(input.params).toEqual({ label: "Token", secret: true });
  expect(r.lines().some((m) => m.id === 1)).toBe(false); // still waiting for the value
  r.write({ id: input.id, result: { value: "tok" } });
  expect(await r.done).toBe(0);
  expect(r.exit()).toBe(0);
  expect(got).toEqual({ botName: "w", config: { a: "b" } });
  expect(r.lines().find((m) => m.id === 1)).toEqual({ jsonrpc: "2.0", id: 1, result: { config: { token: "tok" }, text: "bound" } });
});

test("shutdown during a wizard aborts its signal, is acknowledged and exits", async () => {
  let ctx!: ImWizardContext;
  const r = run({
    ...base,
    wizard: (_p, c) => {
      ctx = c;
      c.waiting("forever");
      return new Promise(() => {});
    },
  });
  r.write({ id: 1, method: "wizard", params: { proto: 1, botName: "w", config: {} } });
  await r.until(() => r.lines().some((m) => m.method === "wizard_step"));
  r.write({ id: 2, method: "shutdown", params: {} });
  expect(await r.done).toBe(0);
  expect(ctx.signal.aborted).toBe(true);
  expect(r.lines().find((m) => m.id === 2)?.result).toEqual({ ok: true });
  expect(r.lines().some((m) => m.id === 1)).toBe(false);
});

test("a plugin without wizard answers -32601; one whose wizard throws answers its error and exits non-zero", async () => {
  const none = run(base);
  none.write({ id: 1, method: "wizard", params: { proto: 1, botName: "w", config: {} } });
  expect(await none.done).not.toBe(0);
  expect(none.lines().find((m) => m.id === 1)?.error.code).toBe(-32601);

  const bad = run({ ...base, wizard: async () => Promise.reject(new Error("二维码过期太多次")) });
  bad.write({ id: 1, method: "wizard", params: { proto: 1, botName: "w", config: {} } });
  expect(await bad.done).not.toBe(0);
  expect(bad.lines().find((m) => m.id === 1)?.error.message).toBe("二维码过期太多次");
});

test("the manifest's wizard is an optional boolean on IM plugins only", async () => {
  const { validateManifest } = await import("@rhodium-oss/plugin-sdk");
  const im = JSON.parse(await Bun.file(new URL("../examples/plugins/local-im/plugin.json", import.meta.url)).text());
  const agent = JSON.parse(await Bun.file(new URL("../examples/plugins/echo-agent/plugin.json", import.meta.url)).text());
  expect(validateManifest({ ...im, wizard: true }).ok).toBe(true);
  expect(validateManifest({ ...im, wizard: "yes" })).toMatchObject({ ok: false, error: "wizard must be a boolean" });
  expect(validateManifest({ ...agent, wizard: true })).toMatchObject({ ok: false, error: "wizard is only valid for IM plugins" });
});

test("the conformance checker skips the wizard group for an IM plugin that does not declare it", async () => {
  const { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(await import("node:os").then((os) => os.tmpdir()), "rhodium-test-nowizard-"));
  try {
    const example = join(import.meta.dir, "../examples/plugins/local-im");
    cpSync(join(example, "conformance.json"), join(dir, "conformance.json"));
    const manifest = JSON.parse(readFileSync(join(example, "plugin.json"), "utf8"));
    delete manifest.wizard;
    delete manifest.icon;
    writeFileSync(join(dir, "plugin.json"), JSON.stringify({ ...manifest, command: ["bun", "run", join(example, "index.ts")] }));
    const proc = Bun.spawn(["bun", "scripts/plugin-conformance.ts", "--manifest", join(dir, "plugin.json")], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(code).toBe(0);
    expect(out.match(/^ok \d+ - /gm)).toHaveLength(7);
    expect(out).not.toContain("wizard");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
