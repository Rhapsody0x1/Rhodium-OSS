import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginTranscript } from "../src/plugin-transcript";
import { messagePage } from "../src/transcript";

test("a turn's named input starts its block even when taken follows turn_start", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rhodium-test-transcript-"));
  try {
    const file = join(dir, "conv.jsonl");
    const history = new PluginTranscript(file, "run");
    const input = (id: string) => ({ text: id, at: 1 });
    history.record({ type: "turn_start", input: "first" }, 1, false, input);
    history.record({ type: "taken", inputId: "first" }, 2, false, input);
    history.record({ type: "taken", inputId: "second" }, 3, false, input);
    history.record({ type: "text_delta", text: "response" }, 4, false, input);
    history.record({ type: "turn_end" }, 5, false, input);
    const { blocks } = await messagePage(file, 0, "forward", dir);
    expect(blocks.map((b) => b.kind)).toEqual(["user", "user", "assistant"]);
    expect(blocks[0]).toMatchObject({ text: "first", begins: { by: "you" } });
    expect(blocks[1]).toMatchObject({ text: "second", queued: true });
    expect(blocks[2]).toMatchObject({ text: "response" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
