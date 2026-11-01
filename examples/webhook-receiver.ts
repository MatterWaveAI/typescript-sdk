/**
 * A webhook receiver: verify each delivery with `webhooks.unwrap`, then act.
 *
 *     MATTERWAVE_WEBHOOK_SECRET=whsec_... npx tsx examples/webhook-receiver.ts 8080
 *
 * `receive` is a fetch-style handler, so it drops into Workers, Deno, Bun or
 * any framework built on `Request`/`Response`; run directly, a small
 * node:http server hands it each POST. Point an endpoint
 * (`client.webhooks.create(...)`) at it through an https tunnel or proxy; the
 * secret is the one `create` returned. `unwrap` checks the signature -- the
 * `MatterWave-Signature` header or the Standard Webhooks ones -- against the
 * raw body before parsing it, and refuses a stale or forged delivery, which
 * this answers 400. Delivery is at least once: dedupe on the event's `id`.
 */

import { createServer } from "node:http";
import { WebhookVerificationError, webhooks } from "../src/index.js";
import { isMain, start } from "./io.js";

const seen = new Set<string>();

export async function receive(request: Request, secret: string, log: (line: string) => void = console.log): Promise<Response> {
  const body = await request.text(); // the raw body, not re-encoded JSON
  let event: Record<string, unknown>;
  try {
    event = await webhooks.unwrap(body, request.headers, secret);
  } catch (error) {
    if (!(error instanceof WebhookVerificationError)) throw error;
    log(`refused: ${error.message}`);
    return new Response(null, { status: 400 });
  }
  const id = String(event.id);
  if (seen.has(id)) {
    log(`${id}: already handled`);
  } else {
    seen.add(id);
    log(`${id}: ${String(event.type)} ${JSON.stringify(event.data)}`);
  }
  return new Response(null, { status: 204 });
}

if (isMain(import.meta.url)) {
  start(async () => {
    const secret = process.env.MATTERWAVE_WEBHOOK_SECRET;
    if (!secret) {
      console.error("Set MATTERWAVE_WEBHOOK_SECRET to the endpoint's signing secret.");
      return 2;
    }
    const port = Number(process.argv[2] ?? 8080);
    createServer(async (incoming, outgoing) => {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(chunk as Buffer);
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) if (typeof value === "string") headers.set(name, value);
      const answer = await receive(
        new Request(`http://localhost${incoming.url ?? "/"}`, { method: "POST", headers, body: Buffer.concat(chunks) }),
        secret,
      );
      outgoing.writeHead(answer.status).end();
    }).listen(port, () => console.log(`listening on :${port}`));
    return new Promise<number>(() => {});
  });
}
