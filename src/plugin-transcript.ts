// A plugin's own session may be opaque; Rhodium stores its visible messages in the slot conversation's file.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentToCoreMessage, ImportBlock } from "@rhodium-oss/plugin-sdk";

export const managedFile = (stateDir: string, agent: string, conversation: string) =>
  join(stateDir, "transcripts", agent, conversation + ".jsonl");

/** Rows for one item, as record() writes it; tool: whether its tool_use row was already written. */
function itemRows(item: { kind: "message"; text: string } | { kind: "tool"; id: string; name: string; input: unknown; result?: { text: string; error?: boolean } }, toolSeen = false): object[] {
  const assistant = (content: unknown) => ({ type: "assistant", message: { role: "assistant", content } });
  if (item.kind === "message") return [assistant([{ type: "text", text: item.text }])];
  return [
    ...(toolSeen ? [] : [assistant([{ type: "tool_use", id: item.id, name: item.name, input: item.input }])]),
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: item.id, content: item.result?.text ?? "", is_error: item.result?.error ?? false }] } },
  ];
}

/** Writes an imported conversation's blocks at the start of its managed transcript (spec plugins §3.5),
 *  as record() writes items, keyed import:<n>; each at its own time, else now. */
export function seedImport(file: string, blocks: ImportBlock[], now: number): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const lines = blocks.flatMap((b, n) => {
    const k = "import:" + n;
    const timestamp = new Date(b.at ?? now).toISOString();
    const rows = b.kind === "user" ? [{ type: "user", message: { role: "user", content: b.text } }] : itemRows(b.kind === "assistant" ? { kind: "message", text: b.text } : { ...b, id: b.id ?? k });
    return rows.map((row, i) => JSON.stringify({ ...row, timestamp, k: i ? k + ":" + i : k }));
  });
  if (lines.length) appendFileSync(file, lines.join("\n") + "\n", { mode: 0o600 });
}

export class PluginTranscript {
  private readonly tools = new Set<string>();
  private inTurn = false;
  private startingInput?: string;
  private lastMessage = "";
  private delta = "";

  constructor(private readonly file: string, private readonly run: string) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  }

  record(m: AgentToCoreMessage, end: number, replay: boolean, input: (id: string) => { text: string; at: number } | null): void {
    const key = `out:${this.run}:${end}`;
    const rows: object[] = [];
    let k = key, at = Date.now();
    const assistant = (content: unknown) => rows.push({ type: "assistant", message: { role: "assistant", content } });
    switch (m.type) {
      case "taken": {
        const original = !replay && input(m.inputId);
        if (!original) return;
        k = "in:" + m.inputId;
        at = original.at;
        if (this.inTurn && m.inputId !== this.startingInput) rows.push({ type: "attachment", attachment: { type: "queued_command", source_uuid: m.inputId, prompt: original.text } });
        else rows.push({ type: "user", uuid: m.inputId, message: { role: "user", content: original.text } });
        break;
      }
      case "turn_start":
        this.inTurn = true;
        this.startingInput = m.input;
        this.lastMessage = this.delta = "";
        break;
      case "text_delta": this.delta += m.text; break;
      case "tool_start":
        this.tools.add(m.id);
        assistant([{ type: "tool_use", id: m.id, name: m.name, input: m.input }]);
        break;
      case "item": {
        const item = m.item;
        if (item.kind === "message") {
          rows.push(...itemRows(item));
          this.lastMessage = item.text;
          this.delta = "";
        } else {
          const id = item.id ?? key;
          rows.push(...itemRows({ ...item, id }, this.tools.delete(id)));
        }
        break;
      }
      case "turn_end": {
        const text = m.reply ?? this.delta;
        if (text && text !== this.lastMessage) assistant([{ type: "text", text }]);
        this.inTurn = false;
        this.tools.clear();
        this.lastMessage = this.delta = "";
        break;
      }
    }
    // ponytail: committed holder offsets suppress normal restart replay; add tail repair and fsync if power-loss durability is needed.
    if (!replay && rows.length) {
      const timestamp = new Date(at).toISOString();
      appendFileSync(this.file, rows.map((row, i) => JSON.stringify({ ...row, timestamp, k: i ? k + ":" + i : k }) + "\n").join(""), { mode: 0o600 });
    }
  }
}
