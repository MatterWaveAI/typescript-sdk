import { describe, expect, it } from "vitest";
import { APIError, type ChatCompletionChunk } from "../src/index.js";
import { REQUEST_ID, chunk, client, sse, stubFetch } from "./helpers.js";

const PROMPT = [{ role: "user" as const, content: "hi" }];

const FRAMES =
  chunk({ role: "assistant", content: "" }) +
  chunk({ content: "Hello" }) +
  chunk({ content: ", world" }) +
  chunk({}, "stop") +
  chunk(null, null, { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }) +
  "data: [DONE]\n\n";

const ERROR_FRAME =
  'data: {"error":{"message":"gateway died","type":"server_error","param":null,"code":"upstream_error"}}\n\n';

describe("a streamed completion", () => {
  it("yields typed chunks in order, with the request id", async () => {
    const { fetch, seen } = stubFetch([sse([FRAMES])]);
    const stream = await client(fetch).chat.completions.create({
      messages: PROMPT,
      stream: true,
      stream_options: { include_usage: true },
    });
    const chunks: ChatCompletionChunk[] = [];
    for await (const c of stream) chunks.push(c);

    expect(seen[0]!.headers.Accept).toBe("text/event-stream");
    expect(seen[0]!.body).toEqual({
      messages: PROMPT,
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(chunks.map((c) => c.choices[0]?.delta.content ?? "")).toEqual(["", "Hello", ", world", "", ""]);
    expect(chunks[0]!.choices[0]!.delta.role).toBe("assistant");
    expect(chunks[3]!.choices[0]!.finish_reason).toBe("stop");
    expect(chunks[4]!.choices).toEqual([]);
    expect(chunks[4]!.usage?.total_tokens).toBe(7);
    expect(stream.requestId).toBe(REQUEST_ID);
    expect((chunks[1] as { requestId?: string }).requestId).toBe(REQUEST_ID);
  });

  it("text() yields only the words", async () => {
    const { fetch } = stubFetch([sse([FRAMES])]);
    const stream = await client(fetch).chat.completions.create({ messages: PROMPT, stream: true });
    let text = "";
    for await (const piece of stream.text()) text += piece;
    expect(text).toBe("Hello, world");
  });

  it("reassembles frames split across byte chunks, CRLF, comments and a missing final blank line", async () => {
    const body = ": keep-alive\r\n\r\n" + chunk({ content: "ab" }).replace(/\n/g, "\r\n") + chunk({ content: "cd" }) + "data: [DONE]";
    const pieces = [body.slice(0, 17), body.slice(17, 40), body.slice(40, 41), body.slice(41)];
    const { fetch } = stubFetch([sse(pieces)]);
    const stream = await client(fetch).chat.completions.create({ messages: PROMPT, stream: true });
    let text = "";
    for await (const piece of stream.text()) text += piece;
    expect(text).toBe("abcd");
  });

  it("throws the error envelope sent mid-stream, after what arrived before it", async () => {
    const { fetch } = stubFetch([
      sse([chunk({ role: "assistant", content: "" }) + chunk({ content: "partial" }) + ERROR_FRAME]),
    ]);
    const stream = await client(fetch).chat.completions.create({ messages: PROMPT, stream: true });
    const seen: string[] = [];
    let caught: unknown;
    try {
      for await (const c of stream) seen.push(c.choices[0]?.delta.content ?? "");
    } catch (err) {
      caught = err;
    }
    expect(seen).toEqual(["", "partial"]);
    expect(caught).toBeInstanceOf(APIError);
    const error = caught as APIError;
    expect(error.status).toBeNull();
    expect(error.code).toBe("upstream_error");
    expect(error.type).toBe("server_error");
    expect(error.requestId).toBe(REQUEST_ID);
  });

  it("streams tool-call fragments typed", async () => {
    const body =
      chunk({ role: "assistant", content: "" }) +
      chunk({ tool_calls: [{ index: 0, id: "call_0", type: "function", function: { name: "weather" } }] }) +
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"city"' } }] }) +
      chunk({ tool_calls: [{ index: 0, function: { arguments: ':"Oslo"}' } }] }) +
      chunk({}, "tool_calls") +
      "data: [DONE]\n\n";
    const { fetch } = stubFetch([sse([body])]);
    const stream = await client(fetch).chat.completions.create({ messages: PROMPT, stream: true });
    const chunks: ChatCompletionChunk[] = [];
    for await (const c of stream) chunks.push(c);
    const fragments = chunks.slice(1, 4).map((c) => c.choices[0]!.delta.tool_calls![0]!);
    expect(fragments[0]!.id).toBe("call_0");
    expect(fragments[0]!.function.name).toBe("weather");
    expect(fragments.map((f) => f.function.arguments ?? "").join("")).toBe('{"city":"Oslo"}');
    expect(chunks[4]!.choices[0]!.finish_reason).toBe("tool_calls");
  });

  it("breaking out of the loop aborts the request, and a stream iterates once", async () => {
    const { fetch, seen } = stubFetch([sse([FRAMES])]);
    const controller = new AbortController();
    const stream = await client(fetch).chat.completions.create(
      { messages: PROMPT, stream: true },
      { signal: controller.signal },
    );
    for await (const piece of stream.text()) {
      expect(piece).toBe("Hello");
      break;
    }
    void seen;
    let again: unknown;
    try {
      for await (const _ of stream) void _;
    } catch (err) {
      again = err;
    }
    expect(again).toBeInstanceOf(Error);
    expect((again as Error).message).toMatch(/once/);
  });
});
