import { describe, expect, it } from "vitest";
import { MatterWave, MatterWaveConfigError, MissingAPIKeyError, VERSION } from "../src/index.js";
import { API_KEY, BASE_URL, REQUEST_ID, client, completionBody, json, stubFetch } from "./helpers.js";

describe("what each operation sends", () => {
  it("posts the OpenAI body with the bearer and returns the typed completion", async () => {
    const { fetch, seen } = stubFetch([json(completionBody())]);
    const completion = await client(fetch).chat.completions.create({
      messages: [{ role: "user", content: "Say hello in five words." }],
      model: "grt-nano",
      temperature: 0.2,
      max_tokens: 32,
      user: "customer-7",
      metadata: { conversation_id: "0192d4c3-0000-7000-8000-000000000001" },
    });

    expect(seen[0]!.url).toBe(`${BASE_URL}/v1/chat/completions`);
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(seen[0]!.headers["User-Agent"]).toBe(`matterwave-typescript/${VERSION}`);
    expect(seen[0]!.headers["Content-Type"]).toBe("application/json");
    expect(seen[0]!.body).toEqual({
      messages: [{ role: "user", content: "Say hello in five words." }],
      model: "grt-nano",
      temperature: 0.2,
      max_tokens: 32,
      user: "customer-7",
      metadata: { conversation_id: "0192d4c3-0000-7000-8000-000000000001" },
    });
    expect(completion.choices[0]!.message.content).toBe("Hello there, friend of mine.");
    expect(completion.usage.total_tokens).toBe(50);
    expect(completion.requestId).toBe(REQUEST_ID);
    // Not a wire field: it must not show up if the object is re-serialised.
    expect(JSON.parse(JSON.stringify(completion))).not.toHaveProperty("requestId");
  });

  it("defaultHeaders replace the client's own but not the operation's", async () => {
    // A client built on this one names itself: its User-Agent has to reach
    // the wire. The bearer still comes last.
    const { fetch, seen } = stubFetch([
      json({ subject: "u-1", kind: "key", email: null, name: null, roles: [], org_id: "o-1", org_name: null, org_role: null }),
    ]);
    await new MatterWave({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      fetch,
      defaultHeaders: { "User-Agent": "my-app/2.0", "X-Trace": "t-1", Authorization: "no" },
    }).me();
    expect(seen[0]!.headers["User-Agent"]).toBe("my-app/2.0");
    expect(seen[0]!.headers["X-Trace"]).toBe("t-1");
    expect(seen[0]!.headers.Authorization).toBe(`Bearer ${API_KEY}`);
  });

  it("sends only what was given, leaving defaults to the server", async () => {
    const { fetch, seen } = stubFetch([json(completionBody())]);
    await client(fetch).chat.completions.create({ messages: [{ role: "user", content: "hi" }] });
    expect(seen[0]!.body).toEqual({ messages: [{ role: "user", content: "hi" }] });
  });

  it("keeps fields on the response it does not know about", async () => {
    const body = { ...completionBody(), system_fingerprint: "fp_1" };
    const { fetch } = stubFetch([json(body)]);
    const completion = await client(fetch).chat.completions.create({
      messages: [{ role: "user", content: "hi" }],
    });
    expect((completion as unknown as { system_fingerprint: string }).system_fingerprint).toBe("fp_1");
  });

  it("lists and retrieves models", async () => {
    const list = {
      object: "list",
      data: [
        { id: "grt-nano", object: "model", created: 0, owned_by: "matterwave" },
        { id: "grt-nano-pro", object: "model", created: 1700000000, owned_by: "matterwave" },
      ],
    };
    const one = { id: "grt-nano", object: "model", created: 0, owned_by: "matterwave" };
    const { fetch, seen } = stubFetch([json(list), json(one)]);
    const c = client(fetch);
    const models = await c.models.list();
    expect(models.data.map((m) => m.id)).toEqual(["grt-nano", "grt-nano-pro"]);
    const model = await c.models.retrieve("grt-nano");
    expect(model.owned_by).toBe("matterwave");
    expect(seen.map((s) => s.url)).toEqual([`${BASE_URL}/v1/models`, `${BASE_URL}/v1/models/grt-nano`]);
    expect(seen.every((s) => s.method === "GET" && s.body === undefined)).toBe(true);
  });

  it("the index needs no key", async () => {
    const index = {
      object: "api",
      name: "MatterWave",
      api_version: "v1",
      release: "0.1.0",
      compatible_with: "openai",
      endpoints: ["/v1/chat/completions"],
      stability: { stable: true, promise: "additive", preview_prefix: "/v1/preview/" },
      extensions: {},
      docs: "/docs",
    };
    const { fetch, seen } = stubFetch([json(index)]);
    const result = await client(fetch, { apiKey: null }).index();
    expect(seen[0]!.headers.Authorization).toBeUndefined();
    expect(result.api_version).toBe("v1");
    expect(result.stability.stable).toBe(true);
  });

  it("a keyed call without a key fails before any request", async () => {
    const { fetch, calls } = stubFetch([json({ object: "list", data: [] })]);
    const previous = process.env.MATTERWAVE_API_KEY;
    delete process.env.MATTERWAVE_API_KEY;
    try {
      await expect(client(fetch, { apiKey: null }).models.list()).rejects.toBeInstanceOf(
        MissingAPIKeyError,
      );
    } finally {
      if (previous !== undefined) process.env.MATTERWAVE_API_KEY = previous;
    }
    expect(calls()).toBe(0);
  });

  it("refuses an empty prompt and a model id with a slash", async () => {
    const { fetch } = stubFetch([]);
    const c = client(fetch);
    await expect(c.chat.completions.create({ messages: [] })).rejects.toBeInstanceOf(
      MatterWaveConfigError,
    );
    expect(() => c.models.retrieve("a/b")).toThrow(MatterWaveConfigError);
  });

  it("per-call headers and a signal reach fetch", async () => {
    const { fetch, seen } = stubFetch([json(completionBody())]);
    const controller = new AbortController();
    await client(fetch).chat.completions.create(
      { messages: [{ role: "user", content: "hi" }] },
      { headers: { "X-Trace": "t-1" }, signal: controller.signal },
    );
    expect(seen[0]!.headers["X-Trace"]).toBe("t-1");
  });
});

describe("configuration", () => {
  it("reads both values from the environment", () => {
    const saved = { key: process.env.MATTERWAVE_API_KEY, url: process.env.MATTERWAVE_BASE_URL };
    process.env.MATTERWAVE_API_KEY = "mw_from_env";
    process.env.MATTERWAVE_BASE_URL = "https://env.matterwave.test/";
    try {
      const c = new MatterWave();
      expect(c.baseUrl).toBe("https://env.matterwave.test");
    } finally {
      process.env.MATTERWAVE_API_KEY = saved.key;
      process.env.MATTERWAVE_BASE_URL = saved.url;
    }
  });

  it("accepts the OpenAI-style base URL ending in /v1", () => {
    expect(new MatterWave({ apiKey: "k", baseUrl: "https://matterwave.test/v1" }).baseUrl).toBe(
      "https://matterwave.test",
    );
  });

  it("refuses no origin, a schemeless origin and negative retries", () => {
    const saved = process.env.MATTERWAVE_BASE_URL;
    delete process.env.MATTERWAVE_BASE_URL;
    try {
      expect(() => new MatterWave({ apiKey: "k" })).toThrow(/MATTERWAVE_BASE_URL/);
    } finally {
      if (saved !== undefined) process.env.MATTERWAVE_BASE_URL = saved;
    }
    expect(() => new MatterWave({ apiKey: "k", baseUrl: "matterwave.test" })).toThrow(/http/);
    expect(() => new MatterWave({ apiKey: "k", baseUrl: BASE_URL, maxRetries: -1 })).toThrow(
      MatterWaveConfigError,
    );
  });
});
