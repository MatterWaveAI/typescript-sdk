import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  MatterWave,
  RateLimitError,
  ServerError,
} from "../src/index.js";
import { BACKOFF_BASE_MS, BACKOFF_CAP_MS, backoffMs, retryAfterSeconds } from "../src/client.js";
import {
  BASE_URL,
  REQUEST_ID,
  chunk,
  client,
  completionBody,
  errorBody,
  json,
  recordSleeps,
  sse,
  stubFetch,
  text,
} from "./helpers.js";

const PROMPT = [{ role: "user" as const, content: "hi" }];
const RATE_LIMITED = errorBody("Rate limit exceeded.", "rate_limit_error", "rate_limit_exceeded");
const BUDGET = errorBody("Budget used up.", "insufficient_quota", "insufficient_quota");
const UPSTREAM = errorBody("gateway failed", "server_error", "upstream_error");

let sleeps: number[];
let restore: () => void;

beforeEach(() => {
  ({ sleeps, restore } = recordSleeps());
});

afterEach(() => restore());

describe("retries", () => {
  it("a 429 with Retry-After waits exactly that long, then succeeds", async () => {
    const { fetch, calls } = stubFetch([
      json(RATE_LIMITED, 429, { "Retry-After": "3" }),
      json(completionBody()),
    ]);
    const completion = await client(fetch).chat.completions.create({ messages: PROMPT });
    expect(completion.choices[0]!.message.content).toBe("Hello there, friend of mine.");
    expect(calls()).toBe(2);
    expect(sleeps).toEqual([3000]);
  });

  it("a 5xx is retried with exponential, jittered backoff", async () => {
    const { fetch, calls } = stubFetch([
      json(UPSTREAM, 502),
      text("bad gateway", 503),
      json(completionBody()),
    ]);
    await client(fetch).chat.completions.create({ messages: PROMPT });
    expect(calls()).toBe(3);
    expect(sleeps[0]).toBeGreaterThanOrEqual(250);
    expect(sleeps[0]).toBeLessThanOrEqual(500);
    expect(sleeps[1]).toBeGreaterThanOrEqual(500);
    expect(sleeps[1]).toBeLessThanOrEqual(1000);
  });

  it("stops at maxRetries and throws the last answer, request id included", async () => {
    const { fetch, calls } = stubFetch([() => json(UPSTREAM, 502)]);
    const error = await client(fetch)
      .chat.completions.create({ messages: PROMPT })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServerError);
    expect((error as APIError).requestId).toBe(REQUEST_ID);
    expect(calls()).toBe(3);
    expect(sleeps).toHaveLength(2);
  });

  it("the budget 429 is not retried", async () => {
    const { fetch, calls } = stubFetch([() => json(BUDGET, 429)]);
    const error = await client(fetch)
      .chat.completions.create({ messages: PROMPT })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as APIError).code).toBe("insufficient_quota");
    expect(calls()).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("a 4xx is not retried", async () => {
    const { fetch, calls } = stubFetch([
      () => json(errorBody("bad", "invalid_request_error", "invalid_value"), 400),
    ]);
    await expect(client(fetch).chat.completions.create({ messages: PROMPT })).rejects.toBeInstanceOf(
      APIError,
    );
    expect(calls()).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("maxRetries: 0 sends once", async () => {
    const { fetch, calls } = stubFetch([() => json(UPSTREAM, 502)]);
    await expect(
      client(fetch, { maxRetries: 0 }).chat.completions.create({ messages: PROMPT }),
    ).rejects.toBeInstanceOf(ServerError);
    expect(calls()).toBe(1);
  });

  it("a connection error is retried, then thrown as APIConnectionError", async () => {
    const { fetch, calls } = stubFetch([() => new TypeError("fetch failed")]);
    const error = await client(fetch)
      .chat.completions.create({ messages: PROMPT })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(APIConnectionError);
    expect(error).not.toBeInstanceOf(APITimeoutError);
    expect((error as Error).message).toMatch(/could not reach/);
    expect(calls()).toBe(3);
  });

  it("a timeout is its own error", async () => {
    const never = (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    const c = new MatterWave({ apiKey: "k", baseUrl: BASE_URL, maxRetries: 0, timeoutMs: 5, fetch: never });
    await expect(c.chat.completions.create({ messages: PROMPT })).rejects.toBeInstanceOf(APITimeoutError);
  });

  it("the caller's own abort is thrown as is, not as a connection error", async () => {
    const controller = new AbortController();
    const onAbort = (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    const c = new MatterWave({ apiKey: "k", baseUrl: BASE_URL, fetch: onAbort });
    const pending = c.chat.completions.create({ messages: PROMPT }, { signal: controller.signal });
    controller.abort();
    const error = await pending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DOMException);
    expect(sleeps).toEqual([]);
  });

  it("a streamed 429 is retried before the stream starts", async () => {
    const frames = chunk({ role: "assistant", content: "" }) + chunk({ content: "ok" }) + chunk({}, "stop") + "data: [DONE]\n\n";
    const { fetch, calls } = stubFetch([json(RATE_LIMITED, 429, { "Retry-After": "1" }), sse([frames])]);
    const stream = await client(fetch).chat.completions.create({ messages: PROMPT, stream: true });
    let out = "";
    for await (const piece of stream.text()) out += piece;
    expect(out).toBe("ok");
    expect(calls()).toBe(2);
    expect(sleeps).toEqual([1000]);
  });

  it("backoff honours Retry-After and caps the exponent", () => {
    expect(backoffMs(0, 42)).toBe(42_000);
    expect(backoffMs(0, null)).toBeGreaterThanOrEqual(BACKOFF_BASE_MS / 2);
    expect(backoffMs(0, null)).toBeLessThanOrEqual(BACKOFF_BASE_MS);
    expect(backoffMs(20, null)).toBeLessThanOrEqual(BACKOFF_CAP_MS);
  });

  it("Retry-After as an HTTP date is converted to seconds", () => {
    const when = new Date(Date.now() + 30_000).toUTCString();
    const seconds = retryAfterSeconds(new Response(null, { status: 429, headers: { "Retry-After": when } }));
    expect(seconds).not.toBeNull();
    expect(seconds!).toBeGreaterThanOrEqual(25);
    expect(seconds!).toBeLessThanOrEqual(30);
  });
});
