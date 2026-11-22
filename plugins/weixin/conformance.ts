import { resolve } from "node:path";
import { startMock } from "./mock-weixin-server";

const root = resolve(import.meta.dir, "../..");
const mock = startMock({ seed: true });
try {
  const child = Bun.spawn([process.execPath, "scripts/plugin-conformance.ts",
    "--manifest", "plugins/weixin/plugin.json", "--config", JSON.stringify(mock.config)], {
    cwd: root, stdout: "inherit", stderr: "inherit",
  });
  process.exitCode = await child.exited;
} finally {
  await mock.server.stop(true);
}
