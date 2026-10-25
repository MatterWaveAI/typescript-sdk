/**
 * Every failure the client throws, and the request id that goes with it.
 *
 * The API answers every refusal in OpenAI's envelope and stamps every
 * response, refusals included, with `X-Request-Id`. Both land on the error:
 * the envelope so code can branch on `code` (`insufficient_quota` is not
 * `rate_limit_exceeded`), the request id so a bug report can name the exact
 * call the server logged.
 */

export class MatterWaveError extends Error {
  /** The underlying failure, when there is one: the fetch rejection behind a connection error. */
  readonly cause?: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    // `super(message, { cause })` is ES2022; the ES2020 target Node 18 and
    // older browsers share does not type it, so the field is set by hand.
    super(message);
    this.name = new.target.name;
    if (options && "cause" in options) this.cause = options.cause;
  }
}

/** A keyed operation was called with no key: neither `apiKey` nor `MATTERWAVE_API_KEY`. */
export class MissingAPIKeyError extends MatterWaveError {}

/** The request never produced a response: DNS, refused, reset, TLS. */
export class APIConnectionError extends MatterWaveError {}

/** The request produced no response within `timeoutMs`. */
export class APITimeoutError extends APIConnectionError {}

/**
 * The window the server reported in `X-RateLimit-*`: its ceiling in requests
 * per minute, the requests left in it after this one, and the seconds until
 * the oldest request ages out and a slot is back.
 */
export interface RateLimit {
  limit: number;
  remaining: number;
  reset: number;
}

export interface APIErrorInit {
  /** Null for an error that arrived inside a stream, after the 200. */
  status: number | null;
  type?: string | null;
  code?: string | null;
  param?: string | null;
  requestId?: string | null;
  /** Seconds, from `Retry-After`, when the server sent it. */
  retryAfter?: number | null;
  /** From the `X-RateLimit-*` headers, when the server sent all three. */
  rateLimit?: RateLimit | null;
  body?: unknown;
}

/** A response the API sent to say no, parsed from its error envelope. */
export class APIError extends MatterWaveError {
  readonly status: number | null;
  readonly type: string | null;
  readonly code: string | null;
  readonly param: string | null;
  readonly requestId: string | null;
  readonly retryAfter: number | null;
  readonly rateLimit: RateLimit | null;
  readonly body: unknown;

  constructor(message: string, init: APIErrorInit) {
    super(message);
    this.status = init.status;
    this.type = init.type ?? null;
    this.code = init.code ?? null;
    this.param = init.param ?? null;
    this.requestId = init.requestId ?? null;
    this.retryAfter = init.retryAfter ?? null;
    this.rateLimit = init.rateLimit ?? null;
    this.body = init.body;
  }

  /** The message with the status, code and request id, for a log line. */
  describe(): string {
    const parts = [this.message];
    if (this.status !== null) parts.push(`(status ${this.status})`);
    if (this.code) parts.push(`[${this.code}]`);
    if (this.requestId) parts.push(`request_id=${this.requestId}`);
    return parts.join(" ");
  }
}

/** 400: a malformed body, an unsupported parameter, a non-text part. */
export class BadRequestError extends APIError {}
/** 401: no key, or an invalid, expired or revoked one. */
export class AuthenticationError extends APIError {}
/** 403: the key lacks the scope, or the account is suspended. */
export class PermissionDeniedError extends APIError {}
/** 404: an unknown model, or a conversation that is not the key owner's. */
export class NotFoundError extends APIError {}
/** 409: valid, but the state does not allow it, such as a compaction with nothing to fold yet. */
export class ConflictError extends APIError {}
/**
 * 429: the per-key window, or the organisation's monthly budget. `code`
 * tells them apart: `rate_limit_exceeded` clears when `retryAfter` seconds
 * have passed and is retried by the client; `insufficient_quota` clears when
 * an admin raises the budget, so it is thrown at once. `rateLimit` is the
 * window that refused, from the `X-RateLimit-*` headers (null when the
 * server sent none, as on `insufficient_quota`): what to pace by once the
 * wait is over.
 */
export class RateLimitError extends APIError {}
/** 5xx: the API or the model gateway behind it failed. */
export class ServerError extends APIError {}

/**
 * A device login the server has not approved. `code` is RFC 8628's:
 * `authorization_pending` and `slow_down` mean poll again (later, for the
 * second); `expired_token` and `access_denied` mean start over.
 */
export class DeviceAuthError extends APIError {}

export function errorClassFor(status: number): new (message: string, init: APIErrorInit) => APIError {
  if (status === 400) return BadRequestError;
  if (status === 401) return AuthenticationError;
  if (status === 403) return PermissionDeniedError;
  if (status === 404) return NotFoundError;
  if (status === 409) return ConflictError;
  if (status === 429) return RateLimitError;
  if (status >= 500) return ServerError;
  return APIError;
}
