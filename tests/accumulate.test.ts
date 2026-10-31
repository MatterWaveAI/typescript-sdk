/**
 * Accumulation, item-level pagination and the telemetry hooks:
 * `stream.accumulate()` for the whole answer, `conversations.items()` for
 * every conversation of every page, `onRequest` / `onResponse` on the
 * client for logging.
 */

import { describe, expect, it } from "vitest";
import { MatterWave, itemsOf } from "../src/index.js";
import {
  API_KEY,
  BASE_URL,
  client,
  completionBody,
  json,
  sse,
  stubFetch,
  text,
} from "./helpers.js";

const DELTA = (content: string) =>
  `event: delta\ndata: ${JSON.stringify({ type: "delta", content })}\n\n`;
const DONE = (content: string) =>
  `event: done\ndata: ${JSON.stringify({
    type: "done",
    message: {
      id: "m1",
      conversation_id: "c-1",
      role: "assistant",
      parts: [{ type: "text", text: content }],
      content,
      content_version: 2,
      created_at: "2026-10-18T09:00:00+00:00",
      parent_id: null,
      model: null,
      truncated: false,
      finish_reason: null,
    },
  })}\n\n`;

const V1_TURN =
  'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n' +
  'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\n' +
  'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":" there"},"finish_reason":null}]}\n\n' +
  'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
  "data: [DONE]\n\n";

function page(ids: string[], nextCursor: string | null) {
  return {
    data: ids.map((id) => ({
      id,
      title: `Conversation ${id}`,
      created_at: "2026-10-18T09:00:00+00:00",
    })),
    filter: "default",
    ...(nextCursor ? { next_cursor: nextCursor } : {}),
  };
}

describe("stream.accumulate", () => {
  it("the /v1 stream accumulates to the whole answer", async () => {
    const { fetch } = stubFetch([sse([V1_TURN])]);
    const stream = await client(fetch).chat.completions.create({
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    expect(await stream.accumulate()).toBe("Hello there");
  });

  it("the conversation stream accumulates to the whole turn", async () => {
    const { fetch } = stubFetch([sse([DELTA("He") + DELTA("llo") + DONE("Hello")])]);
    const stream = await client(fetch).conversations.send("c-1", { content: "Hi" });
    expect(await stream.accumulate()).toBe("Hello");
  });
});

describe("conversations.items", () => {
  it("walks every page one conversation at a time", async () => {
    const { fetch, seen } = stubFetch([
      json(page(["c-1", "c-2"], "cursor-1")),
      json(page(["c-3"], null)),
    ]);
    const items: string[] = [];
    for await (const conversation of client(fetch).conversations.items()) {
      items.push(conversation.id);
    }
    expect(items).toEqual(["c-1", "c-2", "c-3"]);
    expect(seen).toHaveLength(2);
    expect(new URL(seen[1]!.url).searchParams.get("cursor")).toBe("cursor-1");
  });

  it("itemsOf is generic over any page with a data list", async () => {
    const { fetch } = stubFetch([json(page(["c-9"], null))]);
    const pages = client(fetch).conversations.pages();
    const items: string[] = [];
    for await (const conversation of itemsOf(pages)) items.push(conversation.id);
    expect(items).toEqual(["c-9"]);
  });
});

describe("client hooks", () => {
  it("onRequest and onResponse see every attempt, refusals included", async () => {
    const { fetch, seen } = stubFetch([text("boom", 500), json(completionBody())]);
    const requests: string[] = [];
    const statuses: number[] = [];
    const c = new MatterWave({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      maxRetries: 1,
      fetch,
      onRequest: (request) => requests.push(`${request.method} ${request.path}`),
      onResponse: (response) => statuses.push(response.status),
    });
    await c.chat.completions.create({ messages: [{ role: "user", content: "hi" }] });
    expect(requests).toEqual(["POST /v1/chat/completions", "POST /v1/chat/completions"]);
    expect(statuses).toEqual([500, 200]);
    expect(seen).toHaveLength(2);
  });

  it("a hook that throws fails the call, loudly", async () => {
    const { fetch } = stubFetch([json(completionBody())]);
    const c = new MatterWave({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      fetch,
      onRequest: () => {
        throw new Error("hook exploded");
      },
    });
    await expect(c.models.list()).rejects.toThrow("hook exploded");
  });
});
