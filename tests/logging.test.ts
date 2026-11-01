/**
 * `logLevel` / `MATTERWAVE_LOG` and the deprecation warning: a line per
 * attempt with the method, path, status, request id and time, never a body
 * or a header; one warning per deprecated route.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MatterWave, NotFoundError } from "../src/index.js";
import { deprecationMessage, logLevelOf, resetDeprecationWarnings, routeOf } from "../src/log.js";
import type { Logger } from "../src/log.js";
import { API_KEY, BASE_URL, REQUEST_ID, completionBody, errorBody, json, recordSleeps, stubFetch } from "./helpers.js";

const SECRET_WORDS = "my private question about the merger";
const RATE_LIMITED = errorBody("Rate limit exceeded.", "rate_limit_error", "rate_limit_exceeded");

function recorder(): Logger & { lines: string[]; warnings: string[] } {
  const lines: string[] = [];
  const warnings: string[] = [];
  return {
    lines,
    warnings,
    debug: (m) => lines.push(`debug ${m}`),
    info: (m) => lines.push(`info ${m}`),
    warn: (m) => warnings.push(m),
  };
}

let restore: () => void;
beforeEach(() => {
  ({ restore } = recordSleeps());
  resetDeprecationWarnings();
});
afterEach(() => restore());

describe("logging", () => {
  it("info logs each response, never the body or the key", async () => {
    const logger = recorder();
    const { fetch } = stubFetch([json(completionBody())]);
    const c = new MatterWave({ apiKey: API_KEY, baseUrl: BASE_URL, fetch, logLevel: "info", logger });
    await c.chat.completions.create({ messages: [{ role: "user", content: SECRET_WORDS }] });
    expect(logger.lines).toHaveLength(1);
    expect(logger.lines[0]).toMatch(new RegExp(`^info POST /v1/chat/completions -> 200 in \\d+ms request_id=${REQUEST_ID}$`));
    const all = logger.lines.join("\n");
    expect(all).not.toContain(SECRET_WORDS);
    expect(all).not.toContain(API_KEY);
    expect(all).not.toContain("Hello there");
  });

  it("debug adds the attempts and the waits", async () => {
    const logger = recorder();
    const { fetch } = stubFetch([json(RATE_LIMITED, 429, { "Retry-After": "2" }), json(completionBody())]);
    const c = new MatterWave({ apiKey: API_KEY, baseUrl: BASE_URL, fetch, logLevel: "debug", logger });
    await c.chat.completions.create({ messages: [{ role: "user", content: "hi" }] });
    expect(logger.lines[0]).toBe("debug POST /v1/chat/completions attempt 1");
    expect(logger.lines[1]).toMatch(/^info POST \/v1\/chat\/completions -> 429 in \d+ms/);
    expect(logger.lines[2]).toBe("debug POST /v1/chat/completions retrying in 2.00s (attempt 2)");
    expect(logger.lines[3]).toBe("debug POST /v1/chat/completions attempt 2");
    expect(logger.lines[4]).toMatch(/^info POST \/v1\/chat\/completions -> 200 in \d+ms/);
  });

  it("a failed connection is logged by its kind", async () => {
    const logger = recorder();
    const { fetch } = stubFetch([() => new TypeError("fetch failed")]);
    const c = new MatterWave({ apiKey: API_KEY, baseUrl: BASE_URL, fetch, logLevel: "info", logger, maxRetries: 0 });
    await expect(c.me()).rejects.toThrow();
    expect(logger.lines).toEqual([expect.stringMatching(/^info GET \/api\/me failed in \d+ms: TypeError$/)]);
  });

  it("off by default, and MATTERWAVE_LOG sets the level", async () => {
    const logger = recorder();
    const saved = process.env.MATTERWAVE_LOG;
    try {
      delete process.env.MATTERWAVE_LOG;
      const { fetch } = stubFetch([json({ data: [] }), json({ data: [] })]);
      await new MatterWave({ apiKey: API_KEY, baseUrl: BASE_URL, fetch, logger }).keys.list();
      expect(logger.lines).toEqual([]);
      process.env.MATTERWAVE_LOG = "DEBUG";
      await new MatterWave({ apiKey: API_KEY, baseUrl: BASE_URL, fetch, logger }).keys.list();
      expect(logger.lines[0]).toBe("debug GET /api/keys attempt 1");
    } finally {
      if (saved === undefined) delete process.env.MATTERWAVE_LOG;
      else process.env.MATTERWAVE_LOG = saved;
    }
  });

  it("an unknown level is off", () => {
    expect(logLevelOf("loud")).toBe("off");
    expect(logLevelOf(null)).toBe("off");
    expect(logLevelOf(" Info ")).toBe("info");
  });

  it("a withOptions view keeps the level and the logger", async () => {
    const logger = recorder();
    const { fetch } = stubFetch([json({ data: [] })]);
    const c = new MatterWave({ apiKey: API_KEY, baseUrl: BASE_URL, fetch, logLevel: "info", logger });
    await c.withOptions({ timeoutMs: 1_000 }).keys.list();
    expect(logger.lines).toHaveLength(1);
  });
});

describe("deprecation", () => {
  const SUNSET = "Sat, 01 May 2027 00:00:00 GMT";
  const HEADERS = {
    Deprecation: "@1793491200",
    Sunset: SUNSET,
    Link: '<https://docs.example/models>; rel="deprecation"',
  };

  it("a deprecated route warns once, with its dates, whatever the level", async () => {
    const logger = recorder();
    const { fetch } = stubFetch([
      json({ id: "grt-nano", object: "model" }, 200, HEADERS),
      json({ id: "grt-nano", object: "model" }, 200, HEADERS),
      json(errorBody("no", "invalid_request_error", null), 404, HEADERS),
    ]);
    const c = new MatterWave({ apiKey: API_KEY, baseUrl: BASE_URL, fetch, logger });
    await c.models.retrieve("grt-nano");
    await c.models.retrieve("grt-nano");
    await expect(c.models.retrieve("grt-mini")).rejects.toBeInstanceOf(NotFoundError);
    expect(logger.warnings).toEqual([
      "GET /v1/models/{model_id} is deprecated by the MatterWave API (since 2026-11-01); " +
        "it stops answering on 2027-05-01. See https://docs.example/models.",
    ]);
  });

  it("a logger whose warn throws fails the call, for CI that must not call a retiring route", async () => {
    const logger = { ...recorder(), warn: (m: string) => { throw new Error(m); } };
    const { fetch } = stubFetch([json({ id: "grt-nano", object: "model" }, 200, HEADERS)]);
    const c = new MatterWave({ apiKey: API_KEY, baseUrl: BASE_URL, fetch, logger });
    await expect(c.models.retrieve("grt-nano")).rejects.toThrow(/is deprecated by the MatterWave API/);
  });

  it("a route without the headers does not warn", async () => {
    const logger = recorder();
    const { fetch } = stubFetch([json({ data: [] })]);
    await new MatterWave({ apiKey: API_KEY, baseUrl: BASE_URL, fetch, logger }).keys.list();
    expect(logger.warnings).toEqual([]);
  });

  it.each([
    ["@1793491200", " (since 2026-11-01)"],
    ["Sun, 01 Nov 2026 00:00:00 GMT", " (since 2026-11-01)"],
    ["true", ""],
  ])("reads the %s form", (value, expected) => {
    const message = deprecationMessage("GET", "/v1/models", new Headers({ Deprecation: value }));
    expect(message).toBe(`GET /v1/models is deprecated by the MatterWave API${expected}.`);
  });

  it("Deprecation: false and no headers are no warning", () => {
    expect(deprecationMessage("GET", "/v1", new Headers({ Deprecation: "false" }))).toBeNull();
    expect(deprecationMessage("GET", "/v1", new Headers())).toBeNull();
  });

  it("finds the route from a concrete path", () => {
    expect(routeOf("GET", "/v1/models/grt-nano")).toBe("/v1/models/{model_id}");
    expect(routeOf("POST", "/api/conversations/c-1/messages")).toBe("/api/conversations/{conversation_id}/messages");
    expect(routeOf("GET", "/api/not-a-route")).toBe("/api/not-a-route");
  });
});
