/**
 * Verifying the webhook deliveries the platform sends, the receiver's half
 * of `client.webhooks` (which manages endpoints but never sees one arrive).
 *
 *     import { webhooks } from "@matterwave/sdk";
 *     const event = await webhooks.unwrap(payload, request.headers, secret);
 *
 * Every delivery is POSTed with `MatterWave-Signature: t=<unix>,v1=<hex>` --
 * the hex HMAC-SHA256, under the endpoint's secret, of `<t>.<body>`: the
 * timestamp is inside the MAC, so a captured delivery cannot be replayed
 * outside the tolerance window. `unwrap` checks that the header parses,
 * that the timestamp is within `toleranceSeconds` of the receiver's clock
 * (300, the platform's window), and that the MAC matches in constant time;
 * any `v1=` element may match, which is what lets a rotated secret verify
 * against either value during a changeover. Only then is the payload
 * decoded: the object is returned, and anything else -- a missing, stale
 * or wrong signature, a body that is not JSON, a body that is not an
 * object -- throws `WebhookVerificationError`.
 *
 * The MAC is WebCrypto (`globalThis.crypto.subtle`), so this module runs
 * wherever the rest of the SDK runs, Node and browsers alike, and the two
 * entry points are async the way the runtimes' own crypto is. `sign` is
 * here too, for tests and for replaying a delivery to a second receiver:
 * it is the exact function the platform's sender runs, and the pair is
 * kept beside each other so a change to the scheme changes both.
 */

import { WebhookVerificationError } from "./errors.js";

/** The header the signed delivery rides in. */
export const SIGNATURE_HEADER = "MatterWave-Signature";
/** The delivery's event id and type, beside the signature for the receiver's logs. */
export const EVENT_ID_HEADER = "MatterWave-Event-Id";
export const EVENT_TYPE_HEADER = "MatterWave-Event-Type";
/**
 * How far a signature's timestamp may be from the receiver's clock before
 * the delivery is refused as a replay. The platform signs with the same
 * number and its docs show the same check.
 */
export const SIGNATURE_TOLERANCE_S = 300;

/** The bytes to sign or verify: a string is read as UTF-8, exactly as the sender wrote it. */
export type Payload = string | Uint8Array;

function bytesOf(payload: Payload): Uint8Array {
  return typeof payload === "string" ? new TextEncoder().encode(payload) : payload;
}

/** The bytes the MAC covers: the timestamp, a dot, and the body. */
export function signedContent(timestamp: number, payload: Payload): Uint8Array {
  return concat(timestamp, payload);
}

function concat(timestamp: number, payload: Payload): Uint8Array {
  const prefix = new TextEncoder().encode(`${timestamp}.`);
  const body = bytesOf(payload);
  const content = new Uint8Array(prefix.length + body.length);
  content.set(prefix, 0);
  content.set(body, prefix.length);
  return content;
}

/** The bytes as an `ArrayBuffer`, which every lib definition accepts where a `BufferSource` is asked for. */
function asBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

async function hmacHex(secret: string, content: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    asBuffer(new TextEncoder().encode(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, asBuffer(content));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The `MatterWave-Signature` value for one delivery, exactly as the platform's sender writes it: `t=<unix>,v1=<hex HMAC-SHA256>`. */
export async function sign(secret: string, timestamp: number, payload: Payload): Promise<string> {
  const mac = await hmacHex(secret, concat(timestamp, payload));
  return `t=${timestamp},v1=${mac}`;
}

/** A header map: the `Headers` a fetch handler sees, or a plain record. */
export type HeadersLike = Headers | Record<string, string>;

export function signatureHeaderValue(headers: HeadersLike): string | null {
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    return headers.get(SIGNATURE_HEADER);
  }
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === SIGNATURE_HEADER.toLowerCase()) return value;
  }
  return null;
}

/** Constant-time on equal-length strings: one bit of `diff` per position, so the loop cannot end early on a matching prefix. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface VerifyOptions {
  /** Pins the clock, in seconds since the epoch; the default is now. */
  now?: number;
  /** The replay window in seconds; the default is 300. */
  toleranceSeconds?: number;
}

/** True when `payload` carries a fresh, correct signature under `secret`. Constant-time on the MAC; any `v1=` element may match, which is what lets a rotated secret be verified against either value during a changeover. */
export async function verifySignature(
  secret: string,
  headers: HeadersLike,
  payload: Payload,
  options: VerifyOptions = {},
): Promise<boolean> {
  const header = signatureHeaderValue(headers);
  if (!header) return false;
  let timestamp: number | null = null;
  const candidates: string[] = [];
  for (const element of header.split(",")) {
    const trimmed = element.trim();
    const eq = trimmed.indexOf("=");
    if (eq === -1) return false;
    const key = trimmed.slice(0, eq);
    const value = trimmed.slice(eq + 1);
    if (key === "t") {
      const parsed = Number(value);
      if (!Number.isInteger(parsed)) return false;
      timestamp = parsed;
    } else if (key === "v1") {
      candidates.push(value);
    }
  }
  if (timestamp === null || candidates.length === 0) return false;
  const now = options.now ?? Date.now() / 1000;
  if (Math.abs(now - timestamp) > (options.toleranceSeconds ?? SIGNATURE_TOLERANCE_S)) {
    return false;
  }
  const expected = await hmacHex(secret, concat(timestamp, payload));
  return candidates.some((candidate) => timingSafeEqual(expected, candidate));
}

/** Verify the delivery, then decode it: the event as an object. `WebhookVerificationError` for a missing, malformed, stale or wrong signature -- the reason is the message -- and for a body that is not a JSON object. The signature is checked before the body is parsed, so a forged delivery is never handed to the caller's code. */
export async function unwrap<T = Record<string, unknown>>(
  payload: Payload,
  headers: HeadersLike,
  secret: string,
  options: VerifyOptions = {},
): Promise<T> {
  const verified = await verifySignature(secret, headers, payload, options);
  if (!verified) {
    throw new WebhookVerificationError(
      "The webhook signature is missing, stale or wrong; the delivery is refused.",
    );
  }
  const text = typeof payload === "string" ? payload : new TextDecoder().decode(payload);
  let event: unknown;
  try {
    event = JSON.parse(text);
  } catch {
    throw new WebhookVerificationError("The signed delivery is not JSON.");
  }
  if (typeof event !== "object" || event === null || Array.isArray(event)) {
    throw new WebhookVerificationError(
      `The signed delivery is JSON but not an object, got ${Array.isArray(event) ? "array" : typeof event}.`,
    );
  }
  return event as T;
}

/** The two entry points, namespaced for `import { webhooks } from "@matterwave/sdk"`. */
export const webhooks = {
  SIGNATURE_HEADER,
  EVENT_ID_HEADER,
  EVENT_TYPE_HEADER,
  SIGNATURE_TOLERANCE_S,
  sign,
  verifySignature,
  unwrap,
};
