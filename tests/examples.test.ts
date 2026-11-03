/**
 * Every example in examples/ runs: each one's `run` is called against the
 * stubbed fetch with the answers its routes give, and what it prints and
 * returns is checked. Importing them here is also what puts them under the
 * compiler.
 */

import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run as chat } from "../examples/chat.js";
import { run as deviceSignIn } from "../examples/device-sign-in.js";
import type { Io } from "../examples/io.js";
import { run as pagination } from "../examples/pagination.js";
import { run as piRpc } from "../examples/pi-rpc.js";
import { run as streaming } from "../examples/streaming.js";
import { run as structuredOutput } from "../examples/structured-output.js";
import { receive } from "../examples/webhook-receiver.js";
import { BASE_URL, chunk, client, completionBody, json, recordSleeps, sse, stubFetch } from "./helpers.js";

function capture(): Io & { out: string; err: string } {
  const io = { out: "", err: "", write: (text: string) => void (io.out += text), error: (line: string) => void (io.err += `${line}\n`) };
  return io;
}

let restore: () => void;
beforeEach(() => {
  ({ restore } = recordSleeps());
});
afterEach(() => restore());

describe("the examples", () => {
  it("chat prints the answer and its tokens", async () => {
    const io = capture();
    expect(await chat(client(stubFetch([json(completionBody("Hello there."))]).fetch), "hi", io)).toBe(0);
    expect(io.out).toBe("Hello there.\n[grt-nano: 50 tokens]\n");
  });

  it("chat reports a refusal", async () => {
    const refusal = json({ error: { message: "bad key", type: "invalid_request_error", code: "x" } }, 401);
    const io = capture();
    expect(await chat(client(stubFetch([refusal]).fetch), "hi", io)).toBe(1);
    expect(io.err).toContain("failed: 401");
  });

  it("streaming prints as it goes, then the finish reason and usage", async () => {
    const body =
      chunk({ role: "assistant", content: "" }) +
      chunk({ content: "Rivers " }) +
      chunk({ content: "run." }) +
      chunk({}, "stop") +
      chunk(null, null, { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 }) +
      "data: [DONE]\n\n";
    const { fetch, seen } = stubFetch([sse([body])]);
    const io = capture();
    expect(await streaming(client(fetch), "haiku", io)).toBe(0);
    expect(io.out).toBe("Rivers run.\n[stop: 7 in, 3 out]\n");
    expect((seen[0]!.body as { stream_options: unknown }).stream_options).toEqual({ include_usage: true });
  });

  it("structured output prints the validated recipe", async () => {
    const recipe = { name: "Pancakes", minutes: 20, ingredients: ["flour", "milk", "eggs"] };
    const io = capture();
    expect(await structuredOutput(client(stubFetch([json(completionBody(JSON.stringify(recipe)))]).fetch), "pancakes", io)).toBe(0);
    expect(io.out).toBe("Pancakes (20 min): flour, milk, eggs\n");
  });

  it("structured output refuses an answer that is not a recipe", async () => {
    const io = capture();
    expect(await structuredOutput(client(stubFetch([json(completionBody('{"name": 3}'))]).fetch), "pancakes", io)).toBe(1);
    expect(io.err).toContain("not a recipe");
  });

  it("the webhook receiver takes a signed delivery once and refuses a forged one", async () => {
    const secret = "whsec_example";
    const body = JSON.stringify({ id: "evt_9", type: "ping", data: { n: 1 } });
    const t = Math.floor(Date.now() / 1000);
    const mac = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
    const delivery = (payload: string) =>
      new Request("http://localhost/hook", { method: "POST", headers: { "MatterWave-Signature": `t=${t},v1=${mac}` }, body: payload });
    const lines: string[] = [];
    const log = (line: string) => void lines.push(line);
    expect((await receive(delivery(body), secret, log)).status).toBe(204);
    expect((await receive(delivery(body), secret, log)).status).toBe(204);
    expect((await receive(delivery(`${body} `), secret, log)).status).toBe(400);
    expect(lines.slice(0, 2)).toEqual(['evt_9: ping {"n":1}', "evt_9: already handled"]);
    expect(lines[2]).toMatch(/^refused:/);
  });

  it("device sign-in with a key acts as the person it signed in", async () => {
    const { fetch, seen } = stubFetch([
      json({ device_code: "dc", user_code: "ABCD-1234", verification_uri: `${BASE_URL}/device`, expires_in: 600, interval: 5 }),
      json({ access_token: "mw_new_key", token_type: "Bearer", scopes: ["chat:read"] }),
      json({ subject: "u-1", kind: "user", email: "a@example.test", org_role: "member" }),
    ]);
    const io = capture();
    expect(await deviceSignIn({ baseUrl: BASE_URL, fetch }, "key", io)).toBe(0);
    expect(io.out).toContain("enter ABCD-1234");
    expect(io.out).toContain("signed in as a@example.test (member)");
    expect(seen[2]!.headers.Authorization).toBe("Bearer mw_new_key");
  });

  it("device sign-in as a person carries the person's token", async () => {
    const issuer = "https://auth.matterwave.test";
    const { fetch, seen } = stubFetch([
      json({
        auth_mode: "oidc",
        token_endpoint: `${issuer}/oauth/v2/token`,
        scopes: ["openid"],
        native_client_id: "native",
        issuer_device_authorization_endpoint: `${issuer}/oauth/v2/device_authorization`,
      }),
      json({ device_code: "dc", user_code: "WXYZ-9876", verification_uri: `${issuer}/device`, expires_in: 300, interval: 5 }),
      json({ access_token: "person-at", expires_in: 3600, refresh_token: "rt" }),
      json({ subject: "u-1", kind: "user", email: "o@example.test", org_role: "owner" }),
    ]);
    const io = capture();
    expect(await deviceSignIn({ baseUrl: BASE_URL, fetch }, "person", io)).toBe(0);
    expect(io.out).toContain("signed in as o@example.test (owner)");
    expect(seen[3]!.headers.Authorization).toBe("Bearer person-at");
  });

  it("device sign-in reports a declined code", async () => {
    const { fetch } = stubFetch([
      json({ device_code: "dc", user_code: "C", verification_uri: "u", interval: 5 }),
      json({ error: "access_denied" }, 400),
    ]);
    const io = capture();
    expect(await deviceSignIn({ baseUrl: BASE_URL, fetch }, "key", io)).toBe(1);
    expect(io.err).toContain("not signed in: access_denied");
  });

  it("pagination counts, stops early and walks a list generically", async () => {
    const page = (ids: string[], cursor: string | null, filter: string) =>
      json({ data: ids.map((id) => ({ id, title: `T${id}` })), filter, next_cursor: cursor });
    const hits = json({
      data: Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, title: `Invoice ${i}`, snippet: "", message_id: null })),
      query: "invoice",
      next_cursor: "more",
    });
    const { fetch, seen } = stubFetch([
      page(["a1", "a2"], "c2", "archived"),
      page(["a3"], null, "archived"),
      hits,
      page(["p1"], null, "pinned"),
    ]);
    const io = capture();
    expect(await pagination(client(fetch), "invoice", io)).toBe(0);
    const lines = io.out.trimEnd().split("\n");
    expect(lines[0]).toBe("archived conversations: 3");
    expect(lines.slice(1, 6)).toEqual([0, 1, 2, 3, 4].map((i) => `match: Invoice ${i}`));
    expect(lines[6]).toBe("pinned: Tp1");
    expect(seen.filter((s) => s.url.includes("/api/search"))).toHaveLength(1);
  });

  it("pi-rpc builds the provider config, registers the extension, and streams a prompt over JSONL RPC", async () => {
    const models = () =>
      json({
        object: "list",
        data: [
          { id: "grt-1", object: "model", created: 1700000000, owned_by: "matterwave" },
          { id: "grt-1-mini", object: "model", created: 1700000000, owned_by: "matterwave" },
        ],
      });
    const { fetch } = stubFetch([models(), models()]);
    const script = `
      const readline = require("node:readline");
      const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
      const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
      rl.on("line", (line) => {
        if (!line.trim()) return;
        const cmd = JSON.parse(line);
        if (cmd.type === "get_state") {
          send({
            id: cmd.id,
            type: "response",
            command: "get_state",
            success: true,
            data: { sessionId: "sess_1", isStreaming: false, isCompacting: false, messageCount: 0, pendingMessageCount: 0 },
          });
        } else if (cmd.type === "prompt") {
          send({ id: cmd.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } });
          send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hello " } });
          send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "from Pi." } });
          send({ type: "agent_end", messages: [] });
        }
      });
    `;
    const io = capture();
    const code = await piRpc(client(fetch), "Summarize src/index.ts", io, {
      presetId: "preset_1",
      temporary: true,
      rpc: { command: process.execPath, args: ["-e", script] },
    });
    expect(code).toBe(0);
    expect(io.out).toBe(
      `[provider: ${BASE_URL}/v1 (2 models, commands: preset, temporary)]\nHello from Pi.\n[session sess_1: grt-1]\n`,
    );
  });
});
