/**
 * The account self-service routes: terms, onboarding, the password and email
 * changes, sessions and preferences, and the deletion. Each test answers
 * with the body the route in api/matterwave sends and checks the request the
 * client made and what it parsed.
 */

import { describe, expect, it } from "vitest";
import { MatterWaveConfigError } from "../src/index.js";
import { BASE_URL, REQUEST_ID, client, json, stubFetch } from "./helpers.js";

describe("account", () => {
  it("updates the name and reads it back", async () => {
    const { fetch, seen } = stubFetch([json({ name: "Ada Lovelace" })]);
    const renamed = await client(fetch).account.update({ full_name: "Ada Lovelace" });
    expect(seen[0]!.method).toBe("PATCH");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/me`);
    expect(seen[0]!.body).toEqual({ full_name: "Ada Lovelace" });
    expect(renamed.name).toBe("Ada Lovelace");
    expect(renamed.requestId).toBe(REQUEST_ID);
  });

  it("refuses an empty name before sending", async () => {
    const { fetch } = stubFetch([json({ name: "x" })]);
    expect(() => client(fetch).account.update({ full_name: "  " })).toThrow(MatterWaveConfigError);
  });

  it("accepts the terms and reads the recorded version", async () => {
    const { fetch, seen } = stubFetch([
      json({
        terms_version: "2026-01-15",
        terms_accepted_at: "2026-10-31T09:00:00+00:00",
        terms_current: true,
      }),
    ]);
    const accepted = await client(fetch).account.acceptTerms("2026-01-15");
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/me/accept-terms`);
    expect(seen[0]!.body).toEqual({ version: "2026-01-15" });
    expect(accepted.terms_version).toBe("2026-01-15");
    expect(accepted.terms_current).toBe(true);
  });

  it("completes onboarding and keeps the timestamp", async () => {
    const { fetch, seen } = stubFetch([
      json({ onboarding_completed: true, completed_at: "2026-10-31T09:00:00+00:00" }),
    ]);
    const done = await client(fetch).account.completeOnboarding();
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/me/onboarding/complete`);
    expect(done.onboarding_completed).toBe(true);
    expect(done.completed_at).toBe("2026-10-31T09:00:00+00:00");
  });

  it("changes the password and reads the revoked count", async () => {
    const { fetch, seen } = stubFetch([json({ status: "changed", revoked: 3 })]);
    const changed = await client(fetch).account.changePassword({
      current_password: "correct horse battery staple",
      new_password: "a longer correct horse battery staple",
    });
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/me/password`);
    expect(seen[0]!.body).toEqual({
      current_password: "correct horse battery staple",
      new_password: "a longer correct horse battery staple",
    });
    expect(changed.status).toBe("changed");
    expect(changed.revoked).toBe(3);
  });

  it("refuses a short new password before sending", async () => {
    const { fetch, calls } = stubFetch([json({ status: "changed", revoked: 0 })]);
    const c = client(fetch);
    expect(() =>
      c.account.changePassword({ current_password: "present", new_password: "short" }),
    ).toThrow(/at least 12 characters/);
    expect(() =>
      c.account.changePassword({ current_password: "present", new_password: "" }),
    ).toThrow(MatterWaveConfigError);
    expect(calls()).toBe(0);
  });

  it("lists the sessions with the current one flagged", async () => {
    const { fetch, seen } = stubFetch([
      json({
        current_id: "s-1",
        sessions: [
          {
            id: "s-1",
            current: true,
            created_at: "2026-10-01T09:00:00+00:00",
            last_seen_at: "2026-10-31T08:59:00+00:00",
            user_agent: "Mozilla/5.0",
            ip: "10.1.1.8",
          },
          {
            id: "s-2",
            current: false,
            created_at: "2026-10-02T09:00:00+00:00",
            last_seen_at: "2026-10-30T08:59:00+00:00",
            user_agent: null,
            ip: null,
          },
        ],
      }),
    ]);
    const listed = await client(fetch).sessions.list();
    expect(seen[0]!.method).toBe("GET");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/me/sessions`);
    expect(listed.current_id).toBe("s-1");
    expect(listed.sessions[0]!.current).toBe(true);
    expect(listed.sessions[1]!.id).toBe("s-2");
  });

  it("revokes one session and says whether it was the current one", async () => {
    const { fetch, seen } = stubFetch([json({ status: "revoked", current: true })]);
    const revoked = await client(fetch).sessions.revoke("s-1");
    expect(seen[0]!.method).toBe("DELETE");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/me/sessions/s-1`);
    expect(revoked.current).toBe(true);
  });

  it("signs every other session out", async () => {
    const { fetch, seen } = stubFetch([json({ revoked: 2 })]);
    const others = await client(fetch).sessions.revokeOthers();
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/me/sessions/revoke-others`);
    expect(others.revoked).toBe(2);
  });

  it("reads the preferences with the defaults applied", async () => {
    const { fetch, seen } = stubFetch([
      json({
        email: { product_updates: false, usage_alerts: true, billing_receipts: true },
        locale: "en-GB",
        notifications: { budget_warn: true },
      }),
    ]);
    const prefs = await client(fetch).preferences.get();
    expect(seen[0]!.method).toBe("GET");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/me/preferences`);
    expect(prefs.locale).toBe("en-GB");
    expect(prefs.email.billing_receipts).toBe(true);
  });

  it("saves the changes over the stored preferences", async () => {
    const stored = {
      email: { product_updates: false, usage_alerts: true, billing_receipts: true },
      locale: "en-GB",
      notifications: { budget_warn: true },
    };
    const saved = {
      email: { product_updates: true, usage_alerts: true, billing_receipts: true },
      locale: null,
      notifications: { budget_warn: false },
    };
    const { fetch, seen } = stubFetch([json(stored), json(saved)]);
    const answer = await client(fetch).preferences.update({ product_updates: true, locale: null, budget_warn: false });
    expect(seen[1]!.method).toBe("PUT");
    expect(seen[1]!.url).toBe(`${BASE_URL}/api/me/preferences`);
    expect(seen[1]!.body).toEqual(saved);
    expect(answer.notifications.budget_warn).toBe(false);
  });

  it("reads the email change state", async () => {
    const { fetch, seen } = stubFetch([
      json({ email: "ada@example.com", pending_email: "ada@newexample.com" }),
    ]);
    const state = await client(fetch).account.emailChangeState();
    expect(seen[0]!.method).toBe("GET");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/me/email`);
    expect(state.pending_email).toBe("ada@newexample.com");
  });

  it("starts an email change and reports whether the mail went", async () => {
    const { fetch, seen } = stubFetch([
      json({ status: "code_sent", new_email: "ada@newexample.com", mail_sent: true }),
    ]);
    const sent = await client(fetch).account.startEmailChange({
      new_email: "ada@newexample.com",
      current_password: "correct horse battery staple",
    });
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/me/email`);
    expect(seen[0]!.body).toEqual({
      new_email: "ada@newexample.com",
      current_password: "correct horse battery staple",
    });
    expect(sent.mail_sent).toBe(true);
  });

  it("refuses a start without an address or a password before sending", async () => {
    const { fetch, calls } = stubFetch([json({})]);
    const c = client(fetch);
    expect(() =>
      c.account.startEmailChange({ new_email: "no-at-sign", current_password: "present" }),
    ).toThrow(/email address/);
    expect(() =>
      c.account.startEmailChange({ new_email: "ada@newexample.com", current_password: "" }),
    ).toThrow(MatterWaveConfigError);
    expect(calls()).toBe(0);
  });

  it("verifies the code and reads the aftermath", async () => {
    const { fetch, seen } = stubFetch([
      json({ status: "changed", email: "ada@newexample.com", revoked: 2, notice_sent: true }),
    ]);
    const changed = await client(fetch).account.verifyEmailChange({ code: "123456" });
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/me/email/verify`);
    expect(seen[0]!.body).toEqual({ code: "123456" });
    expect(changed.email).toBe("ada@newexample.com");
    expect(changed.revoked).toBe(2);
  });

  it("resends and cancels the pending change", async () => {
    const { fetch, seen } = stubFetch([
      json({ status: "code_sent", new_email: "ada@newexample.com", mail_sent: false }),
      json({ status: "cancelled", email: "ada@example.com" }),
    ]);
    const c = client(fetch);
    const resent = await c.account.resendEmailChange();
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/me/email/resend`);
    expect(resent.mail_sent).toBe(false);
    const cancelled = await c.account.cancelEmailChange();
    expect(seen[1]!.method).toBe("POST");
    expect(seen[1]!.url).toBe(`${BASE_URL}/api/me/email/cancel`);
    expect(cancelled.email).toBe("ada@example.com");
  });

  it("deletes the account with the exact phrase", async () => {
    const { fetch, seen } = stubFetch([
      json({
        status: "deleted",
        conversations_deleted: 41,
        attachments_marked_deleted: 3,
        api_keys_revoked: 2,
        custom_instructions_deleted: 1,
        retention_days: 30,
        identity_removed: true,
        deletion_request_id: "del-01",
      }),
    ]);
    const deleted = await client(fetch).account.delete({ confirm: "Delete My Account" });
    expect(seen[0]!.method).toBe("DELETE");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/me`);
    expect(seen[0]!.body).toEqual({ confirm: "Delete My Account" });
    expect(deleted.status).toBe("deleted");
    expect(deleted.identity_removed).toBe(true);
  });

  it("refuses a wrong confirmation phrase before sending", async () => {
    const { fetch, calls } = stubFetch([json({})]);
    const c = client(fetch);
    expect(() => c.account.delete({ confirm: "yes" })).toThrow(/delete my account/);
    expect(calls()).toBe(0);
  });
});
