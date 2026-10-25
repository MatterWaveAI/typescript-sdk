/**
 * The contract the app's own routes hold that the `/v1` tests do not cover:
 * a 429 in FastAPI's `detail` shape carries the window and the request id
 * like one in the envelope, `pages()` ends on a server that still answers
 * the pre-paging shape, and a rename the server refuses is an error that
 * names the field rather than a crash on a 422 body.
 */

import { describe, expect, it } from "vitest";
import { APIError, RateLimitError } from "../src/index.js";
import { BASE_URL, REQUEST_ID, client, json, stubFetch } from "./helpers.js";

const CONV = "c0ffee00-0000-4000-8000-000000000001";

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

const REFUSED = {
  detail: "Rate limit of 3 requests per minute exceeded for this API key.",
  retry_after_s: 42,
  request_id: REQUEST_ID,
};
const WINDOW = {
  "Retry-After": "42",
  "X-RateLimit-Limit": "3",
  "X-RateLimit-Remaining": "0",
  "X-RateLimit-Reset": "42",
};

describe("the app's own routes", () => {
  it("a 429 in FastAPI's shape carries the window and the request id", async () => {
    const { fetch } = stubFetch([json(REFUSED, 429, WINDOW)]);
    const error = await client(fetch, { maxRetries: 0 })
      .conversations.list()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    const refused = error as RateLimitError;
    expect(refused.rateLimit).toEqual({ limit: 3, remaining: 0, reset: 42 });
    expect(refused.retryAfter).toBe(42);
    expect(refused.requestId).toBe(REQUEST_ID);
    expect(refused.message).toBe(REFUSED.detail);
    expect(refused.code).toBeNull();
  });

  it("a rename refused by the window reads the same", async () => {
    const { fetch } = stubFetch([json(REFUSED, 429, WINDOW)]);
    const error = await client(fetch, { maxRetries: 0 })
      .conversations.update(CONV, { title: "Renamed" })
      .catch((e: unknown) => e);
    expect((error as RateLimitError).rateLimit).toEqual({ limit: 3, remaining: 0, reset: 42 });
  });

  it("pages() ends on a server that answers the pre-paging shape", async () => {
    const { fetch, seen } = stubFetch([json({ data: [conversation()], filter: "default" })]);
    const walked: string[] = [];
    for await (const page of client(fetch).conversations.pages({ limit: 1 })) {
      expect(page.next_cursor).toBeUndefined();
      walked.push(...page.data.map((c) => c.id));
    }
    expect(walked).toEqual([CONV]);
    expect(seen.map((s) => s.url)).toEqual([`${BASE_URL}/api/conversations?limit=1`]);
  });

  it("a rename the server refuses names the field", async () => {
    const { fetch } = stubFetch([
      json(
        {
          detail: [
            { loc: ["body", "title"], msg: "Value error, title must be at most 200 characters", type: "value_error" },
          ],
          request_id: REQUEST_ID,
        },
        422,
      ),
    ]);
    const error = await client(fetch, { maxRetries: 0 })
      .conversations.update(CONV, { title: "x".repeat(201) })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(APIError);
    expect((error as APIError).status).toBe(422);
    expect((error as APIError).message).toContain("200 characters");
    expect((error as APIError).requestId).toBe(REQUEST_ID);
  });
});
