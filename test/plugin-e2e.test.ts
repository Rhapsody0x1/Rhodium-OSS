import { expect, test } from "bun:test";
import { join } from "node:path";
import { until } from "./instance";

test.skipIf(!process.env.RHODIUM_TEST_EXE)("the packaged daemon runs the account-free baseline and plugin comparison", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../demo/run.ts"), "--port", "0", "--pause"], {
    env: { ...process.env, NODE_ENV: "test", RHODIUM_TEST_DETACHED: "1" },
    stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: 100_000,
  });
  let out = "";
  const err = new Response(child.stderr).text();
  const read = (async () => { for await (const text of child.stdout.pipeThrough(new TextDecoderStream())) out += text; })();
  const checkpoint = async (n: number) => {
    await until(() => child.exitCode !== null || out.split("then press Enter").length > n, 60_000);
    if (child.exitCode !== null) throw new Error(out + await err);
  };
  const next = async () => { child.stdin.write("\n"); await child.stdin.flush(); };
  await checkpoint(1);
  const board = /Board (http:\/\/127\.0\.0\.1:\d+)/.exec(out)![1]!;
  const act = async (action: object) => {
    const result = await (await fetch(board + "/api/act", { method: "POST", headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" },
      body: JSON.stringify({ id: crypto.randomUUID(), act: action }) })).json();
    if (!result.ok) throw new Error(result.error);
    return result;
  };
  let stopped = false;
  try {
    const { slot } = await act({ kind: "rh", argv: ["new", "course/extra"] });
    await act({ kind: "say", slot, text: "interactive demo input" });
    const detail = async () => (await (await fetch(board + "/api/slot?id=" + slot)).json());
    await until(async () => (await detail()).live, 15_000);
    await next();
    await checkpoint(2);
    const extra = await detail();
    stopped = extra.phase === "off" && !extra.live;
    if (!stopped) await act({ kind: "rh", argv: ["stop", slot] });
    await next();
    await checkpoint(3);
    await next();
  } finally { await child.stdin.end(); }
  const [code, error] = await Promise.all([child.exited, err, read]);
  if (code !== 0) throw new Error(`Demo exited ${code}:\n${out}\n${error}`);
  expect(stopped).toBe(true);
  expect(error).toBe("");
  expect(out).toContain("PASS baseline");
  expect(out).toContain("PASS plugin approval");
  expect(out).toContain("PASS failure isolation");
  expect(out).toContain("PASS same core SHA-256");
}, 110_000);

test.skipIf(process.platform !== "linux")("Linux detached mode needs both the test environment and the explicit switch", () => {
  for (const [mode, flag, expected] of [["production", "1", false], ["test", "0", false], ["test", "1", true]] as const) {
    const p = Bun.spawnSync([process.execPath, "-e", 'import { detached } from "./src/detached"; console.log(detached)'],
      { cwd: join(import.meta.dir, ".."), env: { ...process.env, NODE_ENV: mode, RHODIUM_TEST_DETACHED: flag } });
    expect([p.exitCode, p.stdout.toString().trim()]).toEqual([0, String(expected)]);
  }
});
