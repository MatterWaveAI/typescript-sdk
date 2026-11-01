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
 * Every delivery also carries the Standard Webhooks headers
 * (standardwebhooks.com): `webhook-id` (the event id), `webhook-timestamp`
 * and `webhook-signature: v1,<base64>`, the HMAC-SHA256 of
 * `<id>.<timestamp>.<body>` keyed by the base64 after the secret's `whsec_`
 * marker, one space-separated signature per secret in force.
 * `verifyStandardSignature` checks those; `unwrap` accepts a delivery when
 * either scheme's signature verifies, so a receiver behind a proxy that
 * keeps only one set of headers still unwraps it.
 *
 * The MAC is WebCrypto (`globalThis.crypto.subtle`), so this module runs
 * wherever the rest of the SDK runs, Node and browsers alike, and the entry
 * points are async the way the runtimes' own crypto is. `sign` and
 * `signStandard` are here too, for tests and for replaying a delivery to a
 * second receiver: they are the exact functions the platform's sender runs,
 * and each is kept beside its check so a change to the scheme changes both.
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
/** The Standard Webhooks headers, sent beside the MatterWave ones. */
export const STANDARD_ID_HEADER = "webhook-id";
export const STANDARD_TIMESTAMP_HEADER = "webhook-timestamp";
export const STANDARD_SIGNATURE_HEADER = "webhook-signature";
/** The marker in front of every signing secret the platform mints. */
export const SECRET_PREFIX = "whsec_";

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

async function hmac(key: Uint8Array, content: Uint8Array): Promise<Uint8Array> {
  const imported = await crypto.subtle.importKey(
    "raw",
    asBuffer(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, asBuffer(content)));
}

async function hmacHex(secret: string, content: Uint8Array): Promise<string> {
  const mac = await hmac(new TextEncoder().encode(secret), content);
  return [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const NOT_BASE64 = /[^A-Za-z0-9+/]/g;

/**
 * The HMAC key the Standard Webhooks signature uses: the base64 after
 * `whsec_`. Secrets minted before the platform switched to standard base64
 * are URL-safe base64, which decodes the same once its two characters are
 * mapped. `TypeError` for a secret whose length no base64 can have.
 */
export function secretKeyBytes(secret: string): Uint8Array {
  const body = secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret;
  const standard = body.replace(/-/g, "+").replace(/_/g, "/").replace(NOT_BASE64, "");
  if (standard.length % 4 === 1) {
    throw new TypeError("The webhook secret is not base64 after its whsec_ marker.");
  }
  const binary = atob(standard + "=".repeat((4 - (standard.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

/** One `webhook-signature` element, exactly as the platform's sender writes it: `v1,<base64 HMAC-SHA256 of "<id>.<timestamp>.<body>">`. */
export async function signStandard(
  secret: string,
  msgId: string,
  timestamp: number,
  payload: Payload,
): Promise<string> {
  const prefix = new TextEncoder().encode(`${msgId}.${timestamp}.`);
  const body = bytesOf(payload);
  const content = new Uint8Array(prefix.length + body.length);
  content.set(prefix, 0);
  content.set(body, prefix.length);
  return `v1,${base64(await hmac(secretKeyBytes(secret), content))}`;
}

/** The `MatterWave-Signature` value for one delivery, exactly as the platform's sender writes it: `t=<unix>,v1=<hex HMAC-SHA256>`. */
export async function sign(secret: string, timestamp: number, payload: Payload): Promise<string> {
  const mac = await hmacHex(secret, concat(timestamp, payload));
  return `t=${timestamp},v1=${mac}`;
}

/** A header map: the `Headers` a fetch handler sees, or a plain record. */
export type HeadersLike = Headers | Record<string, string>;

function headerValue(headers: HeadersLike, wanted: string): string | null {
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    return headers.get(wanted);
  }
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === wanted.toLowerCase()) return value;
  }
  return null;
}

export function signatureHeaderValue(headers: HeadersLike): string | null {
  return headerValue(headers, SIGNATURE_HEADER);
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

/**
 * True when `payload` carries a fresh, correct Standard Webhooks signature
 * under `secret`: `webhook-id`, `webhook-timestamp` and `webhook-signature`
 * all present, the timestamp within the tolerance of the clock, and any
 * `v1,` element of the signature matching in constant time (one per secret
 * in force during a rotation). What a Standard Webhooks library does with
 * the three headers.
 */
export async function verifyStandardSignature(
  secret: string,
  headers: HeadersLike,
  payload: Payload,
  options: VerifyOptions = {},
): Promise<boolean> {
  const msgId = headerValue(headers, STANDARD_ID_HEADER);
  const rawTimestamp = headerValue(headers, STANDARD_TIMESTAMP_HEADER);
  const header = headerValue(headers, STANDARD_SIGNATURE_HEADER);
  if (!msgId || !rawTimestamp || !header) return false;
  const timestamp = Number(rawTimestamp);
  if (!Number.isInteger(timestamp)) return false;
  const now = options.now ?? Date.now() / 1000;
  if (Math.abs(now - timestamp) > (options.toleranceSeconds ?? SIGNATURE_TOLERANCE_S)) {
    return false;
  }
  let expected: string;
  try {
    expected = (await signStandard(secret, msgId, timestamp, payload)).slice("v1,".length);
  } catch {
    return false;
  }
  return header.split(" ").some((element) => {
    const comma = element.indexOf(",");
    if (comma === -1 || element.slice(0, comma) !== "v1") return false;
    return timingSafeEqual(expected, element.slice(comma + 1));
  });
}

/**
 * Verify the delivery, then decode it: the event as an object. The delivery
 * is accepted when its `MatterWave-Signature` or its Standard Webhooks
 * signature verifies under `secret`; the platform sends both.
 * `WebhookVerificationError` for a missing, malformed, stale or wrong
 * signature -- the reason is the message -- and for a body that is not a
 * JSON object. The signature is checked before the body is parsed, so a
 * forged delivery is never handed to the caller's code.
 */
export async function unwrap<T = Record<string, unknown>>(
  payload: Payload,
  headers: HeadersLike,
  secret: string,
  options: VerifyOptions = {},
): Promise<T> {
  const verified =
    (await verifySignature(secret, headers, payload, options)) ||
    (await verifyStandardSignature(secret, headers, payload, options));
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
  STANDARD_ID_HEADER,
  STANDARD_TIMESTAMP_HEADER,
  STANDARD_SIGNATURE_HEADER,
  SECRET_PREFIX,
  sign,
  signStandard,
  secretKeyBytes,
  verifySignature,
  verifyStandardSignature,
  unwrap,
};
