/**
 * The receiver's half of webhooks: `webhooks.unwrap` against signatures the
 * platform's own scheme produces (`t=<unix>,v1=<hex HMAC-SHA256>` over
 * `<t>.<body>`), and the refusals: tampered bodies, stale timestamps,
 * missing and malformed headers.
 */

import { describe, expect, expectTypeOf, it } from "vitest";
import {
  SIGNATURE_TOLERANCE_S,
  WebhookVerificationError,
  webhooks,
} from "../src/index.js";

const SECRET = "whsec_test_secret";
const BODY = JSON.stringify({ id: "evt_1", event: "message.completed", data: { n: 1 } });
const NOW = 1_800_000_000;

function headersWith(signature: string): Record<string, string> {
  return {
    "MatterWave-Signature": signature,
    "MatterWave-Event-Id": "evt_1",
    "MatterWave-Event-Type": "message.completed",
  };
}

describe("webhooks signature verification", () => {
  it("unwraps a valid delivery to the event", async () => {
    const header = await webhooks.sign(SECRET, NOW, BODY);
    const event = await webhooks.unwrap(BODY, headersWith(header), SECRET, { now: NOW });
    expect(event).toEqual({ id: "evt_1", event: "message.completed", data: { n: 1 } });
    expect(
      await webhooks.verifySignature(SECRET, headersWith(header), BODY, { now: NOW }),
    ).toBe(true);
  });

  it("finds the header whichever case the framework handed over", async () => {
    const header = await webhooks.sign(SECRET, NOW, BODY);
    const lowered = Object.fromEntries(
      Object.entries(headersWith(header)).map(([k, v]) => [k.toLowerCase(), v]),
    );
    expect((await webhooks.unwrap(BODY, lowered, SECRET, { now: NOW })).id).toBe("evt_1");
    const asHeaders = new Headers(headersWith(header));
    expect(await webhooks.unwrap(BODY, asHeaders, SECRET, { now: NOW })).toHaveProperty("id");
  });

  it("refuses a tampered body", async () => {
    const header = await webhooks.sign(SECRET, NOW, BODY);
    const tampered = BODY.replace('"n":1', '"n":9999');
    expect(tampered).not.toBe(BODY);
    expect(
      await webhooks.verifySignature(SECRET, headersWith(header), tampered, { now: NOW }),
    ).toBe(false);
    await expect(
      webhooks.unwrap(tampered, headersWith(header), SECRET, { now: NOW }),
    ).rejects.toThrow(WebhookVerificationError);
  });

  it("refuses the wrong secret", async () => {
    const header = await webhooks.sign("whsec_other", NOW, BODY);
    await expect(
      webhooks.unwrap(BODY, headersWith(header), SECRET, { now: NOW }),
    ).rejects.toThrow(WebhookVerificationError);
  });

  it("refuses a stale timestamp and accepts one inside the window", async () => {
    const stale = await webhooks.sign(SECRET, NOW - SIGNATURE_TOLERANCE_S - 1, BODY);
    await expect(
      webhooks.unwrap(BODY, headersWith(stale), SECRET, { now: NOW }),
    ).rejects.toThrow(/missing, stale or wrong/);
    const fresh = await webhooks.sign(SECRET, NOW - SIGNATURE_TOLERANCE_S + 30, BODY);
    expect(await webhooks.verifySignature(SECRET, headersWith(fresh), BODY, { now: NOW })).toBe(
      true,
    );
  });

  it("refuses a timestamp too far in the future", async () => {
    const ahead = await webhooks.sign(SECRET, NOW + 400, BODY);
    await expect(
      webhooks.unwrap(BODY, headersWith(ahead), SECRET, { now: NOW }),
    ).rejects.toThrow(WebhookVerificationError);
  });

  it("refuses a missing header", async () => {
    await expect(
      webhooks.unwrap(BODY, { "MatterWave-Event-Id": "evt_1" }, SECRET, { now: NOW }),
    ).rejects.toThrow(/missing, stale or wrong/);
    expect(await webhooks.verifySignature(SECRET, {}, BODY, { now: NOW })).toBe(false);
  });

  it.each([
    "",
    `v1=${"0".repeat(64)}`,
    `t=${NOW}`,
    `t=not-a-number,v1=${"0".repeat(64)}`,
    "garbage",
    `t=${NOW},v1=zzzz`,
  ])("refuses the malformed header %j", async (header) => {
    expect(await webhooks.verifySignature(SECRET, headersWith(header), BODY, { now: NOW })).toBe(
      false,
    );
    await expect(
      webhooks.unwrap(BODY, headersWith(header), SECRET, { now: NOW }),
    ).rejects.toThrow(WebhookVerificationError);
  });

  it("accepts a delivery signed by either secret during a rotation", async () => {
    const oldMac = await webhooks.sign(SECRET, NOW, BODY);
    const newMac = await webhooks.sign("whsec_rotated", NOW, BODY);
    const header = `${oldMac},${newMac.slice("t=1800000000,".length)}`;
    expect((await webhooks.unwrap(BODY, headersWith(header), "whsec_rotated", { now: NOW })).id).toBe("evt_1");
    await expect(
      webhooks.unwrap(BODY, headersWith(header), "whsec_third", { now: NOW }),
    ).rejects.toThrow(WebhookVerificationError);
  });

  it("refuses a body that is not JSON after verifying it", async () => {
    const body = "<html>not json</html>";
    const header = await webhooks.sign(SECRET, NOW, body);
    await expect(
      webhooks.unwrap(body, headersWith(header), SECRET, { now: NOW }),
    ).rejects.toThrow(/not JSON/);
  });

  it("refuses a body that is JSON but not an object", async () => {
    const body = "[1, 2, 3]";
    const header = await webhooks.sign(SECRET, NOW, body);
    await expect(
      webhooks.unwrap(body, headersWith(header), SECRET, { now: NOW }),
    ).rejects.toThrow(/not an object/);
  });

  it("writes the scheme the platform sends", async () => {
    const header = await webhooks.sign(SECRET, NOW, BODY);
    expect(header).toMatch(new RegExp(`^t=${NOW},v1=[0-9a-f]{64}$`));
  });

  it("widens the tolerance for a slow receiver", async () => {
    const old = await webhooks.sign(SECRET, NOW - 600, BODY);
    expect(
      await webhooks.verifySignature(SECRET, headersWith(old), BODY, {
        now: NOW,
        toleranceSeconds: 700,
      }),
    ).toBe(true);
  });

  it("types the unwrapped event", async () => {
    const header = await webhooks.sign(SECRET, NOW, BODY);
    const event = await webhooks.unwrap(BODY, headersWith(header), SECRET, { now: NOW });
    expectTypeOf(event).toEqualTypeOf<Record<string, unknown>>();
  });
});

// The Standard Webhooks specification's own test vector, which the platform's
// sender is tested against too.
const STD_SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const STD_ID = "msg_p5jXN8AQM9LWM0D4loKWxJek";
const STD_T = 1614265330;
const STD_BODY = '{"test": 2432232314}';
const STD_SIGNATURE = "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=";

function standardHeaders(signature: string, msgId = STD_ID, timestamp = STD_T): Record<string, string> {
  return { "webhook-id": msgId, "webhook-timestamp": String(timestamp), "webhook-signature": signature };
}

describe("Standard Webhooks verification", () => {
  it("signs the specification's vector", async () => {
    expect(await webhooks.signStandard(STD_SECRET, STD_ID, STD_T, STD_BODY)).toBe(STD_SIGNATURE);
  });

  it("verifies the vector and refuses each kind of mismatch", async () => {
    const verify = webhooks.verifyStandardSignature;
    const headers = standardHeaders(STD_SIGNATURE);
    expect(await verify(STD_SECRET, headers, STD_BODY, { now: STD_T + 1 })).toBe(true);
    expect(await verify(STD_SECRET, headers, `${STD_BODY} `, { now: STD_T + 1 })).toBe(false);
    expect(await verify(STD_SECRET, headers, STD_BODY, { now: STD_T + 301 })).toBe(false);
    expect(await verify(STD_SECRET, headers, STD_BODY, { now: STD_T + 301, toleranceSeconds: 600 })).toBe(true);
    expect(await verify(`whsec_${"A".repeat(32)}`, headers, STD_BODY, { now: STD_T })).toBe(false);
    expect(await verify(STD_SECRET, standardHeaders(STD_SIGNATURE, "msg_other"), STD_BODY, { now: STD_T })).toBe(false);
    expect(await verify(STD_SECRET, standardHeaders(`v2,${STD_SIGNATURE.slice(3)}`), STD_BODY, { now: STD_T })).toBe(false);
    expect(await verify(STD_SECRET, { ...headers, "webhook-timestamp": "soon" }, STD_BODY, { now: STD_T })).toBe(false);
    for (const missing of ["webhook-id", "webhook-timestamp", "webhook-signature"]) {
      const partial = Object.fromEntries(Object.entries(headers).filter(([name]) => name !== missing));
      expect(await verify(STD_SECRET, partial, STD_BODY, { now: STD_T })).toBe(false);
    }
  });

  it("lets any v1 element of a rotation match, from a Headers object too", async () => {
    const other = await webhooks.signStandard(`whsec_${"B".repeat(32)}`, STD_ID, STD_T, STD_BODY);
    const headers = new Headers(standardHeaders(`${other} ${STD_SIGNATURE}`));
    expect(await webhooks.verifyStandardSignature(STD_SECRET, headers, STD_BODY, { now: STD_T })).toBe(true);
  });

  it("decodes a legacy URL-safe secret", async () => {
    const legacy = `whsec_${"-_".repeat(21)}A`;
    expect(webhooks.secretKeyBytes(legacy)).toHaveLength(32);
    const signature = await webhooks.signStandard(legacy, STD_ID, STD_T, STD_BODY);
    expect(await webhooks.verifyStandardSignature(legacy, standardHeaders(signature), STD_BODY, { now: STD_T })).toBe(true);
  });

  it("matches the Python SDK's key for the same secret", () => {
    expect([...webhooks.secretKeyBytes("whsec_known_answer")]).toEqual([
      ...Uint8Array.from(atob("known/answer"), (c) => c.charCodeAt(0)),
    ]);
  });

  it("unwraps a delivery that carries only the standard headers", async () => {
    const signature = await webhooks.signStandard(SECRET, "evt_1", NOW, BODY);
    const event = await webhooks.unwrap(BODY, standardHeaders(signature, "evt_1", NOW), SECRET, { now: NOW });
    expect(event.id).toBe("evt_1");
  });

  it("unwraps the platform's delivery carrying both schemes", async () => {
    const headers = {
      ...headersWith(await webhooks.sign(SECRET, NOW, BODY)),
      ...standardHeaders(await webhooks.signStandard(SECRET, "evt_1", NOW, BODY), "evt_1", NOW),
    };
    expect((await webhooks.unwrap(BODY, headers, SECRET, { now: NOW })).id).toBe("evt_1");
  });

  it("refuses a standard signature under another secret", async () => {
    const signature = await webhooks.signStandard(`whsec_${"C".repeat(32)}`, "evt_1", NOW, BODY);
    await expect(
      webhooks.unwrap(BODY, standardHeaders(signature, "evt_1", NOW), SECRET, { now: NOW }),
    ).rejects.toThrow(/missing, stale or wrong/);
  });
});
