/**
 * Every write carries an `Idempotency-Key`: one per call, the same on each
 * retry of it, never on a read; `idempotencyKey` in the call's options (or a
 * `withOptions` view) supplies the caller's own, and a header the caller set
 * by hand is left alone.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MatterWave, newIdempotencyKey } from "../src/index.js";
import { API_KEY, BASE_URL, client, completionBody, errorBody, json, recordSleeps, stubFetch } from "./helpers.js";

const PROMPT = { messages: [{ role: "user" as const, content: "hi" }] };
const RATE_LIMITED = errorBody("Rate limit exceeded.", "rate_limit_error", "rate_limit_exceeded");
const ME = { subject: "u-1", kind: "key", roles: [], org_id: "o-1" };
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let restore: () => void;
beforeEach(() => {
  ({ restore } = recordSleeps());
});
afterEach(() => restore());

function keyOf(headers: Record<string, string>): string | undefined {
  const name = Object.keys(headers).find((h) => h.toLowerCase() === "idempotency-key");
  return name === undefined ? undefined : headers[name];
}

describe("idempotency keys", () => {
  it("a POST carries a fresh UUID, a new one per call", async () => {
    const { fetch, seen } = stubFetch([json(completionBody()), json(completionBody())]);
    const c = client(fetch);
    await c.chat.completions.create(PROMPT);
    await c.chat.completions.create(PROMPT);
    const [first, second] = seen.map((s) => keyOf(s.headers));
    expect(first).toMatch(UUID_V4);
    expect(second).toMatch(UUID_V4);
    expect(first).not.toBe(second);
  });

  it("every retry of a write reuses its key", async () => {
    const refused = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" }),
    });
    const { fetch, seen } = stubFetch([json(RATE_LIMITED, 429), refused, json(completionBody())]);
    await client(fetch).chat.completions.create(PROMPT);
    const keys = new Set(seen.map((s) => keyOf(s.headers)));
    expect(seen).toHaveLength(3);
    expect(keys.size).toBe(1);
    expect([...keys][0]).toMatch(UUID_V4);
  });

  it("a read carries none", async () => {
    const { fetch, seen } = stubFetch([json(ME)]);
    await client(fetch).me({ idempotencyKey: "ignored" });
    expect(keyOf(seen[0]!.headers)).toBeUndefined();
  });

  it("PUT, PATCH and DELETE are writes too", async () => {
    const conversation = { id: "c-1", title: "t", messages: [] };
    const { fetch, seen } = stubFetch([json(conversation), json(conversation), json({ status: "deleted" })]);
    const c = client(fetch);
    await c.conversations.pin("c-1");
    await c.conversations.update("c-1", { title: "t" });
    await c.conversations.delete("c-1");
    expect(seen.map((s) => s.method)).toEqual(["PUT", "PATCH", "DELETE"]);
    for (const s of seen) expect(keyOf(s.headers)).toMatch(UUID_V4);
  });

  it("the caller's key is sent on every attempt", async () => {
    const { fetch, seen } = stubFetch([json(RATE_LIMITED, 429), json({ id: "k-1", key: "mw_x" }, 201)]);
    await client(fetch).keys.create({ name: "ci" }, { idempotencyKey: "job-42" });
    expect(seen.map((s) => keyOf(s.headers))).toEqual(["job-42", "job-42"]);
  });

  it("a withOptions view carries its key on writes only", async () => {
    const { fetch, seen } = stubFetch([json(completionBody()), json(ME)]);
    const view = client(fetch).withOptions({ idempotencyKey: "job-7" });
    await view.chat.completions.create(PROMPT);
    await view.me();
    expect(keyOf(seen[0]!.headers)).toBe("job-7");
    expect(keyOf(seen[1]!.headers)).toBeUndefined();
  });

  it("a header set by hand is left alone", async () => {
    const { fetch, seen } = stubFetch([json(completionBody())]);
    const c = new MatterWave({ apiKey: API_KEY, baseUrl: BASE_URL, defaultHeaders: { "idempotency-key": "by-hand" }, fetch });
    await c.chat.completions.create(PROMPT);
    expect(Object.keys(seen[0]!.headers).filter((h) => h.toLowerCase() === "idempotency-key")).toEqual([
      "idempotency-key",
    ]);
    expect(keyOf(seen[0]!.headers)).toBe("by-hand");
  });

  it("an empty key is refused", () => {
    const { fetch } = stubFetch([json(ME)]);
    expect(() => client(fetch).withOptions({ idempotencyKey: " " })).toThrow(/idempotencyKey/);
  });

  it("a key is made without randomUUID where only getRandomValues exists", () => {
    const real = globalThis.crypto;
    const limited = { getRandomValues: (bytes: Uint8Array) => real.getRandomValues(bytes) };
    Object.defineProperty(globalThis, "crypto", { value: limited, configurable: true });
    try {
      expect(newIdempotencyKey()).toMatch(UUID_V4);
    } finally {
      Object.defineProperty(globalThis, "crypto", { value: real, configurable: true });
    }
  });
});
