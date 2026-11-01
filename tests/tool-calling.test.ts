/**
 * The tool loop from the caller's side: tool calls reassembled from a
 * stream's fragments, the assistant message and `tool` answers sent back,
 * and the two flags a client reads before offering its agent mode
 * (`supports_tools` on a model row, `local_agent_tools` on `/api/me`).
 */

import { describe, expect, it } from "vitest";
import {
  ChatCompletionAccumulator,
  localAgentToolsOf,
  toolMessage,
  toolsOf,
  type ChatCompletion,
  type ChatCompletionChunk,
  type Message,
  type Tool,
} from "../src/index.js";
import { chunk, client, completionBody, json, sse, stubFetch } from "./helpers.js";

const PROMPT: Message[] = [{ role: "user", content: "Read the README and the licence." }];

// Two calls whose fragments interleave, the way a model making parallel
// calls streams them: each index opens with its id and name, then its
// arguments arrive in pieces.
const TWO_CALLS =
  chunk({ role: "assistant", content: "" }) +
  chunk({ content: "Reading both." }) +
  chunk({ tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "read_file", arguments: "" } }] }) +
  chunk({ tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "read_file" } }] }) +
  chunk({ tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] }) +
  chunk({ tool_calls: [{ index: 1, function: { arguments: '{"path":"LICENSE"}' } }] }) +
  chunk({ tool_calls: [{ index: 0, function: { arguments: '"README.md"}' } }] }) +
  chunk({}, "tool_calls") +
  chunk(null, null, { prompt_tokens: 30, completion_tokens: 12, total_tokens: 42 }) +
  "data: [DONE]\n\n";

describe("streamed tool calls", () => {
  it("finalMessage() reassembles interleaved calls", async () => {
    const { fetch } = stubFetch([sse([TWO_CALLS])]);
    const stream = await client(fetch).chat.completions.create({ messages: PROMPT, stream: true });
    const message = await stream.finalMessage();
    expect(message.content).toBe("Reading both.");
    expect(message.tool_calls).toEqual([
      { id: "call_a", type: "function", function: { name: "read_file", arguments: '{"path":"README.md"}' } },
      { id: "call_b", type: "function", function: { name: "read_file", arguments: '{"path":"LICENSE"}' } },
    ]);
    expect(JSON.parse(message.tool_calls![0]!.function.arguments)).toEqual({ path: "README.md" });
  });

  it("the accumulator keeps the finish reason, usage and model", async () => {
    const { fetch } = stubFetch([sse([TWO_CALLS])]);
    const stream = await client(fetch).chat.completions.create({
      messages: PROMPT,
      stream: true,
      stream_options: { include_usage: true },
    });
    const accumulator = new ChatCompletionAccumulator();
    const seen: ChatCompletionChunk[] = [];
    for await (const piece of stream) {
      seen.push(piece);
      accumulator.add(piece);
    }
    expect(accumulator.finishReason).toBe("tool_calls");
    expect(accumulator.usage?.total_tokens).toBe(42);
    expect(accumulator.model).toBe("grt-nano");
    expect(accumulator.toolCalls).toHaveLength(2);
    expect(seen).toHaveLength(9);
  });

  it("a pure tool-call turn has null content", async () => {
    const body =
      chunk({ role: "assistant" }) +
      chunk({ tool_calls: [{ index: 0, id: "call_0", type: "function", function: { name: "list_dir", arguments: "{}" } }] }) +
      chunk({}, "tool_calls") +
      "data: [DONE]\n\n";
    const { fetch } = stubFetch([sse([body])]);
    const message = await (await client(fetch).chat.completions.create({ messages: PROMPT, stream: true })).finalMessage();
    expect(message).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_0", type: "function", function: { name: "list_dir", arguments: "{}" } }],
    });
  });

  it("a plain answer has no tool_calls key", async () => {
    const { fetch } = stubFetch([sse([chunk({ content: "Hi" }) + chunk({}, "stop") + "data: [DONE]\n\n"])]);
    const message = await (await client(fetch).chat.completions.create({ messages: PROMPT, stream: true })).finalMessage();
    expect(message).toEqual({ role: "assistant", content: "Hi" });
  });
});

describe("the tool round", () => {
  it("goes back on the wire as the assistant message and a tool message per call", async () => {
    const first = completionBody() as unknown as ChatCompletion;
    first.choices[0]!.message = {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_0", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }],
    };
    first.choices[0]!.finish_reason = "tool_calls";
    const { fetch, seen } = stubFetch([json(first), json(completionBody("Done."))]);
    const c = client(fetch);
    const tools: Tool[] = [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }];
    const completion = await c.chat.completions.create({ messages: PROMPT, tools, tool_choice: "auto" });
    const assistant = completion.choices[0]!.message;
    const call = assistant.tool_calls![0]!;
    const answer = await c.chat.completions.create({
      messages: [...PROMPT, assistant, toolMessage(call.id, "hello from a.txt")],
      tools,
    });
    expect(answer.choices[0]!.message.content).toBe("Done.");
    const sent = seen[1]!.body as { messages: Message[]; tools: Tool[] };
    expect(sent.messages[1]).toEqual(first.choices[0]!.message);
    expect(sent.messages[2]).toEqual({ role: "tool", tool_call_id: "call_0", content: "hello from a.txt" });
    expect(sent.tools).toEqual(tools);
  });

  it("toolMessage needs the call id", () => {
    expect(() => toolMessage("", "result")).toThrow(/toolCallId/);
  });
});

describe("the agent flags", () => {
  it("supports_tools rides on the model rows as sent", async () => {
    const { fetch } = stubFetch([
      json({
        object: "list",
        default_model: "grt",
        data: [
          { id: "grt", label: "GRT", included: true, supports_tools: true },
          { id: "old", label: "Old", included: true, supports_tools: false },
          { id: "mum", label: "Mum", included: true },
        ],
      }),
    ]);
    const models = await client(fetch).appModels();
    expect(models.data.map((m) => m.supports_tools ?? null)).toEqual([true, false, null]);
  });

  it.each([[true], [false], [undefined]])("local_agent_tools on /api/me: %s", async (value) => {
    const body: Record<string, unknown> = { subject: "u-1", kind: "key", roles: [], org_id: "o-1" };
    if (value !== undefined) body.local_agent_tools = value;
    const { fetch } = stubFetch([json(body)]);
    const me = await client(fetch).me();
    expect(me.local_agent_tools ?? null).toBe(value ?? null);
  });
});

describe("toolsOf and localAgentToolsOf", () => {
  const rows = [
    { id: "grt", supports_tools: true },
    { id: "old", supports_tools: false },
    { id: "mum", supports_tools: null },
    { id: "bare" },
  ];

  it("reads the rows the way visionOf does", () => {
    expect(rows.map((r) => toolsOf(rows, r.id))).toEqual(["yes", "no", "unknown", "unknown"]);
    expect(toolsOf(rows, "missing")).toBe("unknown");
    expect(toolsOf(rows, null)).toBe("unknown");
    expect(toolsOf(null, "grt")).toBe("unknown");
  });

  it("says no only when the org does", () => {
    expect(localAgentToolsOf({ local_agent_tools: false })).toBe("no");
    expect(localAgentToolsOf({ local_agent_tools: true })).toBe("yes");
    expect(localAgentToolsOf({ local_agent_tools: null })).toBe("unknown");
    expect(localAgentToolsOf({})).toBe("unknown");
    expect(localAgentToolsOf(null)).toBe("unknown");
  });
});
