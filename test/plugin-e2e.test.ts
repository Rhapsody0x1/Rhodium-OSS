import { expect, test } from "bun:test";
import { join } from "node:path";

test.skipIf(!process.env.RHODIUM_TEST_EXE)("the packaged daemon runs the account-free baseline and plugin comparison", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../demo/run.ts"), "--port", "0"], {
    env: { ...process.env, NODE_ENV: "test", RHODIUM_TEST_DETACHED: "1" },
    stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 100_000,
  });
  const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`Demo exited ${code}:\n${out}\n${error}`);
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
