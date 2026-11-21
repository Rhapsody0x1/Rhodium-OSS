// A plugin's own session may be opaque; Rhodium stores its visible messages in the slot conversation's file.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentToCoreMessage } from "@rhodium-oss/plugin-sdk";

export const managedFile = (stateDir: string, agent: string, conversation: string) =>
  join(stateDir, "transcripts", agent, conversation + ".jsonl");

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
          assistant([{ type: "text", text: item.text }]);
          this.lastMessage = item.text;
          this.delta = "";
        } else {
          const id = item.id ?? key;
          if (!this.tools.delete(id)) assistant([{ type: "tool_use", id, name: item.name, input: item.input }]);
          rows.push({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: item.result?.text ?? "", is_error: item.result?.error ?? false }] } });
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
