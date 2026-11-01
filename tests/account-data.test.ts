/**
 * The account and data clients against the fake API: `account`,
 * `preferences`, `sessions`, `exports`, `imports`, `speech`, the attachment
 * scan and view, `billing.status`, `plans` and `policy`. Each test answers
 * with the body the platform's route sends and checks the request the
 * client made and what came back.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  APITimeoutError,
  MatterWaveConfigError,
  MatterWaveError,
  NotFoundError,
  type Fetch,
} from "../src/index.js";
import { API_KEY, BASE_URL, REQUEST_ID, client, json, recordSleeps, stubFetch } from "./helpers.js";

const PREFERENCES = {
  email: { product_updates: false, usage_alerts: true, billing_receipts: true },
  locale: "en-GB",
  notifications: { budget_warn: true },
};
const EXPORT = {
  id: "exp-1",
  status: "pending",
  size_bytes: null,
  created_at: "2026-10-31T09:00:00+00:00",
  completed_at: null,
  expires_at: null,
};
const READY = {
  ...EXPORT,
  status: "ready",
  size_bytes: 2048,
  download_url: "/api/me/export/exp-1/download?expires=1793000000&sig=abc123",
};
const IMPORT = {
  id: "imp-1",
  status: "pending",
  source: "chatgpt",
  filename: "conversations.json",
  size_bytes: 1234,
  conversations_total: 0,
  conversations_done: 0,
  conversations_created: 0,
  conversations_existing: 0,
  conversations_skipped: 0,
  messages_created: 0,
  attachments_skipped: 0,
  branches_dropped: 0,
  error: null,
  created_at: "2026-10-31T09:00:00+00:00",
  started_at: null,
  completed_at: null,
};

function route(url: string): string {
  return url.slice(BASE_URL.length);
}

function params(url: string): Record<string, string> {
  return Object.fromEntries(new URL(url).searchParams);
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

let sleeps: number[];
let restore: () => void;
beforeEach(() => {
  ({ sleeps, restore } = recordSleeps());
});
afterEach(() => restore());

// --- the account ---------------------------------------------------------------

describe("account", () => {
  it("updates the name, accepts the terms and reads the enforcement state", async () => {
    const { fetch, seen } = stubFetch([
      json({ name: "Ada Lovelace" }),
      json({ terms_version: "2026-10", terms_accepted_at: "2026-10-31T09:00:00+00:00", terms_current: true }),
      json({
        state: "rate_limited",
        reason: "spam",
        since: "2026-10-30T00:00:00+00:00",
        expires_at: null,
        scope: "user",
        appeal_path: "/policy#appeal",
        limit: { messages: 10, window_s: 3600 },
      }),
    ]);
    const c = client(fetch);
    const named = await c.account.update({ full_name: "  Ada   Lovelace " });
    expect([seen[0]!.method, route(seen[0]!.url)]).toEqual(["PATCH", "/api/me"]);
    expect(seen[0]!.body).toEqual({ full_name: "  Ada   Lovelace " });
    expect([named.name, named.requestId]).toEqual(["Ada Lovelace", REQUEST_ID]);
    const accepted = await c.account.acceptTerms("2026-10");
    expect([seen[1]!.method, route(seen[1]!.url)]).toEqual(["POST", "/api/me/accept-terms"]);
    expect(seen[1]!.body).toEqual({ version: "2026-10" });
    expect(accepted.terms_current).toBe(true);
    const held = await c.account.enforcement();
    expect(route(seen[2]!.url)).toBe("/api/me/enforcement");
    expect([held.state, held.limit?.window_s]).toEqual(["rate_limited", 3600]);
    expect(() => c.account.update({ full_name: "   " })).toThrow(MatterWaveConfigError);
    expect(() => c.account.acceptTerms("")).toThrow(MatterWaveConfigError);
    expect(seen).toHaveLength(3);
  });

  it("reads enforcement `none` as a bare state", async () => {
    const { fetch } = stubFetch([json({ state: "none" })]);
    const held = await client(fetch).account.enforcement();
    expect([held.state, held.reason, held.limit]).toEqual(["none", undefined, undefined]);
  });
});

describe("preferences", () => {
  it("sends the whole object back with the changes laid over it", async () => {
    const { fetch, seen } = stubFetch([json(PREFERENCES), json(PREFERENCES), json(PREFERENCES), json(PREFERENCES)]);
    const c = client(fetch);
    await c.preferences.update({ product_updates: true });
    expect(seen.map((s) => `${s.method} ${route(s.url)}`)).toEqual(["GET /api/me/preferences", "PUT /api/me/preferences"]);
    expect(seen[1]!.body).toEqual({
      locale: "en-GB",
      email: { product_updates: true, usage_alerts: true, billing_receipts: true },
      notifications: { budget_warn: true },
    });
    await c.preferences.update({ locale: null, budget_warn: false });
    const put = seen[3]!.body as typeof PREFERENCES;
    expect(put.locale).toBeNull();
    expect(put.notifications).toEqual({ budget_warn: false });
    expect(put.email.product_updates).toBe(false);
  });

  it("reads them", async () => {
    const { fetch } = stubFetch([json(PREFERENCES)]);
    const preferences = await client(fetch).preferences.get();
    expect([preferences.locale, preferences.email.billing_receipts]).toEqual(["en-GB", true]);
  });
});

describe("sessions", () => {
  it("lists, revokes one and revokes the others", async () => {
    const { fetch, seen } = stubFetch([
      json({
        current_id: null,
        sessions: [
          {
            id: "secret-session-value",
            current: false,
            created_at: "2026-10-01T00:00:00+00:00",
            last_seen_at: "2026-10-31T00:00:00+00:00",
            user_agent: "Firefox",
            ip: "203.0.113.9",
          },
        ],
      }),
      json({ status: "revoked", current: false }),
      json({ revoked: 3 }),
    ]);
    const c = client(fetch);
    const listed = await c.sessions.list();
    expect(listed.sessions.map((s) => s.user_agent)).toEqual(["Firefox"]);
    expect((await c.sessions.revoke("s-1")).status).toBe("revoked");
    expect((await c.sessions.revokeOthers()).revoked).toBe(3);
    expect(seen.map((s) => `${s.method} ${route(s.url)}`)).toEqual([
      "GET /api/me/sessions",
      "DELETE /api/me/sessions/s-1",
      "POST /api/me/sessions/revoke-others",
    ]);
  });
});

// --- exports -------------------------------------------------------------------

describe("exports", () => {
  it("createAndDownload waits for the export, then fetches it with the signature and the key", async () => {
    const { fetch, seen } = stubFetch([
      json(EXPORT, 202),
      json(EXPORT),
      json(READY),
      new Response('{"format_version": 2}', { status: 200, headers: { "Content-Type": "application/json" } }),
    ]);
    const document = await client(fetch).exports.createAndDownload({ pollIntervalMs: 2000 });
    expect(JSON.parse(new TextDecoder().decode(document))).toEqual({ format_version: 2 });
    expect(seen.map((s) => `${s.method} ${new URL(s.url).pathname}`)).toEqual([
      "POST /api/me/export",
      "GET /api/me/export/exp-1",
      "GET /api/me/export/exp-1",
      "GET /api/me/export/exp-1/download",
    ]);
    expect(params(seen[3]!.url)).toEqual({ expires: "1793000000", sig: "abc123" });
    expect(seen[3]!.headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(sleeps).toEqual([2000]);
  });

  it("gets the export's state with a fresh link once it is ready", async () => {
    const { fetch, seen } = stubFetch([json(READY)]);
    const ready = await client(fetch).exports.get("exp-1");
    expect(route(seen[0]!.url)).toBe("/api/me/export/exp-1");
    expect(ready.download_url).toBe(READY.download_url);
  });

  it("wait throws when the export failed or time runs out", async () => {
    const { fetch } = stubFetch([json({ ...EXPORT, status: "failed" }), json({ ...EXPORT, id: "exp-2" })]);
    const c = client(fetch);
    const failed = await c.exports.wait("exp-1").catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(MatterWaveError);
    expect(failed).not.toBeInstanceOf(APITimeoutError);
    expect((failed as Error).message).toMatch(/failed/);
    const late = await c.exports.wait("exp-2", { timeoutMs: 0 }).catch((e: unknown) => e);
    expect(late).toBeInstanceOf(APITimeoutError);
    expect(sleeps).toEqual([]);
  });

  it("names the failure", async () => {
    const { fetch } = stubFetch([json({ ...EXPORT, status: "expired" })]);
    await expect(client(fetch).exports.wait("exp-1")).rejects.toThrow(/expired; request a new one/);
  });

  it("download refuses an export that is not ready, and a URL that is not an export's", () => {
    const c = client(stubFetch([json({})]).fetch);
    expect(() => c.exports.download(EXPORT)).toThrow(/no download_url/);
    expect(() => c.exports.download("/api/attachments/a/content")).toThrow(/not an export download URL/);
  });

  it("document is the export built inside the request", async () => {
    const { fetch, seen } = stubFetch([json({ format_version: 2, conversations: [] })]);
    expect((await client(fetch).exports.document()).format_version).toBe(2);
    expect([seen[0]!.method, route(seen[0]!.url)]).toEqual(["GET", "/api/me/export"]);
  });
});

// --- imports -------------------------------------------------------------------

describe("imports", () => {
  it("uploads the export, lists, gets and waits", async () => {
    const { fetch, seen } = stubFetch([
      json(IMPORT, 202),
      json({ data: [IMPORT] }),
      json({ ...IMPORT, status: "running" }),
      json({ ...IMPORT, status: "done", conversations_created: 12 }),
    ]);
    const c = client(fetch);
    const job = await c.imports.create({ file: bytes("[]"), filename: "conversations.json" });
    expect([seen[0]!.method, route(seen[0]!.url)]).toEqual(["POST", "/api/me/imports"]);
    expect(seen[0]!.headers["Content-Type"]).toBeUndefined();
    const file = (seen[0]!.raw as FormData).get("file") as File;
    expect([file.name, file.type, await file.text()]).toEqual(["conversations.json", "application/json", "[]"]);
    expect(job.status).toBe("pending");
    expect((await c.imports.list()).data.map((j) => j.id)).toEqual(["imp-1"]);
    expect((await c.imports.wait("imp-1")).conversations_created).toBe(12);
    expect(seen.slice(2).map((s) => route(s.url))).toEqual(["/api/me/imports/imp-1", "/api/me/imports/imp-1"]);
    expect(sleeps).toEqual([5000]);
  });

  it("sends a zip as one", async () => {
    const { fetch, seen } = stubFetch([json(IMPORT, 202)]);
    await client(fetch).imports.create({ file: new Blob(["PK"]), filename: "export.ZIP" });
    expect(((seen[0]!.raw as FormData).get("file") as File).type).toBe("application/zip");
  });

  it("a failed import throws with its reason", async () => {
    const { fetch } = stubFetch([json({ ...IMPORT, status: "failed", error: "not an export" })]);
    await expect(client(fetch).imports.wait("imp-1")).rejects.toThrow(/not an export/);
  });
});

// --- speech and attachments ----------------------------------------------------

describe("speech", () => {
  it("sends the clip, its audio type and the language", async () => {
    const { fetch, seen } = stubFetch([json({ text: "hello there" }), json({ text: "" }), json({ text: "" })]);
    const c = client(fetch);
    const said = await c.speech.transcribe({ file: bytes("OggS..."), filename: "note.ogg", language: "en" });
    expect(said.text).toBe("hello there");
    expect([seen[0]!.method, route(seen[0]!.url)]).toEqual(["POST", "/api/speech/transcribe"]);
    const form = seen[0]!.raw as FormData;
    const clip = form.get("file") as File;
    expect([clip.name, clip.type]).toEqual(["note.ogg", "audio/ogg"]);
    expect(form.get("language")).toBe("en");
    await c.speech.transcribe({ file: bytes("..."), filename: "clip.bin", content_type: "audio/webm" });
    expect(((seen[1]!.raw as FormData).get("file") as File).type).toBe("audio/webm");
    expect((seen[1]!.raw as FormData).has("language")).toBe(false);
    await c.speech.transcribe({ file: new Blob(["..."], { type: "audio/x-custom" }), filename: "clip" });
    expect(((seen[2]!.raw as FormData).get("file") as File).type).toBe("audio/x-custom");
    expect(() => c.speech.transcribe({ file: bytes("..."), filename: "clip" })).toThrow(/content_type/);
    expect(() => c.speech.transcribe({ file: bytes(""), filename: "clip.ogg" })).toThrow(/empty/);
  });

  it("a deployment without a transcriber is a 404", async () => {
    const { fetch } = stubFetch([json({ detail: "Transcription is not configured on this deployment." }, 404)]);
    await expect(client(fetch).speech.transcribe({ file: bytes("..."), filename: "a.wav" })).rejects.toThrow(NotFoundError);
  });
});

describe("attachments.scan and attachments.view", () => {
  it("scan reads the scan, and view follows the signed link with the key", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    // fetch follows a same-origin redirect itself, the credential with it,
    // unless the request says otherwise.
    const fetch: Fetch = async (url, init) => {
      seen.push({ url, headers: { ...(init.headers as Record<string, string>) } });
      if (url.endsWith("/scan")) return json({ id: "att-1", scan_status: "clean" });
      if (url.endsWith("/view")) {
        expect(init.redirect ?? "follow").toBe("follow");
        return fetch(new URL("/api/attachments/att-1/content?expires=1&sig=xyz", url).href, init);
      }
      return new Response("%PDF-1.7", { status: 200 });
    };
    const c = client(fetch);
    expect((await c.attachments.scan("att-1")).scan_status).toBe("clean");
    expect(new TextDecoder().decode(await c.attachments.view("att-1"))).toBe("%PDF-1.7");
    expect(seen.map((s) => new URL(s.url).pathname)).toEqual([
      "/api/attachments/att-1/scan",
      "/api/attachments/att-1/view",
      "/api/attachments/att-1/content",
    ]);
    expect(params(seen[2]!.url)).toEqual({ expires: "1", sig: "xyz" });
    expect(seen[2]!.headers.Authorization).toBe(`Bearer ${API_KEY}`);
  });
});

// --- billing, plans and policy -------------------------------------------------

describe("billing, plans and policy", () => {
  it("billing.status reads the entitlements and the dunning", async () => {
    const { fetch, seen } = stubFetch([
      json({
        org_id: "org-1",
        plan: "team",
        plan_name: "Team",
        status: "active",
        seats: 5,
        billing_enabled: true,
        collection_method: "send_invoice",
        days_until_due: 30,
        dunning: {
          stage: "warn",
          source: "invoice",
          first_overdue_at: "2026-10-20T00:00:00+00:00",
          days_overdue: 11,
          outstanding_micros: 49_000_000,
          schedule: { warn_at: "a", warn_final_at: "b", limited_at: "c", suspended_at: null, days_limit_at: "d" },
          next_step: { stage: "warn_final", at: "b" },
          overage_stopped: false,
          limited: { stops_overage: true, blocks_new_keys: true, blocks_upgrades: true },
          auto_suspend: false,
          pay_url: "https://pay.example.test/inv",
        },
      }),
    ]);
    const status = await client(fetch).billing.status();
    expect(route(seen[0]!.url)).toBe("/api/billing/status");
    expect([status.plan, status.seats]).toEqual(["team", 5]);
    expect([status.billing_enabled, status.days_until_due]).toEqual([true, 30]);
    expect(status.dunning?.next_step?.stage).toBe("warn_final");
    expect(status.dunning?.limited?.blocks_new_keys).toBe(true);
  });

  it("plans and policy are public and send no credential", async () => {
    const catalogBody = {
      data: [
        {
          code: "free",
          name: "Free",
          price_cents_monthly: 0,
          price_cents_annual: 0,
          included_tokens: 100000,
          included_tokens_per_seat: null,
          per_seat: false,
          overage_enabled: false,
          default_overage_cap_micros: 0,
          trial_days: 0,
          models: ["grt-nano"],
          limits: { max_seats: 1 },
        },
      ],
      models: [
        { id: "grt-nano", label: "GRT Nano", multiplier: 1, input_usd_per_m: 0.1, output_usd_per_m: 0.4, partner: false },
      ],
      default_model: "grt-nano",
    };
    const statsBody = {
      reports: { by_kind: { unsafe: 2, unhelpful: 5 } },
      enforcement: { active: { warned: 1, rate_limited: 0, suspended: 0 } },
    };
    const { fetch, seen } = stubFetch([json(catalogBody), json(statsBody), json(catalogBody)]);
    const anonymous = client(fetch, { apiKey: null });
    const catalog = await anonymous.plans.list();
    expect(catalog.data.map((p) => p.code)).toEqual(["free"]);
    expect(catalog.models[0]!.input_usd_per_m).toBe(0.1);
    expect(catalog.data[0]!.limits).toEqual({ max_seats: 1 });
    expect((await anonymous.policy.stats()).reports.by_kind!.unhelpful).toBe(5);
    await client(fetch).plans.list();
    expect(seen.map((s) => route(s.url))).toEqual(["/api/plans", "/api/policy/stats", "/api/plans"]);
    expect(seen.map((s) => s.headers.Authorization)).toEqual([undefined, undefined, undefined]);
  });
});
