/**
 * A person's token in place of an API key: `accessToken` static or as a
 * function, and `client.auth.person`, the device-code sign-in at the
 * identity provider with the refresh that keeps the token alive.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  APIError,
  APP_OPERATIONS,
  CREDENTIALS,
  DeviceAuthError,
  MatterWave,
  MatterWaveConfigError,
  MatterWaveError,
  MissingAPIKeyError,
  OPERATIONS,
  type PersonToken,
} from "../src/index.js";
import { BASE_URL, json, recordSleeps, stubFetch, type Answer } from "./helpers.js";

const ISSUER = "https://auth.matterwave.test";
const DEVICE_ENDPOINT = `${ISSUER}/oauth/v2/device_authorization`;
const TOKEN_ENDPOINT = `${ISSUER}/oauth/v2/token`;
const NATIVE_CLIENT = "native-client-1";
const AUDIENCE = "urn:zitadel:iam:org:project:id:42:aud";
const AUTH_CONFIG = {
  auth_mode: "oidc",
  issuer: ISSUER,
  client_id: "web-client",
  token_endpoint: TOKEN_ENDPOINT,
  scopes: ["openid", "profile", "email", AUDIENCE],
  device_authorization_endpoint: "/api/auth/device",
  native_client_id: NATIVE_CLIENT,
  issuer_device_authorization_endpoint: DEVICE_ENDPOINT,
};
const DEVICE_CODE = {
  device_code: "dev-code-1",
  user_code: "WXYZ-1234",
  verification_uri: `${ISSUER}/device`,
  verification_uri_complete: `${ISSUER}/device?user_code=WXYZ-1234`,
  expires_in: 300,
  interval: 5,
};
const ME = { subject: "person-1", kind: "user", roles: [], org_id: "org-1" };

function tokenBody(access = "at-1", refresh: string | null = "rt-1", expiresIn = 3600) {
  return { access_token: access, token_type: "Bearer", expires_in: expiresIn, ...(refresh ? { refresh_token: refresh } : {}) };
}

function form(raw: unknown): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(String(raw)));
}

function oauth(error: string, description?: string): Response {
  return json({ error, ...(description ? { error_description: description } : {}) }, 400);
}

let sleeps: number[];
let restore: () => void;
beforeEach(() => {
  ({ sleeps, restore } = recordSleeps());
});
afterEach(() => restore());

describe("accessToken", () => {
  it("is the bearer, and the environment's key is not read beside it", async () => {
    const env = (globalThis as { process: { env: Record<string, string | undefined> } }).process.env;
    const previous = env.MATTERWAVE_API_KEY;
    env.MATTERWAVE_API_KEY = "mw_from_env";
    try {
      const { fetch, seen } = stubFetch([json(ME)]);
      await new MatterWave({ baseUrl: BASE_URL, accessToken: "person-token", fetch }).me();
      expect(seen[0]!.headers.Authorization).toBe("Bearer person-token");
    } finally {
      if (previous === undefined) delete env.MATTERWAVE_API_KEY;
      else env.MATTERWAVE_API_KEY = previous;
    }
  });

  it("refuses a key and a token together", () => {
    expect(() => new MatterWave({ baseUrl: BASE_URL, apiKey: "mw_k", accessToken: "t" })).toThrow(/not both/);
    expect(() => new MatterWave({ baseUrl: BASE_URL, accessToken: 42 as unknown as string })).toThrow(MatterWaveConfigError);
  });

  it("asks a function once per call, and never for a public route", async () => {
    const { fetch, seen } = stubFetch([json({ object: "api" }), json({}, 503), json(ME), json(ME)]);
    let asked = 0;
    const c = new MatterWave({
      baseUrl: BASE_URL,
      accessToken: async () => `token-${(asked += 1)}`,
      fetch,
    });
    await c.index();
    expect(asked).toBe(0);
    await c.me(); // a 503, then the retry: the same call, one token
    await c.me();
    expect(asked).toBe(2);
    expect(seen.map((s) => s.headers.Authorization)).toEqual([undefined, "Bearer token-1", "Bearer token-1", "Bearer token-2"]);
  });

  it("refuses a function that answers no token", async () => {
    const { fetch } = stubFetch([json(ME)]);
    await expect(new MatterWave({ baseUrl: BASE_URL, accessToken: () => "", fetch }).me()).rejects.toThrow(/non-empty string/);
  });

  it("names both ways to give a credential when there is none", async () => {
    const { fetch } = stubFetch([json(ME)]);
    await expect(new MatterWave({ baseUrl: BASE_URL, apiKey: null, fetch }).me()).rejects.toThrow(MissingAPIKeyError);
    await expect(new MatterWave({ baseUrl: BASE_URL, apiKey: null, fetch }).me()).rejects.toThrow(/accessToken/);
  });
});

describe("CREDENTIALS", () => {
  it("names every operation's credential", () => {
    expect(new Set(Object.keys(CREDENTIALS))).toEqual(new Set([...Object.keys(OPERATIONS), ...Object.keys(APP_OPERATIONS)]));
    for (const value of Object.values(CREDENTIALS)) expect(["public", "key", "person"]).toContain(value.split(":")[0]);
  });
});

describe("client.auth.person", () => {
  function signin(answers: Answer[], apiKey: string | null = null) {
    const stub = stubFetch([json(AUTH_CONFIG), ...answers]);
    return { ...stub, person: new MatterWave({ baseUrl: BASE_URL, apiKey, fetch: stub.fetch }).auth.person };
  }

  it("asks the native client for a code with offline_access and the deployment's scopes", async () => {
    const { person, seen } = signin([json(DEVICE_CODE)], "mw_secret");
    const code = await person.start();
    expect(code.user_code).toBe("WXYZ-1234");
    expect(seen[1]!.url).toBe(DEVICE_ENDPOINT);
    const sent = form(seen[1]!.raw);
    expect(sent.client_id).toBe(NATIVE_CLIENT);
    const scopes = sent.scope!.split(" ");
    expect(scopes.slice(0, 4)).toEqual(["openid", "profile", "email", AUDIENCE]);
    expect(scopes).toContain("offline_access");
    expect(seen[1]!.headers.Authorization).toBeUndefined();
    expect(seen[1]!.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
  });

  it("polls through pending and slow_down to the token", async () => {
    const { person, seen } = signin([
      json(DEVICE_CODE),
      oauth("authorization_pending"),
      oauth("slow_down"),
      json(tokenBody()),
    ]);
    const shown: string[] = [];
    const token = await person.login({ onCode: (code) => void shown.push(code.verification_uri_complete) });
    expect(shown[0]).toMatch(/WXYZ-1234$/);
    expect([token.access_token, token.refresh_token]).toEqual(["at-1", "rt-1"]);
    expect(sleeps).toEqual([5000, 5000, 10000]);
    expect(form(seen[4]!.raw)).toEqual({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: "dev-code-1",
      client_id: NATIVE_CLIENT,
    });
  });

  it("throws when the person declines", async () => {
    const { person } = signin([json(DEVICE_CODE), oauth("access_denied", "The user denied it.")]);
    const error = await person.login({ onCode: () => undefined }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DeviceAuthError);
    expect((error as DeviceAuthError).code).toBe("access_denied");
    expect((error as Error).message).toMatch(/^The user denied it\./);
  });

  it("says when the deployment has no native client", async () => {
    const { fetch } = stubFetch([json({ auth_mode: "oidc", scopes: [] })]);
    await expect(new MatterWave({ baseUrl: BASE_URL, apiKey: null, fetch }).auth.person.start()).rejects.toThrow(
      /no native sign-in client/,
    );
  });

  it("keeps the refresh token when none is rotated in", async () => {
    const { person, seen } = signin([json(tokenBody("at-2", null))]);
    const old: PersonToken = { access_token: "at-1", token_type: "Bearer", expires_at: 0, refresh_token: "rt-1", id_token: null, scope: null };
    const next = await person.refresh(old);
    expect([next.access_token, next.refresh_token]).toEqual(["at-2", "rt-1"]);
    expect(form(seen[1]!.raw)).toEqual({ grant_type: "refresh_token", refresh_token: "rt-1", client_id: NATIVE_CLIENT });
  });

  it("reports a dead grant as the identity provider's error", async () => {
    const { person } = signin([oauth("invalid_grant")]);
    const token: PersonToken = { access_token: "a", token_type: "Bearer", expires_at: 0, refresh_token: "r", id_token: null, scope: null };
    const error = await person.refresh(token).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(APIError);
    expect((error as APIError).code).toBe("invalid_grant");
    expect((error as APIError).status).toBe(400);
  });

  it("refuses a token with no refresh token to refresh", async () => {
    const { person } = signin([]);
    const token: PersonToken = { access_token: "a", token_type: "Bearer", expires_at: 0, refresh_token: null, id_token: null, scope: null };
    await expect(person.refresh(token)).rejects.toThrow(MatterWaveError);
  });

  it("keeps a session fresh: refreshes ahead of expiry, once, and reports each new set", async () => {
    const { person, seen } = signin([json(tokenBody("at-2", "rt-2"))]);
    const stored: PersonToken[] = [];
    const soon: PersonToken = {
      access_token: "at-1",
      token_type: "Bearer",
      expires_at: Date.now() / 1000 + 30,
      refresh_token: "rt-1",
      id_token: null,
      scope: null,
    };
    const session = person.session(soon, { onRefresh: (t) => void stored.push(t) });
    const { fetch: apiFetch, seen: apiSeen } = stubFetch([json(ME), json(ME)]);
    const c = new MatterWave({ baseUrl: BASE_URL, accessToken: session.accessToken, fetch: apiFetch });
    await Promise.all([c.me(), c.me()]);
    expect(seen.filter((s) => s.url === TOKEN_ENDPOINT)).toHaveLength(1);
    expect(apiSeen.map((s) => s.headers.Authorization)).toEqual(["Bearer at-2", "Bearer at-2"]);
    expect(stored.map((t) => t.refresh_token)).toEqual(["rt-2"]);
    expect(session.token.access_token).toBe("at-2");
  });

  it("hands over a token far from expiry as it is", async () => {
    const { person, seen } = signin([]);
    const fresh: PersonToken = {
      access_token: "at-1",
      token_type: "Bearer",
      expires_at: Date.now() / 1000 + 3600,
      refresh_token: "rt-1",
      id_token: null,
      scope: null,
    };
    expect(await person.session(fresh).accessToken()).toBe("at-1");
    expect(seen).toHaveLength(0);
  });
});
