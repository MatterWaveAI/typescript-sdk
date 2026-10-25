import { describe, expect, it } from "vitest";
import {
  APIError,
  AuthenticationError,
  BadRequestError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  ServerError,
} from "../src/index.js";
import { REQUEST_ID, client, errorBody, json, stubFetch, text } from "./helpers.js";

const PROMPT = [{ role: "user" as const, content: "hi" }];

describe("every refusal is the right error, with the envelope and the request id", () => {
  it.each([
    [400, "invalid_request_error", "unsupported_parameter", BadRequestError],
    [401, "authentication_error", "invalid_api_key", AuthenticationError],
    [403, "permission_error", "insufficient_scope", PermissionDeniedError],
    [404, "invalid_request_error", "model_not_found", NotFoundError],
    [429, "insufficient_quota", "insufficient_quota", RateLimitError],
    [502, "server_error", "upstream_error", ServerError],
  ] as const)("%i is %s / %s", async (status, type, code, Cls) => {
    const { fetch } = stubFetch([json(errorBody("nope", type, code, "model"), status)]);
    const error = await client(fetch, { maxRetries: 0 })
      .chat.completions.create({ messages: PROMPT })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Cls);
    const api = error as APIError;
    expect(api.status).toBe(status);
    expect(api.message).toBe("nope");
    expect(api.type).toBe(type);
    expect(api.code).toBe(code);
    expect(api.param).toBe("model");
    expect(api.requestId).toBe(REQUEST_ID);
    expect(api.describe()).toContain(REQUEST_ID);
    expect(api.describe()).toContain(`[${code}]`);
    expect(api.name).toBe(Cls.name);
  });

  it("a non-envelope body still names the status and the request id", async () => {
    const { fetch } = stubFetch([text("<html>upstream unavailable</html>", 503)]);
    const error = await client(fetch, { maxRetries: 0 })
      .chat.completions.create({ messages: PROMPT })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServerError);
    const api = error as APIError;
    expect(api.status).toBe(503);
    expect(api.message).toContain("upstream unavailable");
    expect(api.requestId).toBe(REQUEST_ID);
    expect(api.code).toBeNull();
  });

  it("Retry-After is surfaced in seconds", async () => {
    const { fetch } = stubFetch([
      json(errorBody("slow down", "rate_limit_error", "rate_limit_exceeded"), 429, { "Retry-After": "7" }),
    ]);
    const error = await client(fetch, { maxRetries: 0 })
      .chat.completions.create({ messages: PROMPT })
      .catch((e: unknown) => e);
    expect((error as APIError).retryAfter).toBe(7);
    expect((error as APIError).rateLimit).toBeNull(); // no X-RateLimit-* headers were sent
  });

  it("the rate-limit window is surfaced from the headers", async () => {
    const { fetch } = stubFetch([
      json(errorBody("slow down", "rate_limit_error", "rate_limit_exceeded"), 429, {
        "Retry-After": "7",
        "X-RateLimit-Limit": "60",
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": "7",
      }),
    ]);
    const error = await client(fetch, { maxRetries: 0 })
      .chat.completions.create({ messages: PROMPT })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as APIError).rateLimit).toEqual({ limit: 60, remaining: 0, reset: 7 });
  });

  it("a partial or malformed trio is no window", async () => {
    const { fetch } = stubFetch([
      json(errorBody("slow down", "rate_limit_error", "rate_limit_exceeded"), 429, {
        "X-RateLimit-Limit": "60",
        "X-RateLimit-Remaining": "soon",
      }),
    ]);
    const error = await client(fetch, { maxRetries: 0 })
      .chat.completions.create({ messages: PROMPT })
      .catch((e: unknown) => e);
    expect((error as APIError).rateLimit).toBeNull();
  });

  it("a non-JSON success body is an APIError with the request id", async () => {
    const { fetch } = stubFetch([text("not json", 200)]);
    const error = await client(fetch, { maxRetries: 0 })
      .chat.completions.create({ messages: PROMPT })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(APIError);
    expect((error as APIError).requestId).toBe(REQUEST_ID);
  });
});
