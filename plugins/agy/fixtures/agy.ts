import { readJsonLines, writeJsonLine } from "@rhodium-oss/plugin-sdk";
import { list, object, text, type Wire } from "../acp";
import scenarios from "./scenarios.json";

let sessionId = scenarios.sessionId;
let blocked: { prompt: unknown; request: string; kind: "permission" | "question" } | undefined;
let request = 0;
let cutting = false;
let rulesSeen = false;

const write = (frame: Wire) => writeJsonLine(process.stdout, { jsonrpc: "2.0", ...frame });
const result = (id: unknown, data: Wire) => write({ id, result: data });
const error = (id: unknown, code: number) => write({ id, error: { code, message: "Synthetic ACP error" } });
const update = (data: Wire) => write({ method: "session/update", params: { sessionId, update: data } });
const reply = (chunk: string) => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: chunk } });
const end = (id: unknown, stopReason = "end_turn") => result(id, { stopReason });

await readJsonLines(process.stdin, { onMessage(value) {
  const frame = object(value);
  const params = object(frame.params);
  const id = frame.id;
  switch (frame.method) {
    case "initialize":
      if (!Object.hasOwn(object(object(params.clientCapabilities).elicitation), "form")) return error(id, -32602);
      // The capabilities real agy 1.5.14 declares, so the plugin takes the same session/resume path.
      return result(id, { protocolVersion: 1, agentCapabilities: {
        loadSession: true, promptCapabilities: { image: true, audio: false, embeddedContext: true },
        sessionCapabilities: { resume: {}, close: {}, load: {}, list: {}, additionalDirectories: {} },
      } });
    case "session/new":
      return result(id, { sessionId });
    case "session/resume":
      if (params.sessionId === "slow-session") return; // never answers, for the startup time limit
      sessionId = text(params.sessionId);
      reply("Old conversation text that is not a new turn.");
      return result(id, {});
    case "session/close":
      return result(id, {});
    case "session/prompt": {
      cutting = false;
      if (params.sessionId !== sessionId) return error(id, -32602);
      const blocks = list(params.prompt).map(object);
      const texts = blocks.filter(block => block.type === "text").map(block => text(block.text));
      if (texts.length > 1 && texts[0]?.startsWith("Rhodium slot instructions:\n")) rulesSeen = true;
      if (!rulesSeen) return error(id, -32602);
      const prompt = texts.at(-1)?.replace(/^\[来自 [^\n]*\]\n/, "").trim();
      if (prompt === "[error]") return error(id, -32603);
      if (prompt === "[argv]") {
        reply(process.argv.slice(2).join(" "));
        return end(id);
      }
      if (prompt === "[crash]") {
        // Dies with an approval still waiting for the user.
        write({ id: `fixture-${++request}`, method: "session/request_permission", params: { sessionId, toolCall: { toolCallId: "crash-1", title: "Crash" }, options: scenarios.permissionOptions } });
        process.stderr.write("synthetic agy crash\n");
        setTimeout(() => process.exit(13), 100);
        return;
      }
      if (prompt === "[permission]" || prompt === "[question]" || prompt === "[number form]") {
        const kind = prompt === "[permission]" ? "permission" : "question";
        blocked = { prompt: id, request: `fixture-${++request}`, kind };
        if (kind === "permission") {
          const toolCall = { toolCallId: "permission-1", title: "Review synthetic file", rawInput: { path: "example.txt" } };
          update({ sessionUpdate: "tool_call", ...toolCall, status: "pending" });
          return write({ id: blocked.request, method: "session/request_permission", params: { sessionId, toolCall, options: scenarios.permissionOptions } });
        }
        const question = prompt === "[question]" ? scenarios.question
          : { ...scenarios.question, requestedSchema: { type: "object", properties: { count: { type: "number" } } } };
        return write({ id: blocked.request, method: "elicitation/create", params: { sessionId, ...question } });
      }
      for (const item of scenarios.updates) update(item);
      reply("Fixture reply ");
      reply(`(${blocks.filter(block => block.type === "image").length} images).`.replace("1 images", "1 image"));
      return end(id);
    }
    case "session/cancel":
      cutting = true;
      return;
    case undefined: {
      if (!blocked || id !== blocked.request) process.exit(14);
      const { prompt, kind } = blocked;
      blocked = undefined;
      const response = object(frame.result);
      if (frame.error) {
        reply(`Form error ${object(frame.error).code}`);
        return end(prompt);
      }
      if (cutting) {
        if (kind === "permission" ? object(response.outcome).outcome !== "cancelled" : response.action !== "cancel") process.exit(15);
        return end(prompt, "cancelled");
      }
      if (kind === "permission") {
        const option = text(object(response.outcome).optionId);
        update({ sessionUpdate: "tool_call_update", toolCallId: "permission-1", status: "completed", rawOutput: `Permission: ${option}` });
        reply(`Permission: ${option}`);
      } else {
        reply(response.action === "accept" ? `Answer: ${text(object(response.content).color)}` : `Answer: ${text(response.action)}`);
      }
      return end(prompt);
    }
    default:
      return error(id, -32601);
  }
} });
