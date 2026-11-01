/**
 * The organisation clients against the fake API, signed in as a person:
 * `org` (with `org.domains` and `org.idps`), `members`, `invites`,
 * `inviteLinks`, billing administration and the device-login decisions.
 * Reads first, then writes; each test answers with the body the platform's
 * route sends and checks the request the client made and what came back.
 */

import { describe, expect, it } from "vitest";
import { ConflictError, MatterWave, MatterWaveConfigError, type Fetch } from "../src/index.js";
import { BASE_URL, REQUEST_ID, json, stubFetch } from "./helpers.js";

const TOKEN = "person-token";
const MEMBER = {
  subject: "u-2",
  email: "b@example.test",
  name: null,
  role: "member",
  state: "active",
  created_at: "2026-10-01T00:00:00+00:00",
  last_seen_at: null,
};
const INVITE = {
  id: "inv-1",
  email: "c@example.test",
  role: "member",
  invited_by: "u-1",
  created_at: "2026-10-31T00:00:00+00:00",
  expires_at: "2026-11-07T00:00:00+00:00",
  status: "pending",
};
const LINK = {
  id: "lnk-1",
  role: "member",
  max_uses: 10,
  uses: 0,
  created_by: "u-1",
  created_at: "2026-10-31T00:00:00+00:00",
  expires_at: "2026-11-07T00:00:00+00:00",
  status: "active",
};
const RECOVERY = {
  id: "rc-1",
  created_at: "2026-10-31T00:00:00+00:00",
  expires_at: "2026-11-03T00:00:00+00:00",
  created_by: "u-1",
  used_at: null,
  code: "BREAK-GLASS-SECRET",
  shown_once: true,
};
const DOMAIN = {
  domain: "example.test",
  verified: false,
  verified_at: null,
  verified_by: null,
  created_at: "2026-10-31T00:00:00+00:00",
};
const RECORD = {
  type: "TXT",
  host: "_matterwave-verify",
  name: "_matterwave-verify.example.test",
  value: "matterwave-domain-verification=abc",
};

function person(fetch: Fetch): MatterWave {
  return new MatterWave({ accessToken: TOKEN, baseUrl: BASE_URL, fetch });
}

function anonymous(fetch: Fetch): MatterWave {
  return new MatterWave({ apiKey: null, baseUrl: BASE_URL, fetch });
}

function route(url: string): string {
  return url.slice(BASE_URL.length);
}

function noContent(): Response {
  return new Response(null, { status: 204, headers: { "X-Request-Id": REQUEST_ID } });
}

// --- reads ---------------------------------------------------------------------

describe("reads", () => {
  it("the org, its members, invites and links", async () => {
    const { fetch, seen } = stubFetch([
      json({ id: "org-1", name: "Acme", created_at: "2026-01-01", role: "owner" }),
      json({ data: [MEMBER], role: "owner", seats: { used: 2, max: 5, billed: 5 } }),
      json({ data: [INVITE] }),
      json({ data: [LINK] }),
    ]);
    const c = person(fetch);
    const org = await c.org.get();
    expect([org.name, org.requestId]).toEqual(["Acme", REQUEST_ID]);
    expect(seen[0]!.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    const members = await c.members.list();
    expect(members.data.map((m) => m.email)).toEqual(["b@example.test"]);
    expect([members.role, members.seats.used, members.seats.max]).toEqual(["owner", 2, 5]);
    expect((await c.invites.list()).data.map((i) => i.status)).toEqual(["pending"]);
    const links = await c.inviteLinks.list();
    expect([links.data[0]!.token, links.data[0]!.uses]).toEqual([undefined, 0]);
    expect(seen.map((s) => `${s.method} ${route(s.url)}`)).toEqual([
      "GET /api/org",
      "GET /api/org/members",
      "GET /api/org/invites",
      "GET /api/org/invite-links",
    ]);
  });

  it("the org's policies", async () => {
    const { fetch, seen } = stubFetch([
      json({
        house_model: "grt-nano",
        data: [
          {
            id: "grt-nano",
            label: "GRT Nano",
            partner: false,
            context_window: 32768,
            research_preview: false,
            allowed: true,
            locked: true,
          },
        ],
        unlisted: [],
        restricted: false,
      }),
      json({ enabled: true }),
      json({
        data: [
          {
            id: "sh-1",
            conversation_id: "c-1",
            title: "Plan",
            message_count: 4,
            include_attachments: false,
            created_at: "2026-10-01",
            expires_at: null,
            revoked_at: null,
            view_count: 3,
            status: "active",
            created_by: "u-2",
          },
        ],
      }),
      json({ sso_required: false, blockers: ["no idp"] }),
      json({ mfa_required: true }),
    ]);
    const c = person(fetch);
    const policy = await c.org.models();
    expect([policy.data[0]!.locked, policy.restricted]).toEqual([true, false]);
    expect((await c.org.sharing()).enabled).toBe(true);
    expect((await c.org.shares()).data[0]!.view_count).toBe(3);
    const sso = await c.org.sso();
    expect([sso.sso_required, sso.blockers, sso.recovery]).toEqual([false, ["no idp"], undefined]);
    expect((await c.org.mfa()).mfa_required).toBe(true);
    expect(seen.map((s) => route(s.url))).toEqual([
      "/api/org/models",
      "/api/org/sharing",
      "/api/org/shares",
      "/api/org/sso",
      "/api/org/mfa",
    ]);
  });

  it("domains, identity providers and billing", async () => {
    const { fetch, seen } = stubFetch([
      json({ data: [DOMAIN] }),
      json({ record: RECORD }),
      json({
        data: [{ provider: "okta", kind: "oidc", name: "Okta", issuer: "https://acme.okta.test", created_at: "2026-10-01" }],
      }),
      json({
        data: [
          {
            id: "in_1",
            number: "A-1",
            status: "paid",
            collection_method: "charge_automatically",
            currency: "usd",
            amount_due_micros: 49_000_000,
            amount_remaining_micros: 0,
            due_at: null,
            paid_at: "2026-10-02",
            hosted_invoice_url: "https://invoice.example.test/in_1",
            invoice_pdf: null,
            issued_at: "2026-10-01",
            dispute_status: null,
          },
        ],
      }),
      json({
        data: [
          {
            from_plan: null,
            to_plan: "team",
            from_status: null,
            to_status: "active",
            kind: "checkout",
            actor: "stripe:evt_1",
            reason: null,
            metadata: { seats: 5 },
            created_at: "2026-10-01",
          },
        ],
      }),
    ]);
    const c = person(fetch);
    expect((await c.org.domains.list()).data.map((d) => d.domain)).toEqual(["example.test"]);
    expect((await c.org.domains.challenge("example.test")).record.host).toBe("_matterwave-verify");
    expect((await c.org.idps.list()).data[0]!.provider).toBe("okta");
    expect((await c.billing.invoices()).data[0]!.amount_due_micros).toBe(49_000_000);
    expect((await c.billing.planHistory()).data[0]!.metadata).toEqual({ seats: 5 });
    expect(seen.map((s) => route(s.url))).toEqual([
      "/api/org/domains",
      "/api/org/domains/example.test/challenge",
      "/api/org/idp",
      "/api/billing/invoices",
      "/api/plan/history",
    ]);
  });

  it("the device a code belongs to", async () => {
    const { fetch, seen } = stubFetch([json({ user_code: "ABCD-EFGH", client_name: "matterwave-tui", expires_in: 480 })]);
    const found = await person(fetch).auth.device.lookup("abcdefgh");
    expect([found.client_name, found.expires_in]).toEqual(["matterwave-tui", 480]);
    expect([seen[0]!.method, route(seen[0]!.url)]).toEqual(["POST", "/api/auth/device/lookup"]);
    expect(seen[0]!.body).toEqual({ user_code: "abcdefgh" });
    expect(seen[0]!.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(() => person(fetch).auth.device.lookup("")).toThrow(MatterWaveConfigError);
  });
});

// --- writes --------------------------------------------------------------------

describe("writes", () => {
  it("rename and close the org", async () => {
    const { fetch, seen } = stubFetch([
      json({ id: "org-1", name: "Acme Ltd", created_at: "x", role: "owner" }),
      json({
        status: "closed",
        closed_at: "2026-10-31",
        already_closed: false,
        conversations_deleted: 12,
        retention_days: 30,
        api_keys_revoked: 2,
        invites_revoked: 1,
        invite_links_revoked: 0,
        subscription: "cancelled",
        members_mailed: 3,
        members_not_mailed: 0,
        identity_removed: true,
      }),
    ]);
    const c = person(fetch);
    expect((await c.org.rename("Acme Ltd")).name).toBe("Acme Ltd");
    expect([seen[0]!.method, route(seen[0]!.url), seen[0]!.body]).toEqual(["PATCH", "/api/org", { name: "Acme Ltd" }]);
    const closed = await c.org.close({ confirm: "Acme Ltd" });
    expect([seen[1]!.method, route(seen[1]!.url), seen[1]!.body]).toEqual(["POST", "/api/org/close", { confirm: "Acme Ltd" }]);
    expect([closed.conversations_deleted, closed.subscription]).toEqual([12, "cancelled"]);
    expect(() => c.org.rename("  ")).toThrow(MatterWaveConfigError);
  });

  it("change a member's role, transfer ownership and remove a member", async () => {
    const { fetch, seen } = stubFetch([json({ ...MEMBER, role: "admin" }), json({ ...MEMBER, role: "owner" }), noContent()]);
    const c = person(fetch);
    expect((await c.members.setRole("u-2", "admin")).role).toBe("admin");
    expect(seen[0]!.body).toEqual({ role: "admin" });
    expect((await c.members.transferOwnership("u-2")).role).toBe("owner");
    await expect(c.members.remove("u-2")).resolves.toBeUndefined();
    expect(seen.map((s) => `${s.method} ${route(s.url)}`)).toEqual([
      "PUT /api/org/members/u-2/role",
      "POST /api/org/members/u-2/transfer-ownership",
      "DELETE /api/org/members/u-2",
    ]);
    expect(() => c.members.setRole("u-2", "superuser" as "admin")).toThrow(/role must be one of/);
  });

  it("leaving the org without an owner is the server's conflict", async () => {
    const { fetch } = stubFetch([json({ detail: "An organization must keep at least one owner." }, 409)]);
    const error = await person(fetch).members.setRole("u-1", "member").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as Error).message).toMatch(/at least one owner/);
  });

  it("invites: create, resend, revoke, look up without a credential, accept", async () => {
    const { fetch, seen } = stubFetch([
      json({ ...INVITE, mail: "sent" }, 201),
      json({ ...INVITE, mail: "failed", detail: "resend it" }),
      noContent(),
      json({ org_name: "Acme", email: "c@example.test", role: "member", expires_at: "x", status: "pending" }),
      json(MEMBER),
      json({ ...INVITE, mail: "sent" }, 201),
    ]);
    const c = person(fetch);
    const invite = await c.invites.create("c@example.test", { role: "viewer" });
    expect(seen[0]!.body).toEqual({ email: "c@example.test", role: "viewer" });
    expect(invite.mail).toBe("sent");
    const resent = await c.invites.resend("inv-1");
    expect([resent.mail, resent.detail]).toEqual(["failed", "resend it"]);
    await c.invites.revoke("inv-1");
    expect((await anonymous(fetch).invites.lookup("tok")).org_name).toBe("Acme");
    expect(seen[3]!.headers.Authorization).toBeUndefined();
    expect(seen[3]!.body).toEqual({ token: "tok" });
    expect((await c.invites.accept("tok")).subject).toBe("u-2");
    expect(seen[4]!.body).toEqual({ token: "tok" });
    expect(seen[4]!.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    await c.invites.create("c@example.test");
    expect(seen[5]!.body).toEqual({ email: "c@example.test", role: "member" });
    expect(seen.map((s) => `${s.method} ${route(s.url)}`)).toEqual([
      "POST /api/org/invites",
      "POST /api/org/invites/inv-1/resend",
      "DELETE /api/org/invites/inv-1",
      "POST /api/org/invites/lookup",
      "POST /api/org/invites/accept",
      "POST /api/org/invites",
    ]);
    expect(() => c.invites.create("not-an-email")).toThrow(MatterWaveConfigError);
    expect(() => c.invites.lookup("")).toThrow(/1 to 256 characters/);
  });

  it("invite links: create shows the token once, revoke, look up without a credential, join", async () => {
    const { fetch, seen } = stubFetch([
      json({ ...LINK, token: "link-secret", url: "https://app.test/join?link=link-secret" }, 201),
      noContent(),
      json({ org_name: "Acme", role: "member", expires_at: "x", status: "active" }),
      json(MEMBER),
    ]);
    const c = person(fetch);
    const link = await c.inviteLinks.create({ role: "viewer", max_uses: 3, expires_in_days: 2 });
    expect(seen[0]!.body).toEqual({ role: "viewer", max_uses: 3, expires_in_days: 2 });
    expect([link.token, link.url]).toEqual(["link-secret", "https://app.test/join?link=link-secret"]);
    await c.inviteLinks.revoke("lnk-1");
    expect((await anonymous(fetch).inviteLinks.lookup("t")).status).toBe("active");
    expect(seen[2]!.headers.Authorization).toBeUndefined();
    expect((await c.inviteLinks.join("t")).role).toBe("member");
    expect(seen[3]!.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(seen.map((s) => `${s.method} ${route(s.url)}`)).toEqual([
      "POST /api/org/invite-links",
      "DELETE /api/org/invite-links/lnk-1",
      "POST /api/join/lookup",
      "POST /api/join",
    ]);
    expect(() => c.inviteLinks.create({ role: "owner" })).toThrow(/never granted by link/);
    expect(() => c.inviteLinks.create({ max_uses: 0 })).toThrow(/max_uses/);
    expect(() => c.inviteLinks.create({ expires_in_days: 31 })).toThrow(/expires_in_days/);
  });

  it("invite links default to a member, ten uses and seven days", async () => {
    const { fetch, seen } = stubFetch([json({ ...LINK, token: "t", url: "u" }, 201)]);
    await person(fetch).inviteLinks.create();
    expect(seen[0]!.body).toEqual({ role: "member", max_uses: 10, expires_in_days: 7 });
  });

  it("the org's policies", async () => {
    const restricted = { house_model: "grt-nano", data: [], unlisted: [], restricted: true };
    const { fetch, seen } = stubFetch([
      json(restricted),
      json({ ...restricted, restricted: false }),
      json({ enabled: false }),
      json({ status: "revoked" }),
      json({ sso_required: true, blockers: [], recovery: RECOVERY }),
      json({ recovery: RECOVERY }, 201),
      json({ mfa_required: true }),
    ]);
    const c = person(fetch);
    expect((await c.org.setModels(["grt-nano", "grt-pro"])).restricted).toBe(true);
    expect(seen[0]!.body).toEqual({ allowed: ["grt-nano", "grt-pro"] });
    await c.org.setModels(null);
    expect(seen[1]!.body).toEqual({ allowed: null });
    expect((await c.org.setSharing(false)).enabled).toBe(false);
    expect(seen[2]!.body).toEqual({ enabled: false });
    expect((await c.org.revokeShare("sh-1")).status).toBe("revoked");
    const enforced = await c.org.setSso(true);
    expect(seen[4]!.body).toEqual({ sso_required: true });
    expect(enforced.recovery?.code).toBe("BREAK-GLASS-SECRET");
    expect((await c.org.mintRecoveryCode()).recovery.shown_once).toBe(true);
    expect((await c.org.setMfa(true)).mfa_required).toBe(true);
    expect(seen[6]!.body).toEqual({ mfa_required: true });
    expect(seen.map((s) => `${s.method} ${route(s.url)}`)).toEqual([
      "PUT /api/org/models",
      "PUT /api/org/models",
      "PUT /api/org/sharing",
      "DELETE /api/org/shares/sh-1",
      "PUT /api/org/sso",
      "POST /api/org/sso/recovery-code",
      "PUT /api/org/mfa",
    ]);
    expect(() => c.org.setModels(Array.from({ length: 201 }, (_, i) => `m-${i}`))).toThrow(/at most 200/);
  });

  it("requiring SSO that would lock the org out is a conflict", async () => {
    const { fetch } = stubFetch([
      json(
        {
          detail: {
            msg: "Single sign-on cannot be enforced yet: it would lock this organisation out.",
            blockers: ["no verified domain"],
          },
        },
        409,
      ),
    ]);
    const error = await person(fetch).org.setSso(true).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect(((error as ConflictError).body as { detail: { blockers: string[] } }).detail.blockers).toEqual([
      "no verified domain",
    ]);
  });

  it("domains and identity providers", async () => {
    const { fetch, seen } = stubFetch([
      json(DOMAIN, 201),
      json(
        {
          ...DOMAIN,
          method: null,
          last_checked_at: "2026-10-31",
          last_error: null,
          record: RECORD,
          detail: "The TXT record was not found yet.",
          found: ["v=spf1"],
        },
        202,
      ),
      json({ ...DOMAIN, verified: true, method: "txt", last_checked_at: "2026-10-31", last_error: null, record: RECORD }),
      noContent(),
      json({ provider: "okta", kind: "oidc", name: "Okta", issuer: "https://acme.okta.test", created_at: "x" }, 201),
      noContent(),
    ]);
    const c = person(fetch);
    expect((await c.org.domains.claim("example.test")).verified).toBe(false);
    expect(seen[0]!.body).toEqual({ domain: "example.test" });
    const pending = await c.org.domains.verify("example.test");
    expect([pending.verified, pending.found]).toEqual([false, ["v=spf1"]]);
    expect(pending.record?.value).toMatch(/^matterwave-domain/);
    expect((await c.org.domains.verify("example.test")).verified).toBe(true);
    await c.org.domains.release("example.test");
    const provider = await c.org.idps.attach({
      name: "Okta",
      issuer: "https://acme.okta.test",
      client_id: "cid",
      client_secret: "sec",
    });
    expect(provider.provider).toBe("okta");
    expect(seen[4]!.body).toEqual({
      kind: "oidc",
      name: "Okta",
      issuer: "https://acme.okta.test",
      client_id: "cid",
      client_secret: "sec",
    });
    await c.org.idps.detach("okta");
    expect(seen.map((s) => `${s.method} ${route(s.url)}`)).toEqual([
      "POST /api/org/domains",
      "POST /api/org/domains/example.test/verify",
      "POST /api/org/domains/example.test/verify",
      "DELETE /api/org/domains/example.test",
      "POST /api/org/idp",
      "DELETE /api/org/idp/okta",
    ]);
    expect(() =>
      c.org.idps.attach({ name: "x", issuer: "http://idp", client_id: "c", client_secret: "s" }),
    ).toThrow(/https/);
    expect(() => c.org.domains.claim("")).toThrow(MatterWaveConfigError);
  });

  it("billing: checkout, the portal and a change of plan", async () => {
    const { fetch, seen } = stubFetch([
      json({ url: "https://checkout.stripe.test/s/1" }),
      json({ url: "https://billing.stripe.test/p/1" }),
      json({ org_id: "org-1", plan: "free" }),
      json({ url: "https://checkout.stripe.test/s/2" }),
    ]);
    const c = person(fetch);
    expect((await c.billing.checkout("pro", { annual: true })).url).toMatch(/\/s\/1$/);
    expect(seen[0]!.body).toEqual({ plan: "pro", annual: true });
    expect((await c.billing.portal()).url).toMatch(/\/p\/1$/);
    expect((await c.billing.changePlan("free", { reason: "winding down" })).plan).toBe("free");
    expect(seen[2]!.body).toEqual({ plan: "free", reason: "winding down" });
    await c.billing.checkout("team");
    expect(seen[3]!.body).toEqual({ plan: "team", annual: false });
    expect(seen.map((s) => `${s.method} ${route(s.url)}`)).toEqual([
      "POST /api/billing/checkout",
      "POST /api/billing/portal",
      "PUT /api/plan",
      "POST /api/billing/checkout",
    ]);
    expect(() => c.billing.changePlan("")).toThrow(MatterWaveConfigError);
  });

  it("approve and deny a device", async () => {
    const { fetch, seen } = stubFetch([
      json({
        status: "approved",
        client_name: "matterwave-tui",
        key: {
          id: "key-9",
          prefix: "mw_dev",
          name: "Device: laptop",
          kind: "device",
          scopes: ["chat:read", "chat:write"],
          created_at: "2026-10-31",
        },
      }),
      json({ status: "denied", client_name: null }),
    ]);
    const c = person(fetch);
    const decided = await c.auth.device.approve("ABCD-EFGH", { name: "laptop" });
    expect(seen[0]!.body).toEqual({ user_code: "ABCD-EFGH", name: "laptop" });
    expect(decided.key?.kind).toBe("device");
    expect(decided.key && "key" in decided.key).toBe(false);
    expect((await c.auth.device.deny("ABCD-EFGH")).status).toBe("denied");
    expect(seen[1]!.body).toEqual({ user_code: "ABCD-EFGH" });
    expect(seen.map((s) => `${s.method} ${route(s.url)}`)).toEqual([
      "POST /api/auth/device/approve",
      "POST /api/auth/device/deny",
    ]);
  });
});
