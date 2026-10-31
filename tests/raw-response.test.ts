/**
 * Raw response access: `client.lastResponse` keeps the status and headers
 * the parsed models leave behind, on a refusal as well as on a success.
 */

import { describe, expect, it } from "vitest";
import { RateLimitError } from "../src/index.js";
import { REQUEST_ID, client, completionBody, errorBody, json, stubFetch, text } from "./helpers.js";

const PROMPT = { messages: [{ role: "user" as const, content: "hi" }] };

describe("client.lastResponse", () => {
  it("a 429's rate-limit window and request id survive the parsed error", async () => {
    const { fetch } = stubFetch([
      json(errorBody("Rate limit exceeded.", "rate_limit_error", "rate_limit_exceeded"), 429, {
        "X-RateLimit-Limit": "60",
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": "12",
        "Retry-After": "0",
      }),
    ]);
    const c = client(fetch, { maxRetries: 0 });
    await expect(c.chat.completions.create(PROMPT)).rejects.toBeInstanceOf(RateLimitError);
    expect(c.lastResponse).not.toBeNull();
    expect(c.lastResponse!.status).toBe(429);
    expect(c.lastResponse!.requestId).toBe(REQUEST_ID);
    expect(c.lastResponse!.rateLimit).toEqual({ limit: 60, remaining: 0, reset: 12 });
    expect(c.lastResponse!.header("x-ratelimit-remaining")).toBe("0");
  });

  it("a success's request id is reachable", async () => {
    const { fetch } = stubFetch([json({ subject: "u-1", kind: "key", roles: [], org_id: "o-1" })]);
    const c = client(fetch);
    await c.me();
    expect(c.lastResponse!.status).toBe(200);
    expect(c.lastResponse!.requestId).toBe(REQUEST_ID);
    expect(c.lastResponse!.header("X-Request-Id")).toBe(REQUEST_ID);
  });

  it("starts as null before anything has been sent", () => {
    const { fetch } = stubFetch([json(completionBody())]);
    expect(client(fetch).lastResponse).toBeNull();
  });

  it("a retried call leaves the final response", async () => {
    const { fetch } = stubFetch([text("boom", 500), json(completionBody())]);
    const c = client(fetch, { maxRetries: 1 });
    await c.chat.completions.create(PROMPT);
    expect(c.lastResponse!.status).toBe(200);
  });

  it("every resource call shares the one record", async () => {
    const { fetch } = stubFetch([json(completionBody())]);
    const c = client(fetch);
    await c.models.list();
    expect(c.lastResponse!.status).toBe(200);
  });
});
