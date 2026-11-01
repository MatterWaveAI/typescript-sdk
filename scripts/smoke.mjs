// A smoke test of the built package in whatever runtime loads it: Node,
// Bun and Deno run this file (`node scripts/smoke.mjs`, `bun ...`,
// `deno run ...`), a browser loads scripts/smoke.html, which imports it.
// No network: a stand-in fetch answers. It exercises what differs between
// runtimes -- fetch and Response, the Web Crypto behind idempotency keys and
// webhook signatures, the environment read -- and says "ok" or throws.

import { MatterWave, MatterWaveConfigError, webhooks } from "../dist/index.js";

const BASE_URL = "https://matterwave.test";

function answer(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", "X-Request-Id": "req-smoke" },
  });
}

function check(condition, what) {
  if (!condition) throw new Error(`smoke: ${what}`);
}

export async function smoke() {
  const sent = [];
  const fetch = async (url, init) => {
    sent.push({ url, init });
    if (url.endsWith("/v1")) return answer({ object: "api", api_version: "v1" });
    return answer({
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 0,
      model: "m",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
    });
  };
  const browser = typeof globalThis.document !== "undefined";
  if (browser) {
    let refused = false;
    try {
      new MatterWave({ apiKey: "mw_smoke", baseUrl: BASE_URL, fetch });
    } catch (error) {
      refused = error instanceof MatterWaveConfigError;
    }
    check(refused, "a key in a browser is refused without dangerouslyAllowBrowser");
  }
  const client = new MatterWave({ apiKey: "mw_smoke", baseUrl: BASE_URL, fetch, dangerouslyAllowBrowser: true });

  const index = await client.index();
  check(index.api_version === "v1" && index.requestId === "req-smoke", "index() reads the answer and its request id");

  const completion = await client.chat.completions.create({ messages: [{ role: "user", content: "hi" }] });
  check(completion.choices[0].message.content === "hi", "chat.completions.create parses the completion");
  const key = sent[sent.length - 1].init.headers["Idempotency-Key"];
  check(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(key), "a write carries a UUID key");

  const body = JSON.stringify({ id: "evt_1", type: "ping" });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await webhooks.sign("whsec_smoke", timestamp, body);
  const event = await webhooks.unwrap(body, { [webhooks.SIGNATURE_HEADER]: signature }, "whsec_smoke");
  check(event.type === "ping", "a signed webhook verifies with Web Crypto");

  return "ok";
}

const direct = typeof globalThis.document === "undefined";
if (direct) {
  await smoke();
  console.log("smoke ok");
}
