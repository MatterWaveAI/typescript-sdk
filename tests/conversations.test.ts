import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  APIConnectionError,
  APP_OPERATIONS,
  ConflictError,
  MatterWave,
  MatterWaveConfigError,
  NotFoundError,
  RESUME_PLACEHOLDER,
  frameFromEvent,
  summaryOf,
  type ConversationFrame,
} from "../src/index.js";
import { BASE_URL, REQUEST_ID, client, json, recordSleeps, sse, stubFetch } from "./helpers.js";

const CONV = "c0ffee00-0000-4000-8000-000000000001";
const GEN = "gen-7f3a";

/** One frame the way generation.py's `sse_frame` writes it. */
function frame(event: string, data: unknown, id: string | null = null): string {
  const lines = id !== null ? [`id: ${id}`] : [];
  lines.push(`event: ${event}`, `data: ${JSON.stringify(data)}`);
  return `${lines.join("\n")}\n\n`;
}

function message(role: string, text: string, id: string, parent: string | null = null, extra: Record<string, unknown> = {}) {
  return {
    id,
    conversation_id: CONV,
    role,
    parts: [{ type: "text", text }],
    content: text,
    content_version: 2,
    created_at: "2026-10-18T09:00:00+00:00",
    parent_id: parent,
    model: null,
    truncated: false,
    ...extra,
  };
}

function conversation(extra: Record<string, unknown> = {}) {
  return {
    id: CONV,
    title: "New chat",
    created_at: "2026-10-18T09:00:00+00:00",
    updated_at: "2026-10-18T09:00:00+00:00",
    org_id: "org-1",
    last_message_at: null,
    preview: null,
    message_count: 0,
    default_model: null,
    current_leaf_message_id: null,
    pinned_at: null,
    archived_at: null,
    system_prompt: null,
    folder_id: null,
    ...extra,
  };
}

const USER = message("user", "Hi there", "m-user");
const ASSISTANT = message("assistant", "Hello, world", "m-asst", "m-user", { model: "grt-nano" });
const SUMMARY = message("system", "They said hello.", "m-sum", null, {
  parts: [
    {
      type: "summary",
      text: "They said hello.",
      covers_from: "m-0",
      covers_to: "m-9",
      tokens_before: 9000,
      tokens_after: 300,
    },
  ],
});

// A whole turn as the API sends one, with heartbeats between frames.
const HEAD =
  frame("compaction", { message: SUMMARY, covers_from: "m-0", covers_to: "m-9", tokens_before: 9000, tokens_after: 300 }) +
  frame("message", USER) +
  frame("title", { title: "Hi there" }) +
  ": mw-heartbeat\n\n" +
  frame("part_start", { index: 0, type: "reasoning" }, `${GEN}:0`) +
  frame("delta", { reasoning: "greet", index: 0 }, `${GEN}:1`) +
  frame("part_end", { index: 0 }, `${GEN}:2`) +
  frame("part_start", { index: 1, type: "text" }, `${GEN}:3`) +
  frame("delta", { content: "Hello", index: 1 }, `${GEN}:4`);
const TAIL =
  frame("delta", { content: ", world", index: 1 }, `${GEN}:5`) +
  ": mw-heartbeat\n\n" +
  frame("part_end", { index: 1 }, `${GEN}:6`) +
  frame("context", { prompt_tokens: 320, completion_tokens: 4, context_window: 8192 }) +
  frame("done", ASSISTANT);
const TURN = HEAD + TAIL;

/** An SSE response whose body breaks after `body`, the way a dropped connection reads. */
function dropping(body: string): Response {
  // The error lands on the read after the bytes; erroring in `start` would
  // discard what was already queued.
  let sent = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) controller.error(new TypeError("terminated"));
      else controller.enqueue(new TextEncoder().encode(body));
      sent = true;
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "X-Request-Id": REQUEST_ID },
  });
}

async function collect(stream: AsyncIterable<ConversationFrame>): Promise<ConversationFrame[]> {
  const out: ConversationFrame[] = [];
  for await (const f of stream) out.push(f);
  return out;
}

let sleeps: number[];
let restore: () => void;
beforeEach(() => {
  ({ sleeps, restore } = recordSleeps());
});
afterEach(() => restore());

describe("the conversation stream", () => {
  it("yields every frame of a turn typed and in order", async () => {
    const { fetch, seen } = stubFetch([sse([TURN.slice(0, 37), TURN.slice(37, 400), TURN.slice(400)])]);
    const stream = await client(fetch).conversations.send(CONV, { content: "Hi there", model: "grt-nano" });
    const frames = await collect(stream);
    expect(frames.map((f) => f.event)).toEqual([
      "compaction",
      "message",
      "title",
      "part_start",
      "delta",
      "part_end",
      "part_start",
      "delta",
      "delta",
      "part_end",
      "context",
      "done",
    ]);
    const compaction = frames[0]!;
    if (compaction.event !== "compaction") throw new Error("expected compaction");
    expect(compaction.tokens_before).toBe(9000);
    expect(summaryOf(compaction.message)?.covers_to).toBe("m-9");
    const reasoning = frames[4]!;
    expect(reasoning).toMatchObject({ event: "delta", reasoning: "greet", content: null, id: `${GEN}:1` });
    expect(frames[10]).toMatchObject({ event: "context", context_window: 8192 });
    expect(stream.result?.content).toBe("Hello, world");
    expect(stream.lastEventId).toBe(`${GEN}:6`);
    expect(stream.requestId).toBe(REQUEST_ID);

    expect(seen[0]!.url).toBe(`${BASE_URL}/api/conversations/${CONV}/messages`);
    expect(seen[0]!.headers.Accept).toBe("text/event-stream");
    expect(seen[0]!.headers.Authorization).toBe("Bearer mw_test_key");
    expect(seen[0]!.body).toEqual({ content: "Hi there", model: "grt-nano" });
  });

  it("text() yields only the answer", async () => {
    const { fetch } = stubFetch([sse([TURN])]);
    const stream = await client(fetch).conversations.send(CONV, { content: "Hi there" });
    let text = "";
    for await (const piece of stream.text()) text += piece;
    expect(text).toBe("Hello, world");
  });

  it("reads tool parts, notices and events it does not know", async () => {
    const body =
      frame("part_start", { index: 0, type: "tool_call", id: "call_0", name: "web_search", arguments: "{}" }, `${GEN}:0`) +
      frame("part_start", { index: 1, type: "tool_result", id: "call_0", output: "none", is_error: true }, `${GEN}:1`) +
      frame("notice", { detail: "Older messages may be cut.", code: "compaction" }) +
      frame("sparkles", { n: 1 }) +
      frame("done", ASSISTANT);
    const { fetch } = stubFetch([sse([body])]);
    const frames = await collect(await client(fetch).conversations.send(CONV, { content: "look it up" }));
    expect(frames[0]).toMatchObject({ event: "part_start", call_id: "call_0", name: "web_search", arguments: "{}" });
    expect(frames[1]).toMatchObject({ event: "part_start", is_error: true, output: "none" });
    // The server's notice is `{detail, code}`, the same keys as an error frame.
    expect(frames[2]).toMatchObject({ event: "notice", detail: "Older messages may be cut.", code: "compaction" });
    expect(frames[3]).toMatchObject({ event: "unknown", name: "sparkles", data: { n: 1 } });
  });

  it.each([
    ["error", { detail: "Budget used up.", code: "budget" }],
    ["moderation_block", { detail: "Not sent.", code: "moderation", request_id: "req-9" }],
  ])("%s ends the turn as a frame", async (event, data) => {
    const { fetch } = stubFetch([sse([frame(event, data) + frame("done", ASSISTANT)])]);
    const frames = await collect(await client(fetch).conversations.send(CONV, { content: "hi" }));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ event, code: data.code });
  });
});

describe("resume", () => {
  it("a dropped body resumes once from the last event id", async () => {
    const { fetch, seen } = stubFetch([dropping(HEAD), sse([TAIL])]);
    const stream = await client(fetch).conversations.send(CONV, { content: "Hi there" });
    let text = "";
    for await (const piece of stream.text()) text += piece;
    expect(text).toBe("Hello, world");
    expect(seen).toHaveLength(2);
    expect(seen[1]!.headers["Last-Event-ID"]).toBe(`${GEN}:4`);
    expect(seen[1]!.body).toEqual({ content: "Hi there" });
    expect(stream.result?.id).toBe("m-asst");
    expect(sleeps).toHaveLength(1);
  });

  it("a body that ends cleanly before done also resumes", async () => {
    const { fetch, seen } = stubFetch([sse([HEAD]), sse([TAIL])]);
    const frames = await collect(await client(fetch).conversations.send(CONV, { content: "Hi there" }));
    expect(frames.at(-1)?.event).toBe("done");
    expect(seen).toHaveLength(2);
  });

  it("an edit and a regenerate resume through the send route", async () => {
    const edit = stubFetch([sse([HEAD]), sse([TAIL])]);
    await collect(await client(edit.fetch).conversations.edit(CONV, "m-user", { content: "Hi again" }));
    expect(edit.seen[0]!.url).toBe(`${BASE_URL}/api/conversations/${CONV}/messages/m-user/edit`);
    expect(edit.seen[1]!.url).toBe(`${BASE_URL}/api/conversations/${CONV}/messages`);
    expect(edit.seen[1]!.body).toEqual({ content: "Hi again" });

    const regen = stubFetch([sse([HEAD]), sse([TAIL])]);
    await collect(await client(regen.fetch).conversations.regenerate(CONV, "m-asst", { model: "grt-nano" }));
    expect(regen.seen[0]!.url).toBe(`${BASE_URL}/api/conversations/${CONV}/messages/m-asst/regenerate`);
    expect(regen.seen[1]!.body).toEqual({ model: "grt-nano", content: RESUME_PLACEHOLDER });
  });

  it("only one resume is attempted", async () => {
    const { fetch, seen } = stubFetch([sse([HEAD]), sse([frame("delta", { content: "!", index: 1 }, `${GEN}:5`)])]);
    const stream = await client(fetch).conversations.send(CONV, { content: "Hi there" });
    await expect(collect(stream)).rejects.toBeInstanceOf(APIConnectionError);
    expect(seen).toHaveLength(2);
  });

  it("a drop before any event id is not resumed", async () => {
    // Nothing to resume after; re-sending would bill the prompt twice.
    const { fetch, seen } = stubFetch([sse([frame("message", USER)])]);
    const stream = await client(fetch).conversations.send(CONV, { content: "Hi there" });
    await expect(collect(stream)).rejects.toBeInstanceOf(APIConnectionError);
    expect(seen).toHaveLength(1);
  });
});

describe("the JSON routes", () => {
  it("list, search, create and get", async () => {
    const { fetch, seen } = stubFetch([
      json({ data: [conversation()], filter: "pinned" }),
      json({ data: [conversation({ snippet: "<b>hi</b>", message_id: "m-user" })], query: "hi" }),
      json(conversation({ title: "Plans" }), 201),
      json(conversation({ messages: [USER, ASSISTANT], tree: [USER, ASSISTANT], instructions: {} })),
    ]);
    const c = client(fetch);
    const page = await c.conversations.list({ filter: "pinned" });
    expect(page.data.map((x) => x.id)).toEqual([CONV]);
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/conversations?filter=pinned`);

    const hits = await c.conversations.search("hi", { limit: 5 });
    expect(hits.data[0]!.snippet).toBe("<b>hi</b>");
    expect(seen[1]!.url).toBe(`${BASE_URL}/api/conversations/search?q=hi&limit=5`);

    const created = await c.conversations.create({ title: "Plans", model: "grt-nano" });
    expect(created.title).toBe("Plans");
    expect(seen[2]!.body).toEqual({ title: "Plans", model: "grt-nano" });

    const full = await c.conversations.get(CONV, { full: true });
    expect(full.messages.map((m) => m.id)).toEqual(["m-user", "m-asst"]);
    expect(full.tree).toHaveLength(2);
    expect(seen[3]!.url).toBe(`${BASE_URL}/api/conversations/${CONV}?full=1`);
  });

  it("list sends limit and cursor, and pages() walks every page", async () => {
    const second = "c0ffee00-0000-4000-8000-000000000002";
    const third = "c0ffee00-0000-4000-8000-000000000003";
    const pages = () => [
      json({ data: [conversation()], filter: "default", next_cursor: "cur-1" }),
      json({ data: [conversation({ id: second })], filter: "default", next_cursor: "cur-2" }),
      json({ data: [conversation({ id: third })], filter: "default", next_cursor: null }),
    ];
    const { fetch, seen } = stubFetch(pages());
    const c = client(fetch);
    const first = await c.conversations.list({ limit: 1 });
    expect(first.next_cursor).toBe("cur-1");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/conversations?limit=1`);
    const next = await c.conversations.list({ limit: 1, cursor: first.next_cursor! });
    expect(next.data[0]!.id).toBe(second);
    expect(seen[1]!.url).toBe(`${BASE_URL}/api/conversations?limit=1&cursor=cur-1`);

    // A fresh queue: the stub repeats its last answer once drained.
    const walk = stubFetch(pages());
    const walked: string[] = [];
    for await (const page of client(walk.fetch).conversations.pages({ limit: 1 })) {
      walked.push(...page.data.map((x) => x.id));
    }
    expect(walked).toEqual([CONV, second, third]);
    expect(walk.seen.map((s) => s.url)).toEqual([
      `${BASE_URL}/api/conversations?limit=1`,
      `${BASE_URL}/api/conversations?limit=1&cursor=cur-1`,
      `${BASE_URL}/api/conversations?limit=1&cursor=cur-2`,
    ]);
  });

  it("tree, setActiveLeaf, fork and context", async () => {
    const { fetch, seen } = stubFetch([
      json(conversation({ messages: [USER, ASSISTANT] })),
      json(conversation({ current_leaf_message_id: "m-user", messages: [USER] })),
      json(conversation({ id: "c-2", messages: [USER] }), 201),
      json({ model: "grt-nano", context_window: 8192, used_tokens: null, estimated: true, compactable: true }),
    ]);
    const c = client(fetch);
    expect((await c.conversations.tree(CONV)).messages).toHaveLength(2);
    const moved = await c.conversations.setActiveLeaf(CONV, "m-user");
    expect(moved.current_leaf_message_id).toBe("m-user");
    expect(seen[1]!.method).toBe("PUT");
    expect(seen[1]!.body).toEqual({ message_id: "m-user" });
    expect((await c.conversations.fork(CONV, "m-user", { title: "Side" })).id).toBe("c-2");
    expect(seen[2]!.body).toEqual({ message_id: "m-user", title: "Side" });
    const context = await c.conversations.context(CONV);
    expect(context).toMatchObject({ context_window: 8192, used_tokens: null, estimated: true, compactable: true });
  });

  it("compact returns the summary message", async () => {
    const { fetch } = stubFetch([json(SUMMARY)]);
    const summary = await client(fetch).conversations.compact(CONV);
    expect(summary.role).toBe("system");
    expect(summaryOf(summary)?.tokens_after).toBe(300);
  });

  it("compact with nothing to fold is a ConflictError", async () => {
    const { fetch } = stubFetch([json({ detail: "Nothing to compact yet.", request_id: REQUEST_ID }, 409)]);
    const err = await client(fetch, { maxRetries: 0 }).conversations.compact(CONV).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).status).toBe(409);
    expect((err as ConflictError).message).toBe("Nothing to compact yet.");
    expect((err as ConflictError).requestId).toBe(REQUEST_ID);
  });

  it("update sets and clears the default model, always sending the field", async () => {
    const { fetch, seen } = stubFetch([json(conversation({ default_model: "grt-max" })), json(conversation())]);
    const updated = await client(fetch).conversations.update(CONV, { default_model: "grt-max" });
    expect(updated.default_model).toBe("grt-max");
    expect(updated.requestId).toBe(REQUEST_ID);
    expect(seen[0]!.method).toBe("PATCH");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/conversations/${CONV}`);
    expect(seen[0]!.body).toEqual({ default_model: "grt-max" });
    // null clears it: an absent field is "nothing to update" to the server.
    const cleared = await client(fetch).conversations.update(CONV, { default_model: null });
    expect(cleared.default_model).toBeNull();
    expect(seen[1]!.body).toEqual({ default_model: null });
  });

  it("update renames without touching the model, or does both in one call", async () => {
    const { fetch, seen } = stubFetch([
      json(conversation({ title: "Quarterly planning" })),
      json(conversation({ title: "Both", default_model: "grt-max" })),
    ]);
    const renamed = await client(fetch).conversations.update(CONV, { title: "Quarterly planning" });
    expect(renamed.title).toBe("Quarterly planning");
    // Only the title goes: a `default_model` key, even null, would clear the model.
    expect(seen[0]!.body).toEqual({ title: "Quarterly planning" });

    await client(fetch).conversations.update(CONV, { title: "Both", default_model: "grt-max" });
    expect(seen[1]!.body).toEqual({ title: "Both", default_model: "grt-max" });
  });

  it("update with nothing to change is refused before any request", async () => {
    const { fetch, seen } = stubFetch([]);
    expect(() => client(fetch).conversations.update(CONV, {})).toThrow(MatterWaveConfigError);
    expect(seen).toHaveLength(0);
  });

  it("an app route's 404 reads the detail", async () => {
    const { fetch } = stubFetch([json({ detail: "No such conversation", request_id: "r-1" }, 404)]);
    const err = await client(fetch).conversations.get(CONV).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect((err as NotFoundError).message).toBe("No such conversation");
  });

  it("me", async () => {
    const { fetch, seen } = stubFetch([
      json({ subject: "u-1", kind: "key", email: null, name: "Ada", roles: [], org_id: "org-1", org_name: "Acme", org_role: "member" }),
    ]);
    const me = await client(fetch).me();
    expect(me.org_name).toBe("Acme");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/me`);
  });

  it("refuses ids that would change the path", () => {
    const c = client(stubFetch([json({})]).fetch);
    expect(() => c.conversations.get("../me")).toThrow(MatterWaveConfigError);
    expect(() => c.conversations.setActiveLeaf(CONV, "")).toThrow(MatterWaveConfigError);
  });

  it("every app operation is a client method", () => {
    const c = new MatterWave({ apiKey: "k", baseUrl: BASE_URL });
    for (const dotted of Object.keys(APP_OPERATIONS)) {
      let target: unknown = c;
      for (const part of dotted.split(".")) {
        expect(target, `client has no ${dotted}`).toHaveProperty(part);
        target = (target as Record<string, unknown>)[part];
      }
      expect(typeof target).toBe("function");
    }
  });
});

describe("the context frame", () => {
  it("keeps counts the server did not know as null, not 0", () => {
    // generation.py sends `prompt_tokens: null` when the upstream reported no usage.
    const frame = frameFromEvent("context", { prompt_tokens: null, completion_tokens: null, context_window: 1024 });
    expect(frame).toMatchObject({ event: "context", prompt_tokens: null, completion_tokens: null, context_window: 1024 });
  });
});
