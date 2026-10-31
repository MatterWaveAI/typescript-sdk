/**
 * Per-call overrides: `timeoutMs` and `maxRetries` on any call's options,
 * beating the client's own settings; left out, the client's apply.
 */

import { describe, expect, it } from "vitest";
import { APITimeoutError, MatterWave, ServerError } from "../src/index.js";
import { API_KEY, BASE_URL, client, completionBody, json, recordSleeps, stubFetch, text } from "./helpers.js";

const PROMPT = { messages: [{ role: "user" as const, content: "hi" }] };

describe("per-call timeout", () => {
  it("the call's own timeoutMs cuts the attempt short", async () => {
    let elapsed = Number.POSITIVE_INFINITY;
    const started = Date.now();
    const never = (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          elapsed = Date.now() - started;
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    const c = new MatterWave({ apiKey: API_KEY, baseUrl: BASE_URL, maxRetries: 0, timeoutMs: 60_000, fetch: never });
    await expect(c.chat.completions.create(PROMPT, { timeoutMs: 5 })).rejects.toBeInstanceOf(
      APITimeoutError,
    );
    expect(elapsed).toBeLessThan(1_000);
  });

  it("left out, the client's timeout applies", async () => {
    let elapsed = Number.POSITIVE_INFINITY;
    const started = Date.now();
    const never = (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          elapsed = Date.now() - started;
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    const c = new MatterWave({ apiKey: API_KEY, baseUrl: BASE_URL, maxRetries: 0, timeoutMs: 5, fetch: never });
    await expect(c.chat.completions.create(PROMPT, { timeoutMs: undefined })).rejects.toBeInstanceOf(
      APITimeoutError,
    );
    expect(elapsed).toBeLessThan(1_000);
  });
});

describe("per-call maxRetries", () => {
  it("the call's own maxRetries wins, retrying where the client would not", async () => {
    const { fetch, calls } = stubFetch([
      text("boom", 500),
      text("boom", 500),
      json(completionBody()),
    ]);
    const { sleeps, restore } = recordSleeps();
    try {
      const completion = await client(fetch, { maxRetries: 0 }).chat.completions.create(PROMPT, {
        maxRetries: 2,
      });
      expect(completion.choices[0].message.content).toBe("Hello there, friend of mine.");
      expect(calls()).toBe(3);
      expect(sleeps.length).toBe(2);
    } finally {
      restore();
    }
  });

  it("a call can refuse the retries the client would make", async () => {
    const { fetch, calls } = stubFetch([text("boom", 500)]);
    const { restore } = recordSleeps();
    try {
      const error = await client(fetch, { maxRetries: 2 })
        .chat.completions.create(PROMPT, { maxRetries: 0 })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ServerError);
      expect(calls()).toBe(1);
    } finally {
      restore();
    }
  });

  it("left out, the client's maxRetries apply", async () => {
    const { fetch, calls } = stubFetch([text("boom", 500), json(completionBody())]);
    const { restore } = recordSleeps();
    try {
      await client(fetch, { maxRetries: 1 }).chat.completions.create(PROMPT);
      expect(calls()).toBe(2);
    } finally {
      restore();
    }
  });

  it("the override reaches a conversation stream too", async () => {
    const sseBody =
      'event: delta\ndata: {"type":"delta","content":"He"}\n\n' +
      'event: done\ndata: {"type":"done","message":{"id":"m1","role":"assistant","content":"He"}}\n\n';
    const { fetch, calls } = stubFetch([text("boom", 500), text(sseBody, 200, { "Content-Type": "text/event-stream" })]);
    const { restore } = recordSleeps();
    try {
      const stream = await client(fetch, { maxRetries: 0 }).conversations.send("c-1", { content: "Hi" }, { maxRetries: 2 });
      for await (const _ of stream) {
        // read to the end
      }
      expect(calls()).toBe(2);
    } finally {
      restore();
    }
  });
});
