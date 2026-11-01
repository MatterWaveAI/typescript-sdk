/**
 * Signing a person in at the deployment's identity provider, for the routes
 * an API key can never call.
 *
 * An API key acts as its owner within its scopes, but the routes that
 * manage the organisation (members, invites, SSO, billing, the audit trail,
 * budget caps) gate on the caller's membership and refuse every key. A
 * person's access token from the identity provider is what they accept:
 * pass one as `accessToken` and the client sends it in place of a key.
 *
 *     const signin = new MatterWave({ baseUrl }).auth.person;
 *     const token = await signin.login({ onCode: (c) => console.log(c.verification_uri_complete) });
 *     const admin = new MatterWave({ baseUrl, accessToken: signin.session(token).accessToken });
 *
 * `login` is RFC 8628's device authorization grant against the identity
 * provider's public native client, the one `/api/auth-config` names
 * (`native_client_id`, `issuer_device_authorization_endpoint`,
 * `token_endpoint`); a deployment that configures none throws
 * `MatterWaveError` here. It asks for `offline_access` beside the
 * deployment's own scopes, so the answer carries a refresh token, and
 * `session(token).accessToken` is the function `accessToken` takes: it hands
 * over the access token and refreshes it a minute before it expires.
 * Nothing is stored; persist `session.token` (it holds the refresh token) in
 * the OS keyring or the editor's secret storage if the sign-in should
 * outlive the process.
 *
 * `client.auth.device` is the other device flow: the API's own, which ends
 * in an API key rather than a person's token.
 */

import { pause } from "./client.js";
import type { MatterWave, RequestOptions } from "./client.js";
import type { DeviceCode } from "./conversation-types.js";
import { APIError, APITimeoutError, DeviceAuthError, MatterWaveError, errorClassFor } from "./errors.js";

export const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
/** What a refresh token is asked for with; the deployment's own scopes do not include it, because the browser's session never needs one. */
export const OFFLINE_ACCESS = "offline_access";
/** Refresh this long before the access token expires, so a request started just before expiry does not reach the API with a dead token. */
export const REFRESH_AHEAD_S = 60;
/** The lifetime assumed when the token endpoint names none (it is optional in RFC 6749): short, because guessing long would hand out an expired token. */
export const DEFAULT_LIFETIME_S = 300;
const DEVICE_ERRORS = new Set(["authorization_pending", "slow_down", "expired_token", "access_denied"]);
// RFC 8628 section 3.5: each `slow_down` adds five seconds to the interval, for good.
const SLOW_DOWN_STEP_S = 5;

/** `GET /api/auth-config`, as the deployment sends it; the native client's fields are absent on a deployment that offers no native sign-in. */
export interface AuthConfig {
  auth_mode: string;
  issuer?: string | null;
  token_endpoint?: string | null;
  native_client_id?: string | null;
  issuer_device_authorization_endpoint?: string | null;
  scopes?: string[];
  [field: string]: unknown;
}

/** A person's token set from the identity provider. `expires_at` is in Unix seconds. */
export interface PersonToken {
  access_token: string;
  token_type: string;
  expires_at: number;
  refresh_token: string | null;
  id_token: string | null;
  scope: string | null;
}

export interface PersonLoginOptions {
  /** Show the person `verification_uri_complete` (or `verification_uri` and `user_code`). */
  onCode: (code: DeviceCode) => void | Promise<void>;
  /** Stop polling after this long; the code's own expiry otherwise. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Scopes beyond the deployment's own and `offline_access`. */
  scopes?: string[];
}

/** The deployment's scopes (its project audience among them, without which the API refuses the token as the wrong audience), then `offline_access`, then the caller's, each once. */
export function scopesFor(config: AuthConfig, extra: readonly string[] = []): string {
  const wanted: string[] = [];
  for (const scope of [...(config.scopes ?? []), "openid", OFFLINE_ACCESS, ...extra]) {
    if (!wanted.includes(scope)) wanted.push(scope);
  }
  return wanted.join(" ");
}

/** A token endpoint's answer as a `PersonToken`; a refresh that does not rotate the refresh token keeps `previousRefresh`, as RFC 6749 allows. */
export function personTokenFrom(data: Record<string, unknown>, now: number, previousRefresh: string | null = null): PersonToken {
  const token = data.access_token;
  if (typeof token !== "string" || token === "") {
    throw new MatterWaveError("The token endpoint answered without an access token.");
  }
  const lifetime = typeof data.expires_in === "number" ? data.expires_in : DEFAULT_LIFETIME_S;
  const refresh = typeof data.refresh_token === "string" && data.refresh_token !== "" ? data.refresh_token : previousRefresh;
  return {
    access_token: token,
    token_type: typeof data.token_type === "string" && data.token_type ? data.token_type : "Bearer",
    expires_at: now + lifetime,
    refresh_token: refresh,
    id_token: typeof data.id_token === "string" ? data.id_token : null,
    scope: typeof data.scope === "string" ? data.scope : null,
  };
}

/** A token or device endpoint's refusal: RFC 6749's `{ error, error_description }`; the device flow's own codes are `DeviceAuthError`. */
export function oauthError(status: number, raw: string): APIError {
  let payload: unknown;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    payload = null;
  }
  const object = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
  const code = typeof object.error === "string" ? object.error : null;
  const description = typeof object.error_description === "string" ? object.error_description : null;
  const message = description ?? code ?? `HTTP ${status}`;
  if (code !== null && DEVICE_ERRORS.has(code)) {
    return new DeviceAuthError(message, { status, code, body: payload });
  }
  const Cls = errorClassFor(status);
  return new Cls(message, { status, code, body: payload ?? raw });
}

function nowSeconds(): number {
  return Date.now() / 1000;
}

/** `client.auth.person`: sign a person in at the identity provider by device code, refresh their token, and keep it fresh for a client. */
export class PersonAuth {
  private cached: AuthConfig | null = null;

  constructor(private readonly client: MatterWave) {}

  /** `GET /api/auth-config`, read once per client and kept. */
  async config(options: RequestOptions = {}): Promise<AuthConfig> {
    if (this.cached === null) {
      this.cached = await this.client.json<AuthConfig>(
        { method: "GET", path: "/api/auth-config", body: undefined, keyed: false, stream: false },
        options,
      );
    }
    return this.cached;
  }

  private async native(): Promise<{ config: AuthConfig; clientId: string; deviceEndpoint: string; tokenEndpoint: string }> {
    const config = await this.config();
    if (!config.native_client_id || !config.issuer_device_authorization_endpoint) {
      throw new MatterWaveError(
        "This deployment offers no native sign-in client, so a person cannot sign in from here; use an API key, or a token from your identity provider.",
      );
    }
    if (!config.token_endpoint) throw new MatterWaveError("The deployment's auth config names no token endpoint.");
    return {
      config,
      clientId: config.native_client_id,
      deviceEndpoint: config.issuer_device_authorization_endpoint,
      tokenEndpoint: config.token_endpoint,
    };
  }

  private async post(url: string, form: Record<string, string>): Promise<Record<string, unknown>> {
    // Neither the client's credential nor its default headers go to the
    // identity provider: they are the API's.
    const response = await this.client.fetchExternal(url, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form),
    });
    const raw = await response.text();
    if (!response.ok) throw oauthError(response.status, raw);
    try {
      const payload: unknown = JSON.parse(raw);
      if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) return payload as Record<string, unknown>;
    } catch {
      // Not JSON: refused just below, as a body that is not an object is.
    }
    throw new APIError("The identity provider answered with a body that is not a JSON object.", {
      status: response.status,
      body: raw,
    });
  }

  /** Ask the identity provider for a code: show the person `verification_uri_complete` (or `verification_uri` and `user_code`). */
  async start(params: { scopes?: string[] } = {}): Promise<DeviceCode> {
    const { config, clientId, deviceEndpoint } = await this.native();
    const body = await this.post(deviceEndpoint, { client_id: clientId, scope: scopesFor(config, params.scopes) });
    const uri = String(body.verification_uri ?? "");
    return {
      device_code: String(body.device_code ?? ""),
      user_code: String(body.user_code ?? ""),
      verification_uri: uri,
      verification_uri_complete: typeof body.verification_uri_complete === "string" ? body.verification_uri_complete : uri,
      expires_in: typeof body.expires_in === "number" ? body.expires_in : 600,
      // RFC 8628 section 3.2: five seconds when the server names no interval.
      interval: typeof body.interval === "number" ? body.interval : 5,
    };
  }

  /** One poll of the token endpoint: the token set once approved; `DeviceAuthError` with RFC 8628's `code` while it is not. */
  async poll(deviceCode: string): Promise<PersonToken> {
    const { clientId, tokenEndpoint } = await this.native();
    const body = await this.post(tokenEndpoint, {
      grant_type: DEVICE_GRANT_TYPE,
      device_code: deviceCode,
      client_id: clientId,
    });
    return personTokenFrom(body, nowSeconds());
  }

  /**
   * Start, hand the code to `onCode` to show, and poll at the identity
   * provider's interval (longer after each `slow_down`) until the person
   * approves. `DeviceAuthError` when they decline or the code expires,
   * `APITimeoutError` when `timeoutMs` passes first.
   */
  async login(options: PersonLoginOptions): Promise<PersonToken> {
    const code = await this.start({ scopes: options.scopes });
    await options.onCode(code);
    let intervalS = Math.max(1, code.interval || 5);
    const expiresMs = (code.expires_in || 600) * 1000;
    const timedOut = options.timeoutMs !== undefined && options.timeoutMs < expiresMs;
    const deadline = Date.now() + (timedOut ? options.timeoutMs! : expiresMs);
    for (;;) {
      if (Date.now() + intervalS * 1000 > deadline) {
        throw timedOut
          ? new APITimeoutError(`The sign-in was not approved within ${options.timeoutMs}ms.`)
          : new DeviceAuthError("The sign-in code expired before it was approved.", { status: null, code: "expired_token" });
      }
      await pause(intervalS * 1000);
      if (options.signal?.aborted) throw new MatterWaveError("The sign-in was aborted.");
      try {
        return await this.poll(code.device_code);
      } catch (err) {
        if (!(err instanceof DeviceAuthError)) throw err;
        if (err.code === "slow_down") intervalS += SLOW_DOWN_STEP_S;
        else if (err.code !== "authorization_pending") throw err;
      }
    }
  }

  /** A fresh access token from the refresh token. An `APIError` whose `code` is `invalid_grant` means the grant is dead (revoked, or the refresh token expired): the person signs in again. */
  async refresh(token: PersonToken): Promise<PersonToken> {
    if (!token.refresh_token) throw new MatterWaveError("This token has no refresh token; sign the person in again.");
    const { clientId, tokenEndpoint } = await this.native();
    const body = await this.post(tokenEndpoint, {
      grant_type: "refresh_token",
      refresh_token: token.refresh_token,
      client_id: clientId,
    });
    return personTokenFrom(body, nowSeconds(), token.refresh_token);
  }

  /** The token set kept fresh; its `accessToken` is what the client's `accessToken` option takes. */
  session(token: PersonToken, options: { onRefresh?: (token: PersonToken) => void | Promise<void> } = {}): PersonSession {
    return new PersonSession(this, token, options.onRefresh);
  }
}

/**
 * A person's token set, kept fresh. `accessToken` (a bound function, so it
 * can be handed over as is) returns the access token, refreshing a minute
 * before expiry -- once, however many calls ask at the same moment -- and
 * hands each new set to `onRefresh`, so the caller can store the rotated
 * refresh token. `token` is the current set.
 */
export class PersonSession {
  private current: PersonToken;
  private refreshing: Promise<PersonToken> | null = null;

  constructor(
    private readonly auth: PersonAuth,
    token: PersonToken,
    private readonly onRefresh?: (token: PersonToken) => void | Promise<void>,
  ) {
    this.current = token;
  }

  get token(): PersonToken {
    return this.current;
  }

  readonly accessToken = async (): Promise<string> => {
    if (this.current.refresh_token && nowSeconds() + REFRESH_AHEAD_S >= this.current.expires_at) {
      this.refreshing ??= this.renew();
      try {
        await this.refreshing;
      } finally {
        this.refreshing = null;
      }
    }
    return this.current.access_token;
  };

  private async renew(): Promise<PersonToken> {
    const next = await this.auth.refresh(this.current);
    this.current = next;
    if (this.onRefresh) await this.onRefresh(next);
    return next;
  }
}
