/**
 * The org management resource: the org row and its name, the closure, the
 * model allow-list, the sharing switch and the org's share links, and the
 * SSO configuration -- provider, domains and their DNS proof, and the
 * enforcement switch. Each test answers with the body the route in
 * api/matterwave sends and checks the request the client made.
 */

import { describe, expect, it } from "vitest";
import { MatterWaveConfigError } from "../src/index.js";
import { BASE_URL, client, json, stubFetch } from "./helpers.js";

const DOMAIN = "example.com";

function orgRow(extra: Record<string, unknown> = {}) {
  return { id: "org-01", name: "Acme", created_at: "2026-09-01T09:00:00+00:00", role: "owner", ...extra };
}

function modelPolicy(extra: Record<string, unknown> = {}) {
  return {
    house_model: "grt-nano",
    data: [
      { id: "grt-nano", label: "GRT Nano", partner: false, context_window: 128000, research_preview: false, allowed: true, locked: true },
      { id: "grt-max", label: "GRT Max", partner: true, context_window: 200000, research_preview: false, allowed: false, locked: false },
    ],
    unlisted: [],
    restricted: true,
    ...extra,
  };
}

function domainRow(extra: Record<string, unknown> = {}) {
  return {
    domain: DOMAIN,
    verified: false,
    verified_at: null,
    verified_by: null,
    created_at: "2026-10-30T09:00:00+00:00",
    ...extra,
  };
}

function idpRow(extra: Record<string, unknown> = {}) {
  return {
    provider: "okta",
    kind: "oidc",
    name: "Okta (prod)",
    issuer: "https://acme.okta.com",
    created_at: "2026-10-30T09:00:00+00:00",
    ...extra,
  };
}

describe("org", () => {
  it("reads the org with the caller's role", async () => {
    const { fetch, seen } = stubFetch([json(orgRow())]);
    const org = await client(fetch).org.get();
    expect(seen[0]!.method).toBe("GET");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/org`);
    expect(org.name).toBe("Acme");
    expect(org.role).toBe("owner");
  });

  it("renames the org", async () => {
    const { fetch, seen } = stubFetch([json(orgRow({ name: "Acme Industries" }))]);
    const renamed = await client(fetch).org.rename("Acme Industries");
    expect(seen[0]!.method).toBe("PATCH");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/org`);
    expect(seen[0]!.body).toEqual({ name: "Acme Industries" });
    expect(renamed.name).toBe("Acme Industries");
  });

  it("refuses a blank name before sending", () => {
    const { fetch, calls } = stubFetch([json({})]);
    expect(() => client(fetch).org.rename("  ")).toThrow(MatterWaveConfigError);
    expect(calls()).toBe(0);
  });

  it("closes the org with the typed confirmation", async () => {
    const { fetch, seen } = stubFetch([
      json({
        status: "closed",
        closed_at: "2026-10-31T09:00:00+00:00",
        already_closed: false,
        conversations_deleted: 41,
        retention_days: 90,
        api_keys_revoked: 2,
        invites_revoked: 1,
        invite_links_revoked: 0,
        subscription: "canceled",
        members_mailed: 3,
        members_not_mailed: 0,
        identity_removed: true,
      }),
    ]);
    const closed = await client(fetch).org.close({ confirm: "Acme" });
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/org/close`);
    expect(seen[0]!.body).toEqual({ confirm: "Acme" });
    expect(closed.status).toBe("closed");
    expect(closed.identity_removed).toBe(true);
  });

  it("refuses an empty confirmation before sending", () => {
    const { fetch, calls } = stubFetch([json({})]);
    expect(() => client(fetch).org.close({ confirm: " " })).toThrow(/exactly/);
    expect(calls()).toBe(0);
  });

  it("reads the model allow-list", async () => {
    const { fetch, seen } = stubFetch([json(modelPolicy())]);
    const policy = await client(fetch).org.models();
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/org/models`);
    expect(policy.house_model).toBe("grt-nano");
    expect(policy.data[0]!.locked).toBe(true);
    expect(policy.data[1]!.allowed).toBe(false);
    expect(policy.restricted).toBe(true);
  });

  it("sets the allow-list, null meaning every model the plan permits", async () => {
    const { fetch, seen } = stubFetch([json(modelPolicy({ restricted: false, data: modelPolicy().data.map((m) => ({ ...m, allowed: true })) }))]);
    const saved = await client(fetch).org.setModels(["grt-max"]);
    expect(seen[0]!.method).toBe("PUT");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/org/models`);
    expect(seen[0]!.body).toEqual({ allowed: ["grt-max"] });
    expect(saved.restricted).toBe(false);
  });

  it("refuses an allow-list that is neither a list nor null", () => {
    const { fetch, calls } = stubFetch([json({})]);
    expect(() => client(fetch).org.setModels(5 as unknown as string[])).toThrow(
      MatterWaveConfigError,
    );
    expect(calls()).toBe(0);
  });

  it("reads and sets the sharing switch", async () => {
    const { fetch, seen } = stubFetch([json({ enabled: true }), json({ enabled: false })]);
    const c = client(fetch);
    const got = await c.org.sharing();
    expect(seen[0]!.method).toBe("GET");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/org/sharing`);
    expect(got.enabled).toBe(true);
    const put = await c.org.setSharing(false);
    expect(seen[1]!.method).toBe("PUT");
    expect(seen[1]!.body).toEqual({ enabled: false });
    expect(put.enabled).toBe(false);
  });

  it("lists the org's share links with their creators", async () => {
    const { fetch, seen } = stubFetch([
      json({
        data: [
          {
            id: "shr-01",
            conversation_id: "c-01",
            title: "Weekly notes",
            message_count: 12,
            include_attachments: false,
            created_by: "sub-ada",
            created_at: "2026-10-30T09:00:00+00:00",
            expires_at: null,
            revoked_at: null,
            view_count: 4,
            status: "active",
          },
        ],
      }),
    ]);
    const listed = await client(fetch).org.shares();
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/org/shares`);
    expect(listed.data[0]!.created_by).toBe("sub-ada");
    expect(listed.data[0]!.view_count).toBe(4);
  });

  it("revokes an org share", async () => {
    const { fetch, seen } = stubFetch([json({ status: "revoked" })]);
    const revoked = await client(fetch).org.revokeShare("shr-01");
    expect(seen[0]!.method).toBe("DELETE");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/org/shares/shr-01`);
    expect(revoked.status).toBe("revoked");
  });

  it("reads the SSO settings with the preflight blockers", async () => {
    const { fetch, seen } = stubFetch([json({ sso_required: false, blockers: ["claim and verify a domain"] })]);
    const sso = await client(fetch).org.sso();
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/org/sso`);
    expect(sso.blockers).toHaveLength(1);
  });

  it("enforces SSO and reads the one-time recovery code", async () => {
    const { fetch, seen } = stubFetch([
      json({
        sso_required: true,
        recovery: {
          id: "rc-01",
          created_at: "2026-10-31T09:00:00+00:00",
          expires_at: "2027-10-31T09:00:00+00:00",
          created_by: "sub-ada",
          used_at: null,
          code: "1256-8831",
          shown_once: true,
        },
      }),
    ]);
    const enforced = await client(fetch).org.setSso(true);
    expect(seen[0]!.method).toBe("PUT");
    expect(seen[0]!.body).toEqual({ sso_required: true });
    expect(enforced.sso_required).toBe(true);
    expect(enforced.recovery?.code).toBe("1256-8831");
    expect(enforced.recovery?.shown_once).toBe(true);
  });

  it("relaxes SSO", async () => {
    const { fetch, seen } = stubFetch([json({ sso_required: false })]);
    const relaxed = await client(fetch).org.setSso(false);
    expect(seen[0]!.body).toEqual({ sso_required: false });
    expect(relaxed.sso_required).toBe(false);
  });

  it("mints a fresh recovery code", async () => {
    const { fetch, seen } = stubFetch([
      json({
        recovery: {
          id: "rc-02",
          created_at: "2026-10-31T09:00:00+00:00",
          expires_at: "2027-10-31T09:00:00+00:00",
          created_by: "sub-ada",
          used_at: null,
          code: "4410-9927",
          shown_once: true,
        },
      }),
    ]);
    const minted = await client(fetch).org.mintRecoveryCode();
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/org/sso/recovery-code`);
    expect(minted.recovery.id).toBe("rc-02");
  });

  it("claims a domain, gets its challenge, verifies and releases it", async () => {
    const { fetch, seen } = stubFetch([
      json(domainRow(), 201),
      json({
        record: { type: "TXT", host: "_mw-challenge", name: `_mw-challenge.${DOMAIN}`, value: "mw-verify abc" },
      }),
      json({
        domain: DOMAIN,
        verified: true,
        verified_at: "2026-10-31T09:05:00+00:00",
        verified_by: "sub-ada",
        method: "dns_txt",
        last_checked_at: "2026-10-31T09:05:00+00:00",
        last_error: null,
        record: { type: "TXT", host: "_mw-challenge", name: `_mw-challenge.${DOMAIN}`, value: "mw-verify abc" },
      }),
      new Response(null, { status: 204 }),
    ]);
    const c = client(fetch);
    const claimed = await c.org.domains.claim(DOMAIN);
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/org/domains`);
    expect(seen[0]!.body).toEqual({ domain: DOMAIN });
    expect(claimed.verified).toBe(false);
    const challenge = await c.org.domains.challenge(DOMAIN);
    expect(seen[1]!.url).toBe(`${BASE_URL}/api/org/domains/${DOMAIN}/challenge`);
    expect(challenge.record.type).toBe("TXT");
    expect(challenge.record.name).toBe(`_mw-challenge.${DOMAIN}`);
    const verified = await c.org.domains.verify(DOMAIN);
    expect(seen[2]!.method).toBe("POST");
    expect(verified.verified).toBe(true);
    await c.org.domains.release(DOMAIN);
    expect(seen[3]!.method).toBe("DELETE");
    expect(seen[3]!.url).toBe(`${BASE_URL}/api/org/domains/${DOMAIN}`);
  });

  it("lists the domains", async () => {
    const { fetch, seen } = stubFetch([json({ data: [domainRow(), domainRow({ domain: "other.example", verified: true })] })]);
    const listed = await client(fetch).org.domains.list();
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/org/domains`);
    expect(listed.data).toHaveLength(2);
    expect(listed.data[1]!.verified).toBe(true);
  });

  it("lists the identity providers without their secrets", async () => {
    const { fetch, seen } = stubFetch([json({ data: [idpRow()] })]);
    const listed = await client(fetch).org.idps.list();
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/org/idp`);
    expect(listed.data[0]!.provider).toBe("okta");
    expect(JSON.stringify(listed)).not.toContain("secret");
  });

  it("attaches an OIDC provider", async () => {
    const { fetch, seen } = stubFetch([json(idpRow(), 201)]);
    const attached = await client(fetch).org.idps.attach({
      kind: "oidc",
      name: "Okta (prod)",
      issuer: "https://acme.okta.com",
      client_id: "client-01",
      client_secret: "its-secret",
      scopes: ["openid", "email"],
    });
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/org/idp`);
    expect(seen[0]!.body).toEqual({
      kind: "oidc",
      name: "Okta (prod)",
      issuer: "https://acme.okta.com",
      client_id: "client-01",
      client_secret: "its-secret",
      scopes: ["openid", "email"],
    });
    expect(attached.name).toBe("Okta (prod)");
  });

  it("refuses a bad attach body before sending", () => {
    const { fetch, calls } = stubFetch([json({})]);
    const c = client(fetch);
    expect(() =>
      c.org.idps.attach({ kind: "saml" as "oidc", name: "n", issuer: "https://x", client_id: "c", client_secret: "s" }),
    ).toThrow(/oidc/);
    expect(() =>
      c.org.idps.attach({ kind: "oidc", name: "n", issuer: "http://acme.okta.com", client_id: "c", client_secret: "s" }),
    ).toThrow(/https/);
    expect(() =>
      c.org.idps.attach({ kind: "oidc", name: "n", issuer: "https://acme.okta.com", client_id: "c", client_secret: "" }),
    ).toThrow(/client_secret/);
    expect(calls()).toBe(0);
  });

  it("detaches a provider", async () => {
    const { fetch, seen } = stubFetch([new Response(null, { status: 204 })]);
    await client(fetch).org.idps.detach("okta");
    expect(seen[0]!.method).toBe("DELETE");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/org/idp/okta`);
  });
});
