/**
 * The passkeys, MFA, account-switching and speech resources. Each test
 * answers with the body the route in api/matterwave sends and checks the
 * request the client made.
 */

import { describe, expect, it } from "vitest";
import { BASE_URL, client, json, stubFetch } from "./helpers.js";

const CREDENTIAL = { id: "cred-01", rawId: "cred-01", type: "public-key", response: {} };

describe("passkeys", () => {
  it("lists the passkeys with the relying-party id and the cap", async () => {
    const { fetch, seen } = stubFetch([
      json({
        passkeys: [{ id: "pk-01", name: "Touch ID -- work laptop", created_at: "2026-10-01T09:00:00+00:00" }],
        rp_id: "matterwave.test",
        max: 10,
      }),
    ]);
    const listed = await client(fetch).passkeys.list();
    expect(seen[0]!.method).toBe("GET");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/me/passkeys`);
    expect(listed.rp_id).toBe("matterwave.test");
    expect(listed.max).toBe(10);
    expect(listed.passkeys[0]!.name).toContain("Touch ID");
  });

  it("starts a registration", async () => {
    const { fetch, seen } = stubFetch([
      json({ passkey_id: "pk-new", options: { publicKey: { challenge: "abc" } } }),
    ]);
    const started = await client(fetch).passkeys.startRegistration();
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/me/passkeys/start`);
    expect(started.passkey_id).toBe("pk-new");
  });

  it("verifies an attestation under the passkey id", async () => {
    const { fetch, seen } = stubFetch([
      json({ id: "pk-01", name: "Touch ID -- work laptop", created_at: "2026-10-31T09:00:00+00:00" }, 201),
    ]);
    const row = await client(fetch).passkeys.verifyRegistration("pk-01", {
      credential: CREDENTIAL,
      name: "Touch ID -- work laptop",
    });
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/me/passkeys/pk-01/verify`);
    expect(seen[0]!.body).toEqual({ credential: CREDENTIAL, name: "Touch ID -- work laptop" });
    expect(row.name).toContain("Touch ID");
  });

  it("renames and removes a passkey", async () => {
    const { fetch, seen } = stubFetch([
      json({ id: "pk-01", name: "Yubikey", created_at: "2026-10-01T09:00:00+00:00" }),
      new Response(null, { status: 204 }),
    ]);
    const c = client(fetch);
    const renamed = await c.passkeys.rename("pk-01", { name: "Yubikey" });
    expect(seen[0]!.method).toBe("PATCH");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/me/passkeys/pk-01`);
    expect(renamed.name).toBe("Yubikey");
    await c.passkeys.remove("pk-01");
    expect(seen[1]!.method).toBe("DELETE");
  });

  it("refuses an unnamed or over-long passkey name before sending", () => {
    const { fetch, calls } = stubFetch([json({})]);
    const c = client(fetch);
    expect(() => c.passkeys.verifyRegistration("pk-01", { credential: CREDENTIAL, name: " " })).toThrow(
      /name, like the device/,
    );
    expect(() => c.passkeys.rename("pk-01", { name: "x".repeat(65) })).toThrow(/at most 64/);
    expect(calls()).toBe(0);
  });

  it("starts the login ceremony anonymously", async () => {
    const { fetch, seen } = stubFetch([
      json({ challenge: "sealed-01", options: { publicKey: { challenge: "abc" } } }),
    ]);
    const started = await client(fetch).passkeys.startLogin({
      email: "Ada@Example.com",
      auth_request: "ar-01",
    });
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/auth/passkey/start`);
    expect(seen[0]!.body).toEqual({ email: "ada@example.com", auth_request: "ar-01" });
    expect(seen[0]!.headers.Authorization).toBeUndefined();
    expect(started.challenge).toBe("sealed-01");
  });

  it("finishes the login with the assertion and reads the redirect", async () => {
    const { fetch, seen } = stubFetch([json({ redirect: "/api/auth/callback?code=1" })]);
    const finished = await client(fetch).passkeys.finishLogin({ challenge: "sealed-01", credential: CREDENTIAL });
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/auth/passkey/finish`);
    expect(seen[0]!.body).toEqual({ challenge: "sealed-01", credential: CREDENTIAL });
    expect(finished.redirect).toContain("callback");
  });

  it("refuses a login start without an address before sending", () => {
    const { fetch, calls } = stubFetch([json({})]);
    expect(() => client(fetch).passkeys.startLogin({ email: "nope", auth_request: "ar" })).toThrow(
      /email address/,
    );
    expect(calls()).toBe(0);
  });
});

describe("mfa", () => {
  it("reads the state", async () => {
    const { fetch, seen } = stubFetch([
      json({ totp_enrolled: true, recovery_codes_left: 8, org_requires_mfa: false }),
    ]);
    const state = await client(fetch).mfa.state();
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/me/mfa`);
    expect(state.recovery_codes_left).toBe(8);
  });

  it("starts and confirms a TOTP enrolment, recovery codes coming back once", async () => {
    const { fetch, seen } = stubFetch([
      json({ secret: "JBSWY3DPEHPK3PXP", uri: "otpauth://totp/MatterWave:ada?secret=JBSW", qr_svg: "data:image/svg+xml;base64,abc" }),
      json({ totp_enrolled: true, recovery_codes: ["1256-8831", "4410-9927"], recovery_codes_left: 10 }),
    ]);
    const c = client(fetch);
    const started = await c.mfa.startTotp();
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/me/mfa/totp/start`);
    expect(started.uri).toContain("otpauth://");
    const confirmed = await c.mfa.confirmTotp({ code: "123 456" });
    expect(seen[1]!.body).toEqual({ code: "123 456" });
    expect(confirmed.recovery_codes).toHaveLength(2);
  });

  it("removes the authenticator on proof of a recovery code", async () => {
    const { fetch, seen } = stubFetch([json({ totp_enrolled: false, recovery_codes_left: 0 })]);
    const removed = await client(fetch).mfa.removeTotp({ recovery_code: "1256-8831" });
    expect(seen[0]!.method).toBe("DELETE");
    expect(seen[0]!.body).toEqual({ recovery_code: "1256-8831" });
    expect(removed.totp_enrolled).toBe(false);
  });

  it("reissues the recovery codes on a code from the app", async () => {
    const { fetch, seen } = stubFetch([json({ recovery_codes: ["0000-0001"], recovery_codes_left: 10 })]);
    const reissued = await client(fetch).mfa.reissueRecoveryCodes({ code: "654321" });
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/me/mfa/recovery-codes`);
    expect(reissued.recovery_codes_left).toBe(10);
  });

  it("verifies the code step of a sign-in anonymously", async () => {
    const { fetch, seen } = stubFetch([json({ redirect: "/api/auth/callback?code=1" })]);
    const verified = await client(fetch).mfa.verifyLogin({ challenge: "sealed-01", code: "123456" });
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/auth/mfa`);
    expect(seen[0]!.headers.Authorization).toBeUndefined();
    expect(verified.redirect).toContain("callback");
  });

  it("runs the org-policy enrolment through the sealed challenge", async () => {
    const { fetch, seen } = stubFetch([
      json({ secret: "JBSW", uri: "otpauth://x", qr_svg: "data:image/svg+xml;base64,y" }),
      json({ recovery_codes: ["1256-8831"], challenge: "sealed-02" }),
    ]);
    const c = client(fetch);
    const started = await c.mfa.startLoginEnrolment({ challenge: "sealed-01" });
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/auth/mfa/enrol/start`);
    expect(started.secret).toBe("JBSW");
    const confirmed = await c.mfa.confirmLoginEnrolment({ challenge: "sealed-01", code: "123456" });
    expect(seen[1]!.url).toBe(`${BASE_URL}/api/auth/mfa/enrol/confirm`);
    expect(confirmed.challenge).toBe("sealed-02");
  });

  it("refuses a bad code shape and a proof-less removal before sending", () => {
    const { fetch, calls } = stubFetch([json({})]);
    const c = client(fetch);
    expect(() => c.mfa.confirmTotp({ code: "12ab56" })).toThrow(/six digits/);
    expect(() => c.mfa.confirmTotp({ code: "12345" })).toThrow(/six digits/);
    expect(() => c.mfa.removeTotp({})).toThrow(/authenticator or one of your recovery codes/);
    expect(() => c.mfa.verifyLogin({ challenge: "c", code: "1234567" })).toThrow(/six digits/);
    expect(calls()).toBe(0);
  });
});

describe("accounts", () => {
  it("lists who is signed in, anonymously", async () => {
    const { fetch, seen } = stubFetch([
      json({
        accounts: [
          { slot: 0, current: true, subject: "sub-ada", email: "ada@example.com", name: "Ada", org_name: "Acme" },
          { slot: 1, current: false, subject: "sub-grace", email: "grace@example.com", name: "Grace", org_name: null },
        ],
        max: 4,
        room: true,
      }),
    ]);
    const roster = await client(fetch).accounts.list();
    expect(seen[0]!.method).toBe("GET");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/accounts`);
    expect(seen[0]!.headers.Authorization).toBeUndefined();
    expect(roster.accounts[0]!.current).toBe(true);
    expect(roster.room).toBe(true);
  });

  it("switches to a parked slot", async () => {
    const { fetch, seen } = stubFetch([json({ status: "ok", subject: "sub-grace", email: "grace@example.com" })]);
    const switched = await client(fetch).accounts.switch({ slot: 1 });
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/accounts/switch`);
    expect(seen[0]!.body).toEqual({ slot: 1 });
    expect(switched.subject).toBe("sub-grace");
  });

  it("refuses a slot the browser cannot hold before sending", () => {
    const { fetch, calls } = stubFetch([json({})]);
    const c = client(fetch);
    expect(() => c.accounts.switch({ slot: 0 })).toThrow(/slot must be 1 to 3/);
    expect(() => c.accounts.switch({ slot: 4 })).toThrow(/slot must be 1 to 3/);
    expect(() => c.accounts.logout(9)).toThrow(/slot must be 1 to 3/);
    expect(calls()).toBe(0);
  });

  it("logs one parked account out and then everything", async () => {
    const { fetch, seen } = stubFetch([
      json({ status: "ok" }),
      json({ status: "ok", end_session_endpoint: "https://idp.test/oidc/v1/end_session" }),
    ]);
    const c = client(fetch);
    const one = await c.accounts.logout(1);
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/accounts/1/logout`);
    expect(one.status).toBe("ok");
    const all = await c.accounts.logoutAll();
    expect(seen[1]!.url).toBe(`${BASE_URL}/api/accounts/logout-all`);
    expect(all.end_session_endpoint).toContain("end_session");
  });
});

describe("speech", () => {
  it("uploads a clip and reads the words", async () => {
    const { fetch, seen } = stubFetch([json({ text: "Hello there, friend of mine." })]);
    const said = await client(fetch).speech.transcribe({
      file: new Blob(["fake-opus"], { type: "audio/webm" }),
      filename: "clip.webm",
      language: "en-GB",
    });
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/speech/transcribe`);
    const form = seen[0]!.raw as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect((form.get("file") as Blob).type).toBe("audio/webm");
    expect(form.get("language")).toBe("en-GB");
    expect(said.text).toBe("Hello there, friend of mine.");
  });

  it("sends raw bytes under an explicit content type", async () => {
    const { fetch, seen } = stubFetch([json({ text: "words" })]);
    await client(fetch).speech.transcribe({
      file: new Uint8Array([1, 2, 3]),
      content_type: "audio/wav",
      filename: "clip.wav",
    });
    const form = seen[0]!.raw as FormData;
    expect((form.get("file") as Blob).type).toBe("audio/wav");
    expect(form.get("language")).toBeNull();
  });

  it("refuses a media type the route does not take before sending", () => {
    const { fetch, calls } = stubFetch([json({})]);
    expect(() =>
      client(fetch).speech.transcribe({ file: new Blob(["x"], { type: "text/plain" }), filename: "a.txt" }),
    ).toThrow(/Send an audio clip/);
    expect(() =>
      client(fetch).speech.transcribe({ file: new Uint8Array([1]), content_type: "application/pdf", filename: "a" }),
    ).toThrow(/Send an audio clip/);
    expect(calls()).toBe(0);
  });

  it("refuses an over-long language hint before sending", () => {
    const { fetch, calls } = stubFetch([json({})]);
    expect(() =>
      client(fetch).speech.transcribe({
        file: new Blob(["x"], { type: "audio/wav" }),
        language: "x".repeat(36),
      }),
    ).toThrow(/BCP-47/);
    expect(calls()).toBe(0);
  });
});
