/**
 * The members, invites and invite-links resources: the roster and roles,
 * the mailed invites, the invite links, and the join that redeems either. Each test answers with
 * the body the route in api/matterwave sends and checks the request the
 * client made.
 */

import { describe, expect, it } from "vitest";
import { MatterWaveConfigError } from "../src/index.js";
import { API_KEY, BASE_URL, REQUEST_ID, client, json, stubFetch } from "./helpers.js";

const SUBJECT = "sub-ada-01";
const INVITE_ID = "inv-0001";
const LINK_ID = "lnk-0001";
const TOKEN = "join-token-01";

function memberRow(extra: Record<string, unknown> = {}) {
  return {
    subject: SUBJECT,
    email: "ada@example.com",
    name: "Ada Lovelace",
    role: "admin",
    state: "active",
    created_at: "2026-09-01T09:00:00+00:00",
    last_seen_at: "2026-10-31T08:00:00+00:00",
    ...extra,
  };
}

function inviteRow(extra: Record<string, unknown> = {}) {
  return {
    id: INVITE_ID,
    email: "grace@example.com",
    role: "member",
    invited_by: SUBJECT,
    created_at: "2026-10-30T09:00:00+00:00",
    expires_at: "2026-11-06T09:00:00+00:00",
    status: "pending",
    ...extra,
  };
}

function linkRow(extra: Record<string, unknown> = {}) {
  return {
    id: LINK_ID,
    role: "member",
    max_uses: 10,
    uses: 3,
    created_by: SUBJECT,
    created_at: "2026-10-30T09:00:00+00:00",
    expires_at: "2026-11-06T09:00:00+00:00",
    status: "active",
    ...extra,
  };
}

describe("members", () => {
  it("lists the roster with the caller's role and the seats", async () => {
    const { fetch, seen } = stubFetch([
      json({
        data: [memberRow(), memberRow({ subject: "sub-grace", email: "grace@example.com", role: "member", last_seen_at: null })],
        role: "admin",
        seats: { used: 2, max: 5, billed: null },
      }),
    ]);
    const listed = await client(fetch).members.list();
    expect(seen[0]!.method).toBe("GET");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/org/members`);
    expect(listed.role).toBe("admin");
    expect(listed.seats).toEqual({ used: 2, max: 5, billed: null });
    expect(listed.data[1]!.last_seen_at).toBeNull();
    expect(listed.requestId).toBe(REQUEST_ID);
  });

  it("sets a role", async () => {
    const { fetch, seen } = stubFetch([json(memberRow({ role: "viewer" }))]);
    const updated = await client(fetch).members.setRole(SUBJECT, "viewer");
    expect(seen[0]!.method).toBe("PUT");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/org/members/${SUBJECT}/role`);
    expect(seen[0]!.body).toEqual({ role: "viewer" });
    expect(updated.role).toBe("viewer");
  });

  it("refuses a role the org does not have before sending", () => {
    const { fetch, calls } = stubFetch([json({})]);
    expect(() => client(fetch).members.setRole(SUBJECT, "supreme leader" as "admin")).toThrow(
      /must be one of owner, admin, member, viewer/,
    );
    expect(calls()).toBe(0);
  });

  it("transfers ownership in one step", async () => {
    const { fetch, seen } = stubFetch([json(memberRow({ role: "owner" }))]);
    const transferred = await client(fetch).members.transferOwnership(SUBJECT);
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/org/members/${SUBJECT}/transfer-ownership`);
    expect(transferred.role).toBe("owner");
  });

  it("removes a member with a 204", async () => {
    const { fetch, seen } = stubFetch([new Response(null, { status: 204 })]);
    await client(fetch).members.remove(SUBJECT);
    expect(seen[0]!.method).toBe("DELETE");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/org/members/${SUBJECT}`);
  });

  it("lists the invites", async () => {
    const { fetch, seen } = stubFetch([json({ data: [inviteRow()] })]);
    const listed = await client(fetch).invites.list();
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/org/invites`);
    expect(listed.data[0]!.status).toBe("pending");
  });

  it("creates an invite and reads whether the mail went", async () => {
    const { fetch, seen } = stubFetch([
      json(inviteRow({ mail: "sent" }), 201),
    ]);
    const created = await client(fetch).invites.create("grace@example.com", { role: "admin" });
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/org/invites`);
    expect(seen[0]!.body).toEqual({ email: "grace@example.com", role: "admin" });
    expect(created.mail).toBe("sent");
  });

  it("defaults the invite role to member", async () => {
    const { fetch, seen } = stubFetch([json(inviteRow({ mail: "failed", detail: "resend it." }), 201)]);
    const created = await client(fetch).invites.create("grace@example.com");
    expect(seen[0]!.body).toEqual({ email: "grace@example.com", role: "member" });
    expect(created.mail).toBe("failed");
  });

  it("refuses an invite without an address before sending", () => {
    const { fetch, calls } = stubFetch([json({})]);
    expect(() => client(fetch).invites.create("no-at-sign")).toThrow(
      /email address/,
    );
    expect(calls()).toBe(0);
  });

  it("resends and revokes an invite", async () => {
    const { fetch, seen } = stubFetch([
      json(inviteRow({ mail: "sent" })),
      new Response(null, { status: 204 }),
    ]);
    const c = client(fetch);
    const resent = await c.invites.resend(INVITE_ID);
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/org/invites/${INVITE_ID}/resend`);
    expect(resent.mail).toBe("sent");
    await c.invites.revoke(INVITE_ID);
    expect(seen[1]!.method).toBe("DELETE");
    expect(seen[1]!.url).toBe(`${BASE_URL}/api/org/invites/${INVITE_ID}`);
  });

  it("looks an invite up anonymously -- no key is sent", async () => {
    const { fetch, seen } = stubFetch([
      json({
        org_name: "Acme",
        email: "grace@example.com",
        role: "member",
        expires_at: "2026-11-06T09:00:00+00:00",
        status: "pending",
      }),
    ]);
    const preview = await client(fetch).invites.lookup(TOKEN);
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/org/invites/lookup`);
    expect(seen[0]!.body).toEqual({ token: TOKEN });
    expect(seen[0]!.headers.Authorization).toBeUndefined();
    expect(preview.org_name).toBe("Acme");
    expect(preview.requestId).toBe(REQUEST_ID);
  });

  it("accepts an invite with the key", async () => {
    const { fetch, seen } = stubFetch([json(memberRow())]);
    const joined = await client(fetch).invites.accept(TOKEN);
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/org/invites/accept`);
    expect(seen[0]!.body).toEqual({ token: TOKEN });
    expect(seen[0]!.headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(joined.subject).toBe(SUBJECT);
  });

  it("lists the invite links", async () => {
    const { fetch, seen } = stubFetch([json({ data: [linkRow()] })]);
    const listed = await client(fetch).inviteLinks.list();
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/org/invite-links`);
    expect(listed.data[0]!.uses).toBe(3);
  });

  it("creates a link and reads the token and url once", async () => {
    const { fetch, seen } = stubFetch([
      json({ ...linkRow(), token: TOKEN, url: `https://matterwave.test/join/${TOKEN}` }, 201),
    ]);
    const created = await client(fetch).inviteLinks.create({
      role: "admin",
      max_uses: 25,
      expires_in_days: 14,
    });
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/org/invite-links`);
    expect(seen[0]!.body).toEqual({ role: "admin", max_uses: 25, expires_in_days: 14 });
    expect(created.token).toBe(TOKEN);
    expect(created.url).toContain("/join/");
  });

  it("defaults the link to a member role, ten uses, seven days", async () => {
    const { fetch, seen } = stubFetch([json({ ...linkRow(), token: TOKEN, url: "u" }, 201)]);
    await client(fetch).inviteLinks.create();
    expect(seen[0]!.body).toEqual({ role: "member", max_uses: 10, expires_in_days: 7 });
  });

  it("refuses an owner link and out-of-range bounds before sending", () => {
    const { fetch, calls } = stubFetch([json({})]);
    const c = client(fetch);
    expect(() => c.inviteLinks.create({ role: "owner" })).toThrow(/never granted by link/);
    expect(() => c.inviteLinks.create({ max_uses: 501 })).toThrow(/max_uses must be 1 to 500/);
    expect(() => c.inviteLinks.create({ expires_in_days: 31 })).toThrow(
      /expires_in_days must be 1 to 30/,
    );
    expect(calls()).toBe(0);
  });

  it("revokes a link", async () => {
    const { fetch, seen } = stubFetch([new Response(null, { status: 204 })]);
    await client(fetch).inviteLinks.revoke(LINK_ID);
    expect(seen[0]!.method).toBe("DELETE");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/org/invite-links/${LINK_ID}`);
  });

  it("looks a join link up anonymously", async () => {
    const { fetch, seen } = stubFetch([
      json({
        org_name: "Acme",
        role: "member",
        expires_at: "2026-11-06T09:00:00+00:00",
        status: "active",
      }),
    ]);
    const preview = await client(fetch).inviteLinks.lookup(TOKEN);
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/join/lookup`);
    expect(seen[0]!.headers.Authorization).toBeUndefined();
    expect(preview.status).toBe("active");
  });

  it("joins through a link with the key", async () => {
    const { fetch, seen } = stubFetch([json(memberRow())]);
    const joined = await client(fetch).inviteLinks.join(TOKEN);
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/join`);
    expect(seen[0]!.headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(joined.role).toBe("admin");
  });

  it("refuses an empty token before sending", () => {
    const { fetch, calls } = stubFetch([json({})]);
    const c = client(fetch);
    expect(() => c.invites.lookup("")).toThrow(MatterWaveConfigError);
    expect(() => c.invites.accept("")).toThrow(MatterWaveConfigError);
    expect(() => c.inviteLinks.lookup("")).toThrow(MatterWaveConfigError);
    expect(() => c.inviteLinks.join("")).toThrow(MatterWaveConfigError);
    expect(calls()).toBe(0);
  });
});
