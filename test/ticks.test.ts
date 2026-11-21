import { expect, test } from "bun:test";
import { exchanges } from "../web/src/exchanges";
import { ticksOf, visibleTicks } from "../web/src/ticks";
import type { Block } from "../web/src/data";

test("ticks follow the loaded main rows and pair your words with their reply", () => {
  const user = (at: string, text: string, more: Partial<Extract<Block, { kind: "user" }>> = {}): Block => ({ kind: "user", at, text, time: null, from: null, source: null, ...more });
  const answer = (at: string, text: string): Block => ({ kind: "assistant", at, text, time: null });
  const rows = exchanges([answer("0", "Earlier reply"), user("1", "First\nsecond"), answer("2", "Reply\ncontinues"),
    user("3", "Task", { sender: { slot: "w/b" }, begins: { by: "slot", yours: false } }), answer("4", "**Done**"),
    user("5", "Next", { begins: { by: "you", yours: true } }), user("6", "More", { queued: true }), answer("7", "Later")], false);
  expect(ticksOf(rows).map((t) => [t.at, t.text, t.reply, t.refs])).toEqual([
    ["1", "First\nsecond", "Reply\ncontinues", undefined], ["3", "Done", undefined, ["w/b"]], ["5", "Next", undefined, undefined], ["6", "More", "Later", undefined],
  ]);
  expect(ticksOf(exchanges([user("8", "Bound child", { sender: { slot: "w/b" }, begins: { by: "slot", yours: true } })], false))).toEqual([]);
});

test("dense ticks stay within seventy percent of the height around the current item", () => {
  expect(visibleTicks(10, 5, 300, false)).toEqual({ first: 0, count: 10, step: 9 });
  expect(visibleTicks(100, 50, 60, false)).toEqual({ first: 43, count: 14, step: 3 });
  expect(visibleTicks(100, 99, 60, false).first).toBe(86);
});
