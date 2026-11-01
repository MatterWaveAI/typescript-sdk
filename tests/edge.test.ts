/**
 * The edge pairing and sync resource: an admin mints a pairing code and
 * manages the devices, a box redeems the code anonymously for its key,
 * and that key pushes conversations and reads the sync status. Each test
 * answers with the body the route in api/matterwave sends and checks the
 * request the client made.
 */

import { describe, expect, it } from "vitest";
import { MatterWaveConfigError } from "../src/index.js";
import { API_KEY, BASE_URL, REQUEST_ID, client, json, stubFetch } from "./helpers.js";

const DEVICE_KEY_ID = "key-edge-01";

function deviceRow(extra: Record<string, unknown> = {}) {
  return {
    id: DEVICE_KEY_ID,
    prefix: "mw_ed12",
    name: "Edge: shelf-box",
    kind: "device",
    scopes: ["conversations:import"],
    created_at: "2026-10-31T09:00:00+00:00",
    expires_at: null,
    revoked_at: null,
    last_used_at: null,
    rotated_at: null,
    previous_prefix: null,
    previous_valid_until: null,
    allowed_cidrs: null,
    rpm_limit: null,
    box_name: "shelf-box",
    ...extra,
  };
}

function pushBody() {
  return {
    conversation: {
      id: "c0ffee00-0000-4000-8000-000000000042",
      title: "Mirror of the morning",
      created_at: "2026-10-31T07:00:00+00:00",
      updated_at: "2026-10-31T07:30:00+00:00",
      messages: [
        {
          id: "m-1",
          conversation_id: "c0ffee00-0000-4000-8000-000000000042",
          role: "user",
          parts: [{ type: "text", text: "hello from the edge" }],
          created_at: "2026-10-31T07:00:00+00:00",
          origin: { device_id: "dev-01", model: "grt-nano" },
        },
      ],
    },
    device_id: "dev-01",
  };
}

describe("edge", () => {
  it("mints a pairing code", async () => {
    const { fetch, seen } = stubFetch([
      json(
        { code: "ABCD-EFGH-JKLM", name: "shelf-box", expires_in: 600, expires_at: "2026-10-31T09:10:00+00:00" },
        201,
      ),
    ]);
    const minted = await client(fetch).sync.mintPairingCode({ name: "shelf-box" });
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/sync/pairings`);
    expect(seen[0]!.body).toEqual({ name: "shelf-box" });
    expect(minted.code).toBe("ABCD-EFGH-JKLM");
    expect(minted.expires_in).toBe(600);
  });

  it("refuses an unnamed box before sending", () => {
    const { fetch, calls } = stubFetch([json({})]);
    expect(() => client(fetch).sync.mintPairingCode({ name: "  " })).toThrow(/Name the box/);
    expect(calls()).toBe(0);
  });

  it("lists the paired boxes with their names", async () => {
    const { fetch, seen } = stubFetch([json({ data: [deviceRow()] })]);
    const listed = await client(fetch).sync.devices();
    expect(seen[0]!.method).toBe("GET");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/sync/devices`);
    expect(listed.data[0]!.box_name).toBe("shelf-box");
    expect(listed.data[0]!.scopes).toEqual(["conversations:import"]);
  });

  it("unpairs a box with a 204", async () => {
    const { fetch, seen } = stubFetch([new Response(null, { status: 204 })]);
    await client(fetch).sync.unpair(DEVICE_KEY_ID);
    expect(seen[0]!.method).toBe("DELETE");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/sync/devices/${DEVICE_KEY_ID}`);
  });

  it("redeems a code anonymously and reads the key once", async () => {
    const { fetch, seen } = stubFetch([
      json({ key: "mw_edge_secret", key_id: DEVICE_KEY_ID, name: "shelf-box", scopes: ["conversations:import"] }),
    ]);
    const granted = await client(fetch).sync.pair({ code: "ABCD-EFGH-JKLM", device_id: "dev-01" });
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/sync/pair`);
    expect(seen[0]!.body).toEqual({ code: "ABCD-EFGH-JKLM", device_id: "dev-01" });
    expect(seen[0]!.headers.Authorization).toBeUndefined();
    expect(granted.key).toBe("mw_edge_secret");
    expect(granted.scopes).toEqual(["conversations:import"]);
  });

  it("refuses an empty code before sending", () => {
    const { fetch, calls } = stubFetch([json({})]);
    expect(() => client(fetch).sync.pair({ code: "" })).toThrow(MatterWaveConfigError);
    expect(calls()).toBe(0);
  });

  it("reads the sync status", async () => {
    const { fetch, seen } = stubFetch([
      json({
        box: true,
        paired: true,
        device_id: "dev-01",
        platform_url: "https://matterwave.test",
        name: "shelf-box",
        paired_at: "2026-10-31T09:00:00+00:00",
        last_synced_at: "2026-10-31T09:05:00+00:00",
        last_attempt_at: "2026-10-31T09:05:00+00:00",
        offline: false,
        pending: 0,
        pending_messages: 0,
        pending_capped: false,
        stopped: null,
        last_error: null,
        skipped: 0,
        skipped_recent: 0,
        next_attempt_at: null,
      }),
    ]);
    const status = await client(fetch).sync.status();
    expect(seen[0]!.method).toBe("GET");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/sync/status`);
    expect(status.paired).toBe(true);
    expect(status.pending_messages).toBe(0);
    expect(status.requestId).toBe(REQUEST_ID);
  });

  it("reads an unpaired platform answer", async () => {
    const { fetch } = stubFetch([json({ box: false, paired: false })]);
    const status = await client(fetch).sync.status();
    expect(status.box).toBe(false);
    expect(status.paired).toBe(false);
  });

  it("pushes a conversation with the device key and defaults the envelope", async () => {
    const { fetch, seen } = stubFetch([
      json({ conversation_id: "c0ffee00-0000-4000-8000-000000000042", accepted: 1, updated: 0, already_present: 0, rejected: [] }),
    ]);
    const outcome = await client(fetch).sync.push(pushBody());
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/sync/conversations`);
    expect(seen[0]!.headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(seen[0]!.body).toEqual({
      format_version: 1,
      source: "edge",
      device_id: "dev-01",
      conversation: pushBody().conversation,
    });
    expect(outcome.accepted).toBe(1);
    expect(outcome.rejected).toEqual([]);
  });

  it("refuses a foreign message id and an unknown format version before sending", () => {
    const { fetch, calls } = stubFetch([json({})]);
    const c = client(fetch);
    const body = pushBody();
    body.conversation.messages![0]!.conversation_id = "another-conversation";
    expect(() => c.sync.push(body)).toThrow(/conversation_id must be the conversation's id/);
    expect(() => c.sync.push({ ...pushBody(), format_version: 2 })).toThrow(/format_version must be 1/);
    expect(() => c.sync.push({ conversation: { id: "", created_at: "x", updated_at: "y" } })).toThrow(
      /conversation must have an id/,
    );
    expect(calls()).toBe(0);
  });
});
