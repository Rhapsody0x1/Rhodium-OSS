import { expect, test } from "bun:test";
import type { Block } from "../web/src/data";
import { exchanges, summary } from "../web/src/exchanges";

const user = (at: string, text: string, more: Partial<Extract<Block, { kind: "user" }>> = {}): Block => ({ kind: "user", at, time: 1, text, source: null, from: null, ...more });
const incoming = (at: string, text: string) => user(at, text, { begins: { by: "slot", yours: false }, sender: { slot: "w/b" } });
const reply = (at: string, text: string): Block => ({ kind: "assistant", at, time: 2, text });
const tool = (at: string, extra: Partial<Extract<Block, { kind: "tool" }>> = {}): Extract<Block, { kind: "tool" }> => ({
  kind: "tool", at, time: 2, id: at, name: "Bash", input: "{}", shown: { name: "Bash", arg: "", code: true },
  result: { at, time: 3, text: "ok", error: false }, ...extra,
});
const send = { to: "me", text: "进展", files: [], media: [] };
const out = { to: "w/c", text: "已收到", only: true as const };

test("internal turns merge until a sent message or the user's interruption", () => {
  const rows = exchanges([incoming("1", "查一下"), reply("2", "先读文件"), tool("3"), reply("4", "**完成**"), incoming("5", "再查"), tool("6", { send }), reply("7", "又好了"), incoming("7a", "再问"), user("8", "我来", { queued: true }), reply("9", "好的")], false);
  expect(rows.map((r) => r.kind)).toEqual(["exchange", "sent", "exchange", "main", "main"]);
  const first = rows[0]!;
  if (first.kind !== "exchange") throw Error();
  expect(first.groups.map((g) => g.map((i) => i.kind))).toEqual([["in", "fold", "assistant"], ["in", "fold", "assistant"]]);
  const fold = first.groups[0]![1]!;
  expect(fold.kind === "fold" && fold.steps.map((s) => s.kind)).toEqual(["assistant", "tool"]);
  expect(summary(first)).toMatchObject({ refs: ["w/b"], outgoing: false, text: "又好了" });
});

test("in your turn the calls stay and the exchanges follow the reply; a page prefix defaults to yours", () => {
  const inside = [tool("1", { out }), user("2", "收到", { queued: true, sender: { slot: "w/b" } }), reply("3", "答案")];
  const yours = exchanges(inside, false);
  expect(yours.map((r) => r.kind)).toEqual(["main", "main", "exchange"]);
  if (yours[2]?.kind !== "exchange") throw Error();
  expect(summary(yours[2])).toMatchObject({ refs: ["w/c", "w/b"], outgoing: false });
  const theirs = exchanges([incoming("0", "问"), ...inside], false);
  expect(theirs).toHaveLength(1);
  if (theirs[0]?.kind !== "exchange") throw Error();
  expect(theirs[0].groups[0]!.map((b) => b.kind)).toEqual(["in", "out", "in", "assistant"]);
  expect(summary(theirs[0]).text).toBe("答案");
});

test("failed and compound sends stay in the process; outgoing only uses both avatars", () => {
  const rows = exchanges([incoming("1", "问"), tool("2", { out, result: { at: "3", time: 2, error: true, text: "failed" } }), tool("4", { out: { ...out, only: undefined } })], false);
  if (rows[0]?.kind !== "exchange") throw Error();
  expect(rows[0].groups[0]!.map((b) => b.kind)).toEqual(["in", "fold", "out", "fold", "out"]);
  const after = exchanges([tool("1", { out })], false).at(-1)!;
  if (after.kind !== "exchange") throw Error();
  expect(summary(after)).toMatchObject({ outgoing: true, refs: ["w/c"] });
});

test("only the live turn supplies its activity and a delivered notification follows its still-running call", () => {
  const turns = [incoming("1", "旧任务"), reply("2", "旧小结"), incoming("3", "新任务")];
  const row = exchanges(turns, true)[0]!;
  if (row.kind !== "exchange") throw Error();
  expect(summary(row).text).toBe("新任务");
  const pending = exchanges([...turns, tool("4", { send, result: null })], true);
  expect(pending.map((r) => r.kind)).toEqual(["exchange", "sent"]);
  expect(pending[0]).toMatchObject({ live: true });
});
