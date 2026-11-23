// Package each team plugin as its own zip, installed by unzipping it into <config dir>/plugins/
// (docs/plugin-guide.md §4.2). Usage: bun scripts/plugin-package.ts <out-dir> [--check] [ids...]
// Every plugins/<id>/ with a plugin.json by default. Each zip holds one top folder <id>/ with
// dist/index.js (the plugin and the SDK in one file), plugin.json pointing at it, and what the
// plugin reads at run time: icon, README files, conformance.json, fixtures/ and mock-*.ts helpers,
// TypeScript bundled the same way. --check unzips each package into a fresh /tmp/rhodium-test-*
// and runs the conformance checker on it offline, with the `bun` on PATH running the plugin.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const args = Bun.argv.slice(2);
const check = args.includes("--check");
const [outArg, ...wanted] = args.filter((a) => a !== "--check");
if (!outArg) {
  console.error("usage: bun scripts/plugin-package.ts <out-dir> [--check] [ids...]");
  process.exit(2);
}
const out = resolve(outArg);
mkdirSync(out, { recursive: true });
const ids = wanted.length ? wanted : readdirSync(join(root, "plugins")).filter((id) => existsSync(join(root, "plugins", id, "plugin.json")));
// A build from a tree with uncommitted changes is marked -dirty, so its zip never passes for HEAD's.
const sha = run(["git", "rev-parse", "--short=12", "HEAD"], root).trim() + (run(["git", "status", "--porcelain"], root).trim() ? "-dirty" : "");

// The offline config each plugin's conformance run uses, as .github/workflows/ci.yml runs it.
// weixin talks to its mock server, which --check starts from the package.
const offline: Record<string, string[]> = {
  agy: ["--config", '{"fixture":"builtin"}'],
  dsh: ["--config", '{"fixture":"./fixtures/sample.jsonl"}', "--timeout", "20000"],
};

let failed = false;
for (const id of ids) {
  const src = join(root, "plugins", id);
  const manifest = await Bun.file(join(src, "plugin.json")).json();
  const stage = mkdtempSync(join(tmpdir(), "rhodium-test-pkg-"));
  try {
    const dir = join(stage, id);
    mkdirSync(dir);
    bundle(join(src, "index.ts"), join(dir, "dist", "index.js"));
    const command = ["bun", "run", "${PLUGIN_DIR}/dist/index.js"];
    writeFileSync(join(dir, "plugin.json"), JSON.stringify({ ...manifest, command, commandByPlatform: undefined }, null, 2) + "\n");
    for (const name of readdirSync(src)) {
      if (name === manifest.icon || name === "conformance.json" || /^README.*\.md$/.test(name)) cpSync(join(src, name), join(dir, name));
      else if (/^mock-.*\.ts$/.test(name)) bundle(join(src, name), join(dir, name.replace(/\.ts$/, ".js")));
    }
    const fixtures = join(src, "fixtures");
    if (existsSync(fixtures)) {
      for (const name of readdirSync(fixtures)) {
        const to = join(dir, "fixtures", name);
        if (name.endsWith(".ts")) bundle(join(fixtures, name), to.replace(/\.ts$/, ".js"));
        else cpSync(join(fixtures, name), to, { recursive: true });
      }
    }
    const zip = join(out, `rhodium-plugin-${id}-${manifest.version}-${sha}.zip`);
    rmSync(zip, { force: true });
    run(["zip", "-qr", zip, id], stage);
    console.log(zip);
    if (check && !(await checkZip(id, zip))) failed = true;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
process.exit(failed ? 1 : 0);

function bundle(entry: string, outfile: string) {
  run([process.execPath, "build", entry, "--target", "bun", "--outfile", outfile], root);
}

async function checkZip(id: string, zip: string): Promise<boolean> {
  const home = mkdtempSync(join(tmpdir(), "rhodium-test-pkg-check-"));
  let mock: Bun.Subprocess<"ignore", "pipe", "inherit"> | undefined;
  try {
    const plugins = join(home, "plugins");
    mkdirSync(plugins);
    run(["unzip", "-q", zip, "-d", plugins], home);
    const dir = join(plugins, id);
    let extra = offline[id] ?? [];
    const helper = readdirSync(dir).find((n) => /^mock-.*\.js$/.test(n));
    if (helper) {
      // Port 0 picks a free one; the helper prints its origin and seeds the state conformance.json expects.
      mock = Bun.spawn(["bun", join(dir, helper), "0", "--seed"], { cwd: home, stdout: "pipe", stderr: "inherit" });
      const origin = await firstLine(mock.stdout);
      extra = ["--config", JSON.stringify({ token: "mock-weixin-token", baseUrl: origin, cdnBaseUrl: `${origin}/c2c` })];
    }
    const child = Bun.spawn(["bun", join(root, "scripts", "plugin-conformance.ts"), "--manifest", join(dir, "plugin.json"), ...extra], {
      cwd: home, stdout: "inherit", stderr: "inherit",
    });
    const code = await child.exited;
    console.log(`${basename(zip)}: conformance ${code === 0 ? "passed" : `failed (${code})`}`);
    return code === 0;
  } finally {
    mock?.kill();
    rmSync(home, { recursive: true, force: true });
  }
}

async function firstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let text = "";
  while (!text.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  return text.split("\n", 1)[0]!.trim();
}

function run(cmd: string[], cwd: string): string {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "inherit" });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")} exited ${r.exitCode}`);
  return r.stdout.toString();
}
