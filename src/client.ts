/**
 * The client. `fetch`-based, so it runs in Node 20+, Bun, Deno and browsers
 * alike; nothing here imports a Node module or any other package.
 *
 *     const client = new MatterWave({ apiKey: "mw_...", baseUrl: "https://your-matterwave.example" });
 *     const completion = await client.chat.completions.create({
 *       messages: [{ role: "user", content: "Say hello in five words." }],
 *     });
 *     console.log(completion.choices[0].message.content);
 *
 *     const stream = await client.chat.completions.create({ messages, stream: true });
 *     for await (const text of stream.text()) process.stdout.write(text);
 *
 * A 429 (the per-key window) is retried `maxRetries` times with backoff,
 * honouring `Retry-After` when the server sends it; a 429 whose code is
 * `insufficient_quota` is not, because waiting does not refill a budget. A
 * 5xx or a dropped connection is retried the same way for a request that is
 * safe to send twice (GET, PUT, DELETE); a POST or PATCH is sent again only
 * when the connection was never made, since the first copy may already have
 * taken effect. Every error carries the `X-Request-Id` the server stamped on
 * the refusal, and every write an `Idempotency-Key` that stays the same
 * across its retries.
 */

import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  CONNECTOR_CONVERSATION_CODE,
  ConnectorConversationError,
  MatterWaveError,
  MissingAPIKeyError,
  ParseError,
  errorClassFor,
} from "./errors.js";
import type { RateLimit } from "./errors.js";
import { Auth, Conversations, Instructions, Messages } from "./conversations.js";
import { Mcp } from "./mcp.js";
import { Admin, Announcements, Attachments, Audit, BudgetClient, EntitlementsClient, Keys, LibraryClient, Notifications, Shares, UsageClient, Webhooks } from "./native.js";
import { Accounts, Mfa, Passkeys, Sync } from "./native.js";
import { Account, Billing, Exports, Imports, Plans, Policy, PreferencesClient, Sessions, Speech } from "./account.js";
import { InviteLinks, Invites, Members, OrgClient } from "./org.js";
import { Connections, Presets } from "./connectors.js";
import { buildPiProviderConfig, createMatterWavePiExtension } from "./pi/provider.js";
import { PiRpcClient, type PiRpcClientOptions } from "./pi/rpc.js";
import type { MatterWavePiOptions, PiNamespace, PiRpcEvent } from "./pi/types.js";
import { sseDataFrames } from "./sse.js";
import { LOG_ENV, RequestLog, logLevelOf } from "./log.js";
import type { LogLevel, Logger } from "./log.js";
import { ChatCompletionAccumulator } from "./accumulate.js";
import type {
  ApiIndex,
  AssistantMessage,
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionRequest,
  EmbeddingList,
  EmbeddingsRequest,
  Model,
  ModelList,
  WithRequestId,
} from "./types.js";
import type { Me } from "./conversation-types.js";
import type { AppModelList } from "./conversation-types.js";
import type { ConversationSource } from "./conversation-types.js";
import type {
  CheckpointList,
  ConnectorCatalogList,
  CredentialProxyResponse,
  DecisionTrail,
  EnforceClaimsResult,
  EnforceOidcClaimsParams,
  EvaluateGuardrailsOptions,
  GetReliabilityMetricsOptions,
  GrtSuiteManifest,
  GuardrailEvaluation,
  GuardrailType,
  HitlInteraction,
  HitlInteractionList,
  ListConnectorCatalogParams,
  ListHitlInteractionsOptions,
  OAuthAuthenticator,
  OidcConfig,
  OidcSyncResult,
  PlanToolsOptions,
  ProxyOAuthRequestOptions,
  RegisterOAuthAuthenticatorParams,
  ReliabilityMetrics,
  ReliabilitySloReport,
  ReliabilityTrends,
  ReplayMode,
  ReplayRunOptions,
  ReplayRunResult,
  RerankOptions,
  RerankResponse,
  RespondHitlInteractionOptions,
  ResumeRunOptions,
  ResumeRunResult,
  SpeechSynthesisResponse,
  SynthesizeSpeechOptions,
  TelemetryExecutionMetrics,
  TelemetryStackStatus,
  ToolPlan,
} from "./platform-types.js";

export const VERSION = "0.5.0";
export const API_KEY_ENV = "MATTERWAVE_API_KEY";
export const BASE_URL_ENV = "MATTERWAVE_BASE_URL";
const API_PREFIX = "/v1";
const REQUEST_ID_HEADER = "x-request-id";
export const IDEMPOTENCY_HEADER = "Idempotency-Key";
const SSE_DONE = "[DONE]";
const USER_AGENT = `matterwave-typescript/${VERSION}`;

export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_RETRIES = 2;
// Backoff for a retry the server gave no `Retry-After` for: 0.5s, 1s, 2s ...
// capped, with jitter so a fleet of clients does not retry in lockstep.
export const BACKOFF_BASE_MS = 500;
export const BACKOFF_CAP_MS = 8_000;
// The longest a retry may wait. A `Retry-After` beyond it (an hour, say) is
// the server's way of saying "not now"; the error is thrown rather than the
// call hanging until then, and carries the delay for the caller to decide.
export const DEFAULT_MAX_RETRY_WAIT_MS = 60_000;
// A 429 the server says is the organisation's budget, not the window.
const NON_RETRYABLE_429_CODES = new Set(["insufficient_quota"]);
// Methods a second copy of cannot add anything the first did not: reads, and
// the PUT and DELETE routes, which set a state rather than append one. A POST
// or a PATCH that failed after reaching the server may have taken effect -- a
// message stored and billed, a key minted -- so it is only sent again when the
// failure proves the server never acted on it.
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "OPTIONS", "PUT", "DELETE"]);
// Methods that only read. Every other request is a write and carries an
// `Idempotency-Key`, one per call and the same on each retry of it, so a
// server that keeps the keys can answer a repeat with the first result.
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
// Error codes for a connection that was never made, so no byte of the request
// was written: Node's (libuv and undici) and Bun's names for them. A reset or
// a timeout after connecting leaves open whether the server acted.
const UNSENT_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "ConnectionRefused",
  "FailedToOpenSocket",
]);

/**
 * The last HTTP response the client received, whatever became of it:
 * status and headers as they travelled, with the pieces the parsed models
 * leave behind -- the request id, the retry delay, the rate-limit window.
 * `client.lastResponse` holds it, so `X-RateLimit-*` and the ids are
 * reachable on a refusal as well as on a success.
 */
export class RawResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly requestId: string | null;
  readonly retryAfter: number | null;
  readonly rateLimit: RateLimit | null;

  constructor(response: Response) {
    this.status = response.status;
    this.headers = response.headers;
    this.requestId = response.headers.get(REQUEST_ID_HEADER);
    this.retryAfter = retryAfterSeconds(response);
    this.rateLimit = rateLimitOf(response);
  }

  /** One header's value, whichever case the server sent the name in. */
  header(name: string): string | null {
    return this.headers.get(name);
  }
}

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/** A function asked for a person's access token before each call: a `PersonSession`'s `accessToken`, or the caller's own refresher. */
export type AccessTokenProvider = () => string | Promise<string>;

export interface ClientOptions {
  /** Defaults to `MATTERWAVE_API_KEY`. Only `index()` works without one. */
  apiKey?: string | null;
  /**
   * A person's token from the identity provider, in place of a key: the
   * token itself, or a function asked for it before each call
   * (`client.auth.person.session(token).accessToken` refreshes). The routes
   * that manage the organisation (`CREDENTIALS` marks them `person`) take
   * nothing else; every other route takes either. Not with `apiKey`.
   */
  accessToken?: string | AccessTokenProvider | null;
  /** The origin the API is served from; defaults to `MATTERWAVE_BASE_URL`. The OpenAI-style form ending in `/v1` is accepted too. */
  baseUrl?: string | null;
  /** Per attempt. The default is 60 seconds. */
  timeoutMs?: number;
  /** Retries after the first attempt, for 429 and 5xx. The default is 2. */
  maxRetries?: number;
  /** The longest one retry may wait. A `Retry-After` beyond it throws the error instead, `retryAfter` set. The default is 60 seconds. */
  maxRetryWaitMs?: number;
  /** Sent on every request, under the ones the client sets. */
  defaultHeaders?: Record<string, string>;
  /** A replacement `fetch`: a mock in tests, a wrapped one in an app. */
  fetch?: Fetch;
  /**
   * Allow an API key in a browser. A key in a page's JavaScript is readable
   * by anyone who loads the page, so the client refuses one there unless
   * this says the exposure is understood -- a key scoped and rate-limited
   * for exactly that page, say. Without a key the client runs anywhere.
   */
  dangerouslyAllowBrowser?: boolean;
  /**
   * `info` logs a line per response or failure (method, path, status,
   * request id, time); `debug` adds each attempt and each retry's wait.
   * Never a body or a header. Defaults to `MATTERWAVE_LOG`, else `off`.
   */
  logLevel?: LogLevel;
  /** Where the log lines and deprecation warnings go; the console by default. */
  logger?: Logger;
  /** The request about to go out, for logging: method and path, once per attempt (a retry fires it again). A hook that throws fails the call. */
  onRequest?: (request: { method: string; path: string }) => void;
  /** The response that came back, success or refusal, once per attempt. A hook that throws fails the call. */
  onResponse?: (response: RawResponse) => void;
}

export interface RequestOptions {
  /** Aborts the request, and a stream being read. */
  signal?: AbortSignal;
  /** Headers for this one call, over the client's and the operation's. */
  extraHeaders?: Record<string, string>;
  /** The earlier name of `extraHeaders`, kept as its alias; `extraHeaders` wins where both name a header. */
  headers?: Record<string, string>;
  /** Query parameters added to this call's URL: a filter the API knows and this client does not yet. */
  extraQuery?: Record<string, string>;
  /**
   * Fields merged into this call's JSON body, over the ones the method sets:
   * a field the API knows and this client does not yet. Refused for a GET,
   * which has no body, and for an upload, whose body is a form.
   */
  extraBody?: Record<string, unknown>;
  /**
   * Per attempt, for this one call, overriding the client's `timeoutMs`:
   * a single long call can take minutes without holding the whole client
   * at its pace.
   */
  timeoutMs?: number;
  /** Retries after the first attempt, for this one call, overriding the client's `maxRetries`. */
  maxRetries?: number;
  /** The longest one retry of this call may wait, overriding the client's `maxRetryWaitMs`. */
  maxRetryWaitMs?: number;
  /**
   * The `Idempotency-Key` this write carries on every attempt, in place of
   * the fresh UUID it would get: for a write whose retries may come from
   * another process (a job queue's id, say). Ignored on a read.
   */
  idempotencyKey?: string;
}

/** The settings `withOptions` may replace; anything left out keeps the client's. */
export interface ClientOverrides {
  timeoutMs?: number;
  maxRetries?: number;
  maxRetryWaitMs?: number;
  /** Added to the client's `defaultHeaders`, replacing any of the same name. */
  defaultHeaders?: Record<string, string>;
  /** The key every write made through the view carries, as `RequestOptions.idempotencyKey`: make one view per write. */
  idempotencyKey?: string;
}

/** A fresh key for one write: a random (version 4) UUID, as Stripe and OpenAI send. */
export function newIdempotencyKey(): string {
  const crypto = (globalThis as { crypto?: Crypto }).crypto;
  // `randomUUID` needs a secure context in a browser; `getRandomValues` does not.
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  if (typeof crypto?.getRandomValues !== "function") {
    throw new MatterWaveError("No Web Crypto in this runtime to make an idempotency key with.");
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** @internal One operation, ready for `send`. */
export interface Prepared {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  /** JSON, or a `FormData` sent as multipart for an upload. */
  body: unknown;
  keyed: boolean;
  stream: boolean;
  /** Headers the operation itself needs, such as `Last-Event-ID` on a resume. */
  headers?: Record<string, string>;
  /** This request's timeout, where the client's default is wrong for it: an MCP tool that runs a whole model turn takes minutes, not seconds. */
  timeoutMs?: number;
  /** Whether sending it twice is harmless. Left out, the method decides; a POST that only reads (an MCP `tools/list`) says true. */
  idempotent?: boolean;
}

/** @internal Whether a failed attempt at `prepared` may be sent again whatever became of it. */
export function safeToRepeat(prepared: Pick<Prepared, "method" | "idempotent">): boolean {
  return prepared.idempotent ?? IDEMPOTENT_METHODS.has(prepared.method);
}

/**
 * Whether a fetch that threw failed before the request left: the connection
 * was refused or the name did not resolve. Runtimes nest the reason (undici's
 * `fetch failed` carries it as `cause`, sometimes an `AggregateError` of one
 * per address), so the chain is walked.
 */
export function neverSent(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth += 1) {
    const { code, errors, cause } = current as { code?: unknown; errors?: unknown; cause?: unknown };
    if (typeof code === "string" && UNSENT_CODES.has(code)) return true;
    if (Array.isArray(errors) && errors.length > 0 && errors.every((e) => neverSent(e))) return true;
    current = cause;
  }
  return false;
}

/** @internal A setting from the environment, or null where there is none to read. */
export function envValue(name: string): string | null {
  // `process` exists in Node, Bun and Deno and in bundlers that polyfill it;
  // in a browser there is no environment to read, and Deno without
  // `--allow-env` throws on the read. Either way the setting is unset.
  try {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
      ?.env;
    const value = env?.[name]?.trim();
    return value ? value : null;
  } catch {
    return null;
  }
}

/** Whether this is a page or a worker in a browser, where a key would be in the page's reach. */
export function inBrowser(): boolean {
  const scope = globalThis as { window?: { document?: unknown }; WorkerGlobalScope?: unknown; importScripts?: unknown };
  if (typeof scope.window?.document !== "undefined") return true;
  return typeof scope.WorkerGlobalScope !== "undefined" && typeof scope.importScripts === "function";
}

/** What `parse` validates with: anything whose `parse` returns the value or throws, as a zod schema does. */
export interface Schema<T> {
  parse(data: unknown): T;
}

export function resolveBaseUrl(baseUrl: string | null | undefined): string {
  let value = (baseUrl ?? envValue(BASE_URL_ENV) ?? "").trim();
  if (value === "") {
    throw new MatterWaveConfigError(
      `No base URL: pass baseUrl or set ${BASE_URL_ENV} to the MatterWave origin.`,
    );
  }
  value = value.replace(/\/+$/, "");
  if (value.endsWith(API_PREFIX)) value = value.slice(0, -API_PREFIX.length);
  if (!/^https?:\/\//.test(value)) {
    throw new MatterWaveConfigError(`baseUrl must start with http:// or https://, got ${value}`);
  }
  return value;
}

/**
 * A client option or argument that cannot be used: no origin, a bad origin,
 * a negative retry count, an id that would change the path. A
 * `MatterWaveError`, so one `catch` covers everything the client throws.
 */
export class MatterWaveConfigError extends MatterWaveError {
  constructor(message: string) {
    super(message);
  }
}

/** `Retry-After` in seconds, whether the server sent a delay or a date. */
export function retryAfterSeconds(response: Response): number | null {
  const raw = response.headers.get("retry-after");
  if (raw === null) return null;
  const seconds = Number(raw.trim());
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const when = Date.parse(raw);
  if (Number.isNaN(when)) return null;
  return Math.max(0, (when - Date.now()) / 1000);
}

/**
 * The `X-RateLimit-*` trio, when the server sent all three as integers; a
 * partial or malformed set is treated as none rather than guessed at.
 */
export function rateLimitOf(response: Response): RateLimit | null {
  const limit = rateLimitHeader(response, "x-ratelimit-limit");
  const remaining = rateLimitHeader(response, "x-ratelimit-remaining");
  const reset = rateLimitHeader(response, "x-ratelimit-reset");
  if (limit === null || remaining === null || reset === null) return null;
  return { limit, remaining, reset };
}

function rateLimitHeader(response: Response, name: string): number | null {
  const raw = response.headers.get(name)?.trim();
  if (!raw) return null;
  const value = Number(raw);
  return Number.isInteger(value) ? value : null;
}

/** How long to wait before retry number `attempt` (0-based), in milliseconds. */
export function backoffMs(attempt: number, retryAfterSeconds: number | null): number {
  if (retryAfterSeconds !== null) return retryAfterSeconds * 1000;
  const base = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return base * (0.5 + Math.random() * 0.5);
}

function withRequestId<T extends object>(value: T, requestId: string | null): WithRequestId<T> {
  Object.defineProperty(value, "requestId", { value: requestId, enumerable: false });
  return value as WithRequestId<T>;
}

function parseErrorBody(raw: string): { envelope: boolean; payload: unknown } {
  try {
    const payload: unknown = raw ? JSON.parse(raw) : null;
    const error = (payload as { error?: unknown } | null)?.error;
    return { envelope: typeof error === "object" && error !== null, payload };
  } catch {
    return { envelope: false, payload: raw };
  }
}

/** A FastAPI `detail` as one line: the string, or a 422's per-field messages joined. */
function detailText(detail: unknown): string | null {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    const messages = detail
      .map((d) => (typeof d === "object" && d !== null ? (d as { msg?: unknown }).msg : null))
      .filter((m): m is string => typeof m === "string" && m !== "");
    return messages.length > 0 ? messages.join("; ") : null;
  }
  return null;
}

export function errorFromResponse(response: Response, raw: string): APIError {
  const { envelope, payload } = parseErrorBody(raw);
  const Cls = errorClassFor(response.status);
  const retryAfter = retryAfterSeconds(response);
  const rateLimit = rateLimitOf(response);
  const object =
    typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : null;
  const requestId =
    response.headers.get(REQUEST_ID_HEADER) ??
    (typeof object?.request_id === "string" ? object.request_id : null);
  if (envelope) {
    const error = (payload as { error: Record<string, unknown> }).error;
    return new Cls(String(error.message ?? `HTTP ${response.status}`), {
      status: response.status,
      type: typeof error.type === "string" ? error.type : null,
      code: typeof error.code === "string" ? error.code : null,
      param: typeof error.param === "string" ? error.param : null,
      requestId,
      retryAfter,
      rateLimit,
      body: payload,
    });
  }
  const detail = detailText(object?.detail);
  if (detail) {
    // The app's own routes answer `{"detail": ..., "request_id": ...}`,
    // FastAPI's shape with the ids beside it, rather than OpenAI's. A few
    // put a `code` beside the detail, and one of those names the thread
    // the conversation is answered in.
    const code = typeof object?.code === "string" ? object.code : null;
    if (response.status === 409 && code === CONNECTOR_CONVERSATION_CODE) {
      return new ConnectorConversationError(detail, {
        status: response.status,
        requestId,
        retryAfter,
        rateLimit,
        body: payload,
        source: sourceOf(object?.source),
      });
    }
    return new Cls(detail, { status: response.status, code, requestId, retryAfter, rateLimit, body: payload });
  }
  const text = raw.trim();
  const message = text ? `HTTP ${response.status}: ${text.slice(0, 200)}` : `HTTP ${response.status}`;
  return new Cls(message, { status: response.status, requestId, retryAfter, rateLimit, body: payload });
}

/** The thread a `connector_conversation` refusal names, in the shape a conversation carries it. */
function sourceOf(value: unknown): ConversationSource {
  const object = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const text = (field: unknown): string | null => (typeof field === "string" ? field : null);
  return {
    connector: text(object.connector) ?? "",
    connection_id: text(object.connection_id),
    channel_label: text(object.channel_label),
    url: text(object.url),
  };
}

function errorFromEnvelope(payload: Record<string, unknown>, requestId: string | null): APIError {
  const error = (payload.error ?? {}) as Record<string, unknown>;
  return new APIError(String(error.message ?? "The stream ended with an error."), {
    status: null,
    type: typeof error.type === "string" ? error.type : null,
    code: typeof error.code === "string" ? error.code : null,
    param: typeof error.param === "string" ? error.param : null,
    requestId,
    body: payload,
  });
}

/**
 * 429, except the one that means the budget is spent, and 5xx for a request
 * that is safe to repeat. A 429 is the server declining before the route
 * runs, so it is retried whatever the method; a 5xx may come after a write
 * took effect (a gateway timing out on a reply the app was still sending),
 * so a POST is not sent again on one.
 */
export function shouldRetry(response: Response, raw: string, repeatable = true): boolean {
  if (response.status >= 500) return repeatable;
  if (response.status !== 429) return false;
  const { envelope, payload } = parseErrorBody(raw);
  if (!envelope) return true;
  const code = (payload as { error: { code?: unknown } }).error.code;
  return !(typeof code === "string" && NON_RETRYABLE_429_CODES.has(code));
}

/** A frame's object, or null for `[DONE]`. An error envelope on a frame is thrown here. */
export function decodeStreamFrame(frame: string, requestId: string | null): Record<string, unknown> | null {
  if (frame.trim() === SSE_DONE) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(frame);
  } catch {
    throw new APIError("The stream carried a frame that is not JSON.", {
      status: null,
      requestId,
      body: frame,
    });
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new APIError("The stream carried a frame that is not an object.", {
      status: null,
      requestId,
      body: payload,
    });
  }
  const object = payload as Record<string, unknown>;
  if ("error" in object && !("choices" in object)) throw errorFromEnvelope(object, requestId);
  return object;
}

/**
 * A streamed completion: `for await` it for chunks, or `text()` for just
 * the words. `abort()` (or the request's `signal`) stops it early; the
 * server records what was sent as a truncated turn when the call asked for
 * persistence.
 */
export class Stream implements AsyncIterable<WithRequestId<ChatCompletionChunk>> {
  readonly requestId: string | null;
  private consumed = false;

  constructor(
    private readonly response: Response,
    private readonly controller: AbortController,
  ) {
    this.requestId = response.headers.get(REQUEST_ID_HEADER);
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<WithRequestId<ChatCompletionChunk>> {
    if (this.consumed) throw new MatterWaveError("A stream can be iterated once.");
    this.consumed = true;
    const body = this.response.body;
    if (body === null) {
      throw new APIError("The stream has no body.", { status: null, requestId: this.requestId });
    }
    try {
      for await (const frame of sseDataFrames(body)) {
        const payload = decodeStreamFrame(frame, this.requestId);
        if (payload === null) return;
        yield withRequestId(payload as unknown as ChatCompletionChunk, this.requestId);
      }
    } finally {
      // Whether the loop ended, threw or was broken out of: let go of the
      // connection, which is what a `break` in a `for await` expects.
      this.controller.abort();
    }
  }

  /** The text each chunk adds, skipping the role, stop and usage frames. */
  async *text(): AsyncGenerator<string> {
    for await (const chunk of this) {
      const content = chunk.choices[0]?.delta.content;
      if (content) yield content;
    }
  }

  /** Drain the stream and return the whole answer: every chunk's text joined. Iterate for the pieces, call this for the whole. */
  async finalText(): Promise<string> {
    let text = "";
    for await (const piece of this.text()) text += piece;
    return text;
  }

  /** @deprecated The earlier name of `finalText`, kept as its alias. */
  accumulate(): Promise<string> {
    return this.finalText();
  }

  /**
   * Drain the stream and return the assistant message it spelled out: the
   * text, and each tool call reassembled from its fragments, ready to run
   * and to send back in the next request's `messages`. `finalCompletion()`
   * has the finish reason and usage as well.
   */
  async finalMessage(): Promise<AssistantMessage> {
    const accumulator = new ChatCompletionAccumulator();
    for await (const chunk of this) accumulator.add(chunk);
    return accumulator.message();
  }

  /**
   * Drain the stream and return the whole answer as the non-streamed call
   * would have: the message with its tool calls reassembled, the finish
   * reason, the usage (all zeros unless the call asked for it with
   * `stream_options: { include_usage: true }`), the id and the model.
   */
  async finalCompletion(): Promise<WithRequestId<ChatCompletion>> {
    const accumulator = new ChatCompletionAccumulator();
    for await (const chunk of this) accumulator.add(chunk);
    return withRequestId(accumulator.completion(), this.requestId);
  }

  abort(): void {
    this.controller.abort();
  }
}

export class Completions {
  constructor(private readonly client: MatterWave) {}

  /**
   * `POST /v1/chat/completions`. `messages` is the whole prompt; the server
   * prefixes nothing. `model` omitted is the deployment's default.
   * `metadata.conversation_id` records the turn into that conversation of
   * the key owner's (the request is stateless otherwise).
   */
  create(
    params: ChatCompletionCreateParamsStreaming,
    options?: RequestOptions,
  ): Promise<Stream>;
  create(
    params: ChatCompletionCreateParamsNonStreaming,
    options?: RequestOptions,
  ): Promise<WithRequestId<ChatCompletion>>;
  async create(
    params: ChatCompletionRequest,
    options: RequestOptions = {},
  ): Promise<Stream | WithRequestId<ChatCompletion>> {
    if (!Array.isArray(params.messages) || params.messages.length === 0) {
      throw new MatterWaveConfigError("messages must contain at least one message");
    }
    const stream = params.stream === true;
    const prepared: Prepared = {
      method: "POST",
      path: "/v1/chat/completions",
      body: params,
      keyed: true,
      stream,
    };
    if (stream) {
      const { response, controller } = await this.client.send(prepared, options);
      return new Stream(response, controller);
    }
    return this.client.json<ChatCompletion>(prepared, options);
  }

  /**
   * `create` plus validation: the answer's text is read as JSON and parsed
   * by the caller's `schema` -- a zod schema, or anything with a `parse`
   * that returns the value or throws -- whose value comes back: the
   * `.parse({ schema })` the peers ship. This package does not depend on
   * zod; the schema brings its own.
   *
   * The model is asked for a JSON object (`response_format` of
   * `json_object`) unless the caller passes their own in `params`; send
   * `response_format: { type: "json_schema", ... }` when the backend
   * serves schema enforcement. Every other field of `params` goes to
   * `create` unchanged.
   *
   * `ParseError` when the answer is empty or is not JSON; a schema failure
   * throws the schema's own error (zod's `ZodError`), which says which
   * field the model got wrong.
   */
  async parse<T>(
    params: ChatCompletionCreateParamsNonStreaming & { schema: Schema<T> },
    options: RequestOptions = {},
  ): Promise<T> {
    const { schema, ...request } = params;
    if (!Array.isArray(request.messages) || request.messages.length === 0) {
      throw new MatterWaveConfigError("messages must contain at least one message");
    }
    const completion = (await this.create(
      { ...request, response_format: request.response_format ?? { type: "json_object" } },
      options,
    )) as WithRequestId<ChatCompletion>;
    const content = completion.choices[0]?.message?.content;
    if (typeof content !== "string" || content.trim() === "") {
      throw new ParseError(
        "The model answered with no content to parse (a tool call or an empty message, not a JSON object).",
        { body: completion },
      );
    }
    let data: unknown;
    try {
      data = JSON.parse(content);
    } catch {
      throw new ParseError(
        "The model's answer is not JSON, so it cannot be validated against the schema.",
        { body: content },
      );
    }
    return schema.parse(data);
  }
}

export class Chat {
  readonly completions: Completions;
  constructor(client: MatterWave) {
    this.completions = new Completions(client);
  }
}

export class Embeddings {
  constructor(private readonly client: MatterWave) {}

  /**
   * `POST /v1/embeddings`: one embedding per input. A deployment serves one
   * embedding model, so `model` may be omitted; `index()` says under
   * `capabilities.embeddings` whether one is configured and which.
   */
  create(params: EmbeddingsRequest, options: RequestOptions = {}): Promise<WithRequestId<EmbeddingList>> {
    const empty = typeof params.input === "string" ? params.input === "" : params.input.length === 0;
    if (empty) throw new MatterWaveConfigError("input must be a string or a non-empty list");
    return this.client.json<EmbeddingList>(
      { method: "POST", path: "/v1/embeddings", body: params, keyed: true, stream: false },
      options,
    );
  }
}

export class Models {
  constructor(private readonly client: MatterWave) {}

  /** `GET /v1/models`: what the gateway serves. */
  list(options: RequestOptions = {}): Promise<WithRequestId<ModelList>> {
    return this.client.json<ModelList>(
      { method: "GET", path: "/v1/models", body: undefined, keyed: true, stream: false },
      options,
    );
  }

  /** `GET /v1/models/{model_id}`; `NotFoundError` for one not served. */
  retrieve(modelId: string, options: RequestOptions = {}): Promise<WithRequestId<Model>> {
    if (!modelId || modelId.includes("/")) {
      throw new MatterWaveConfigError(`modelId must be a non-empty id without '/', got ${modelId}`);
    }
    return this.client.json<Model>(
      {
        method: "GET",
        path: `/v1/models/${encodeURIComponent(modelId)}`,
        body: undefined,
        keyed: true,
        stream: false,
      },
      options,
    );
  }
}

export class MatterWave {
  readonly baseUrl: string;
  readonly chat: Chat;
  readonly models: Models;
  readonly embeddings: Embeddings;
  /** The app's conversations, as the key's owner sees them in the web app. */
  readonly conversations: Conversations;
  /** The caller's own ratings of replies. */
  readonly messages: Messages;
  /** Custom instructions: the user's, the org's, and how they combine. */
  readonly instructions: Instructions;
  /** Device login: a key for a person, approved in their browser. */
  readonly auth: Auth;
  /** The org's API keys: create, edit, rotate, revoke. */
  readonly keys: Keys;
  /** The balance this period, the per-member month, and its CSV. */
  readonly usage: UsageClient;
  /** The org's audit trail: who changed what, one page or the CSV. */
  readonly audit: Audit;
  /** Outbound webhook endpoints and their delivery log. */
  readonly webhooks: Webhooks;
  /** Files to attach to a message. */
  readonly attachments: Attachments;
  /** Folders, tags and search across the caller's conversations. */
  readonly library: LibraryClient;
  /** Read-only links to a snapshot of a conversation. */
  readonly shares: Shares;
  /** The org's allowance, its overage, and the caps that stop it. */
  readonly budget: BudgetClient;
  /** The caller's notifications: the bell, read one or all. */
  readonly notifications: Notifications;
  /** The operator's announcements, active now. */
  readonly announcements: Announcements;
  /** What the caller's org is allowed to do: the plan and its limits. */
  readonly entitlements: EntitlementsClient;
  /** The operator surface: the admin console's routes, the platform `admin` role. */
  readonly admin: Admin;
  /** The `/mcp` JSON-RPC endpoint: list tools, call one, send a message. */
  readonly mcp: Mcp;
  /** The caller's own account: their name, the terms, enforcement, password, email, sessions, preferences, onboarding and deletion. */
  readonly account: Account;
  /** The mail the caller gets, their notices and their locale. */
  readonly preferences: PreferencesClient;
  /** The browsers signed in as the caller: list them, sign one out, or all the others. */
  readonly sessions: Sessions;
  /** Everything the account holds, as one JSON document or as a job: start, poll, download. */
  readonly exports: Exports;
  /** Conversations brought over from ChatGPT's or Claude's data export. */
  readonly imports: Imports;
  /** Dictation: the words in an audio clip. */
  readonly speech: Speech;
  /** The org's billing: the catalog, the status any member reads, and checkout, the portal, invoices and plan changes for an owner or admin. */
  readonly billing: Billing;
  /** The public price list, read with no credential. */
  readonly plans: Plans;
  /** The public policy page's counts, read with no credential. */
  readonly policy: Policy;
  /** The organisation and its settings, domains and identity providers; a person's token. */
  readonly org: OrgClient;
  /** Who is in the org and in what role, with its invites and links; a person's token. */
  readonly members: Members;
  /** Invitations by email, and accepting one; a person's token. */
  readonly invites: Invites;
  /** Shareable join links, and joining through one; a person's token. */
  readonly inviteLinks: InviteLinks;
  /** Passkeys: registration for the signed-in, the sign-in ceremony for everyone. */
  readonly passkeys: Passkeys;
  /** The second factor: TOTP enrolment, recovery codes, the sign-in code step. */
  readonly mfa: Mfa;
  /** Several accounts on one browser: the roster, the switch, the sign-outs. */
  readonly accounts: Accounts;
  /** Edge pairing and sync: an admin mints codes, a device key pushes. */
  readonly sync: Sync;
  /** The org's agent presets: any member reads them, an owner or admin writes them. */
  readonly presets: Presets;
  /** The org's connectors to outside workspaces, their routes, identities and event log; a person's token. */
  readonly connections: Connections;
  /** The last HTTP response received, success or refusal; null until something has been sent. */
  private _lastResponse: RawResponse | null = null;
  private _pi: PiNamespace | null = null;
  private readonly apiKey: string | null;
  private readonly accessToken: string | AccessTokenProvider | null;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly maxRetryWaitMs: number;
  /** Set only on a `withOptions` view: the key its writes carry. */
  private idempotencyKey: string | null = null;
  private readonly defaultHeaders: Record<string, string>;
  private readonly fetchImpl: Fetch;
  private readonly onRequest: ((request: { method: string; path: string }) => void) | null;
  private readonly onResponse: ((response: RawResponse) => void) | null;
  private readonly allowBrowser: boolean;
  private readonly log: RequestLog;

  constructor(options: ClientOptions = {}) {
    const accessToken = options.accessToken ?? null;
    if (accessToken !== null && options.apiKey != null) {
      throw new MatterWaveConfigError("pass apiKey or accessToken, not both: each is the whole bearer");
    }
    if (accessToken !== null && typeof accessToken !== "string" && typeof accessToken !== "function") {
      throw new MatterWaveConfigError("accessToken must be a token or a function that returns one");
    }
    this.accessToken = accessToken;
    // A person's token replaces the key outright, so MATTERWAVE_API_KEY is
    // not read beside one.
    this.apiKey = accessToken !== null ? null : (options.apiKey ?? envValue(API_KEY_ENV));
    this.allowBrowser = options.dangerouslyAllowBrowser === true;
    if (this.apiKey !== null && inBrowser() && !this.allowBrowser) {
      throw new MatterWaveConfigError(
        "An API key in a browser is readable by anyone who loads the page. Call the API from a " +
          "server, or pass dangerouslyAllowBrowser: true with a key scoped for this page.",
      );
    }
    this.baseUrl = resolveBaseUrl(options.baseUrl);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    if (this.maxRetries < 0) throw new MatterWaveConfigError("maxRetries must be 0 or more");
    this.maxRetryWaitMs = options.maxRetryWaitMs ?? DEFAULT_MAX_RETRY_WAIT_MS;
    if (!(this.maxRetryWaitMs >= 0)) throw new MatterWaveConfigError("maxRetryWaitMs must be 0 or more");
    this.defaultHeaders = { ...(options.defaultHeaders ?? {}) };
    // Bound at construction: a bare `fetch` reference loses its `this` in
    // some runtimes, and an injected one is whatever the caller gave.
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.onRequest = options.onRequest ?? null;
    this.onResponse = options.onResponse ?? null;
    this.log = new RequestLog(options.logLevel ?? logLevelOf(envValue(LOG_ENV)), options.logger ?? console);
    this.chat = new Chat(this);
    this.models = new Models(this);
    this.embeddings = new Embeddings(this);
    this.conversations = new Conversations(this);
    this.messages = new Messages(this);
    this.instructions = new Instructions(this);
    this.auth = new Auth(this);
    this.keys = new Keys(this);
    this.usage = new UsageClient(this);
    this.audit = new Audit(this);
    this.webhooks = new Webhooks(this);
    this.attachments = new Attachments(this);
    this.library = new LibraryClient(this);
    this.shares = new Shares(this);
    this.budget = new BudgetClient(this);
    this.notifications = new Notifications(this);
    this.announcements = new Announcements(this);
    this.entitlements = new EntitlementsClient(this);
    this.admin = new Admin(this);
    this.mcp = new Mcp(this);
    this.account = new Account(this);
    this.preferences = new PreferencesClient(this);
    this.sessions = new Sessions(this);
    this.exports = new Exports(this);
    this.imports = new Imports(this);
    this.speech = new Speech(this);
    this.billing = new Billing(this);
    this.plans = new Plans(this);
    this.policy = new Policy(this);
    this.org = new OrgClient(this);
    this.members = new Members(this);
    this.invites = new Invites(this);
    this.inviteLinks = new InviteLinks(this);
    this.passkeys = new Passkeys(this);
    this.mfa = new Mfa(this);
    this.accounts = new Accounts(this);
    this.sync = new Sync(this);
    this.presets = new Presets(this);
    this.connections = new Connections(this);
  }

  /** The last HTTP response received, success or refusal; null until something has been sent. */
  get lastResponse(): RawResponse | null {
    return this._lastResponse;
  }

  /** Pi 1.0 (`@earendil-works/pi-coding-agent`) provider, extension and JSON-Lines RPC helpers bound to this client. */
  get pi(): PiNamespace {
    if (this._pi === null) {
      const createRpcClient = (options: Omit<PiRpcClientOptions, "client"> = {}) =>
        new PiRpcClient({
          ...options,
          client: this,
          ...(options.apiKey === undefined && this.apiKey !== null ? { apiKey: this.apiKey } : {}),
          ...(options.baseUrl === undefined ? { baseUrl: this.baseUrl } : {}),
        });

      const streamPrompt = async function* (
        message: string,
        options: Omit<PiRpcClientOptions, "client"> = {},
      ): AsyncGenerator<PiRpcEvent, void, unknown> {
        const rpc = createRpcClient(options);
        try {
          const eventStream = rpc.events({ signal: options.signal });
          const promptPromise = rpc.prompt(message, { timeoutMs: options.timeoutMs });

          // Observe prompt rejection immediately if it fails before or during event iteration
          let promptError: unknown = null;
          let promptCompleted = false;
          let handledDirectly = false;

          void promptPromise.then(
            (res) => {
              promptCompleted = true;
              if (res.disposition === "handled") {
                handledDirectly = true;
              }
            },
            (err) => {
              promptError = err;
            },
          );

          for await (const ev of eventStream) {
            if (promptError !== null) {
              throw promptError;
            }
            if (ev.type === "response" && ev.command === "prompt") {
              if (ev.success === false) {
                throw new Error(ev.error ?? 'Pi RPC command "prompt" failed');
              }
              const data = ev.data as { disposition?: string } | undefined;
              if (data?.disposition === "handled") {
                break;
              }
              continue;
            }
            yield ev;
            if ((ev as { type: string }).type === "error" || ev.type === "agent_end") {
              break;
            }
            if (
              ev.type === "turn_end" &&
              (!Array.isArray(ev.toolResults) || ev.toolResults.length === 0)
            ) {
              break;
            }
          }

          if (!promptCompleted) {
            await promptPromise;
          } else if (promptError !== null) {
            throw promptError;
          }
          if (handledDirectly) {
            return;
          }
        } finally {
          await rpc.close();
        }
      };

      this._pi = {
        buildProviderConfig: (options?: MatterWavePiOptions) => buildPiProviderConfig(this, options),
        createExtension: (options?: MatterWavePiOptions) => createMatterWavePiExtension(this, options),
        createRpcClient,
        streamPrompt,
      };
    }
    return this._pi;
  }

  /**
   * This client with some settings replaced, for the calls made through it:
   * `client.withOptions({ timeoutMs: 600_000 }).keys.create(...)`. Every
   * method also takes the same per call in its `RequestOptions`; this is for
   * handing a differently-bounded client to code that makes several calls.
   * The view shares the client's `fetch` and hooks.
   */
  withOptions(overrides: ClientOverrides): MatterWave {
    if (overrides.idempotencyKey !== undefined && overrides.idempotencyKey.trim() === "") {
      throw new MatterWaveConfigError("idempotencyKey must be non-empty");
    }
    const view = new MatterWave({
      apiKey: this.apiKey,
      accessToken: this.accessToken,
      baseUrl: this.baseUrl,
      timeoutMs: overrides.timeoutMs ?? this.timeoutMs,
      maxRetries: overrides.maxRetries ?? this.maxRetries,
      maxRetryWaitMs: overrides.maxRetryWaitMs ?? this.maxRetryWaitMs,
      defaultHeaders: { ...this.defaultHeaders, ...(overrides.defaultHeaders ?? {}) },
      fetch: this.fetchImpl,
      dangerouslyAllowBrowser: this.allowBrowser,
      logLevel: this.log.level,
      logger: this.log.logger,
      onRequest: this.onRequest ?? undefined,
      onResponse: this.onResponse ?? undefined,
    });
    view.idempotencyKey = overrides.idempotencyKey ?? this.idempotencyKey;
    return view;
  }

  /** `GET /v1`: the version, the endpoints and the stability promise. No key needed. */
  index(options: RequestOptions = {}): Promise<WithRequestId<ApiIndex>> {
    return this.json<ApiIndex>(
      { method: "GET", path: "/v1", body: undefined, keyed: false, stream: false },
      options,
    );
  }

  /** `GET /api/me`: who the key or the person's token acts as. */
  me(options: RequestOptions = {}): Promise<WithRequestId<Me>> {
    return this.json<Me>(
      { method: "GET", path: "/api/me", body: undefined, keyed: true, stream: false },
      options,
    );
  }

  /**
   * `GET /api/models`: the model picker's rows -- each model priced, with
   * `included` saying whether the caller's plan covers it and `upgrade_to`
   * the plan that does, so a client can show the upgrade path instead of
   * hiding the model. `models.list()` is `/v1/models`, which carries none
   * of that.
   */
  appModels(options: RequestOptions = {}): Promise<WithRequestId<AppModelList>> {
    return this.json<AppModelList>(
      { method: "GET", path: "/api/models", body: undefined, keyed: true, stream: false },
      options,
    );
  }

  /** `GET /api/v1/oidc/config`: the deployment's OIDC identity provider configuration. */
  getOidcConfig(options: RequestOptions = {}): Promise<WithRequestId<OidcConfig>> {
    return this.json<OidcConfig>(
      { method: "GET", path: "/api/v1/oidc/config", body: undefined, keyed: true, stream: false },
      options,
    );
  }

  /** `POST /api/v1/agent-keys/{key_id}/oidc-sync`: synchronize OIDC client credentials and A2A claims for `keyId`. */
  syncAgentKeyOidc(keyId: string, options: RequestOptions = {}): Promise<WithRequestId<OidcSyncResult>> {
    const seg = pathSegment("keyId", keyId);
    return this.json<OidcSyncResult>(
      { method: "POST", path: `/api/v1/agent-keys/${seg}/oidc-sync`, body: undefined, keyed: true, stream: false },
      options,
    );
  }

  /** `POST /api/v1/oidc/enforce-claims`: evaluate an agent key's A2A permission envelope against a run request. */
  enforceOidcClaims(
    payload: EnforceOidcClaimsParams,
    options: RequestOptions = {},
  ): Promise<WithRequestId<EnforceClaimsResult>> {
    if (!payload || typeof payload !== "object" || Object.keys(payload).length === 0) {
      throw new MatterWaveConfigError("payload must not be empty");
    }
    return this.json<EnforceClaimsResult>(
      { method: "POST", path: "/api/v1/oidc/enforce-claims", body: payload, keyed: true, stream: false },
      options,
    );
  }

  /** `GET /api/v1/connectors/catalog`: list providers in the universal connector catalog. */
  listConnectorCatalog(
    paramsOrCategory?: ListConnectorCatalogParams | string | null,
    q?: string | null,
    options: RequestOptions = {},
  ): Promise<WithRequestId<ConnectorCatalogList>> {
    let category: string | undefined;
    let searchQ: string | undefined;
    let reqOptions: RequestOptions = options;
    if (typeof paramsOrCategory === "string") {
      category = paramsOrCategory;
      searchQ = q ?? undefined;
    } else if (paramsOrCategory && typeof paramsOrCategory === "object") {
      const { category: cat, q: queryStr, ...rest } = paramsOrCategory;
      category = cat;
      searchQ = queryStr ?? (q ?? undefined);
      reqOptions = { ...rest, ...options };
    } else if (q != null) {
      searchQ = q;
    }
    const qs = buildQuery({ category, q: searchQ });
    return this.json<ConnectorCatalogList>(
      { method: "GET", path: `/api/v1/connectors/catalog${qs}`, body: undefined, keyed: true, stream: false },
      reqOptions,
    );
  }

  /** `POST /api/v1/oauth/register`: register an OAuth authenticator for a connector catalog provider. */
  registerOAuthAuthenticator(
    payload: RegisterOAuthAuthenticatorParams,
    options: RequestOptions = {},
  ): Promise<WithRequestId<OAuthAuthenticator>> {
    if (!payload || typeof payload !== "object" || Object.keys(payload).length === 0) {
      throw new MatterWaveConfigError("payload must not be empty");
    }
    return this.json<OAuthAuthenticator>(
      { method: "POST", path: "/api/v1/oauth/register", body: payload, keyed: true, stream: false },
      options,
    );
  }

  /** `POST /api/v1/oauth/proxy/{credential_id}`: proxy an outbound API request through the credential broker. */
  proxyOAuthRequest(
    credentialId: string,
    endpoint: string,
    methodOrOptions: string | ProxyOAuthRequestOptions = "GET",
    options: ProxyOAuthRequestOptions = {},
  ): Promise<WithRequestId<CredentialProxyResponse>> {
    const seg = pathSegment("credentialId", credentialId);
    const cleanedEndpoint = requireNonBlank("endpoint", endpoint);
    const merged: ProxyOAuthRequestOptions =
      typeof methodOrOptions === "string" ? { ...options, method: methodOrOptions } : { ...methodOrOptions, ...options };
    const { method = "GET", params, headers, body, dryRun, dry_run, ...reqOptions } = merged;
    const payload: Record<string, unknown> = {
      endpoint: cleanedEndpoint,
      method: requireNonBlank("method", method).toUpperCase(),
    };
    if (params !== undefined) payload.params = params;
    if (headers !== undefined) payload.headers = headers;
    if (body !== undefined) payload.body = body;
    const resolvedDryRun = dryRun ?? dry_run;
    if (resolvedDryRun !== undefined) payload.dry_run = resolvedDryRun;
    return this.json<CredentialProxyResponse>(
      { method: "POST", path: `/api/v1/oauth/proxy/${seg}`, body: payload, keyed: true, stream: false },
      reqOptions,
    );
  }

  /** `GET /api/v1/runs/{run_id}/decision-trail`: retrieve the execution decision graph and statistics for `runId`. */
  getRunDecisionTrail(runId: string, options: RequestOptions = {}): Promise<WithRequestId<DecisionTrail>> {
    const seg = pathSegment("runId", runId);
    return this.json<DecisionTrail>(
      { method: "GET", path: `/api/v1/runs/${seg}/decision-trail`, body: undefined, keyed: true, stream: false },
      options,
    );
  }

  /** `POST /api/v1/runs/{run_id}/replay`: replay a run in `simulated`, `strict`, or `counterfactual` mode. */
  replayRun(
    runId: string,
    modeOrOptions: ReplayMode | ReplayRunOptions = "simulated",
    overrides?: Record<string, unknown> | null,
    options: ReplayRunOptions = {},
  ): Promise<WithRequestId<ReplayRunResult>> {
    const seg = pathSegment("runId", runId);
    const merged: ReplayRunOptions =
      typeof modeOrOptions === "string"
        ? { ...options, mode: modeOrOptions, ...(overrides != null ? { overrides } : {}) }
        : { ...modeOrOptions, ...options };
    const { mode = "simulated", overrides: ov, fromStepId, from_step_id, ...reqOptions } = merged;
    const payload: Record<string, unknown> = {
      mode: requireNonBlank("mode", mode),
      overrides: ov ?? {},
    };
    const resolvedFromStep = fromStepId ?? from_step_id;
    if (resolvedFromStep !== undefined) payload.from_step_id = resolvedFromStep;
    return this.json<ReplayRunResult>(
      { method: "POST", path: `/api/v1/runs/${seg}/replay`, body: payload, keyed: true, stream: false },
      reqOptions,
    );
  }

  /** `GET /api/v1/runs/{run_id}/checkpoints`: list persisted checkpoints for `runId`. */
  listRunCheckpoints(runId: string, options: RequestOptions = {}): Promise<WithRequestId<CheckpointList>> {
    const seg = pathSegment("runId", runId);
    return this.json<CheckpointList>(
      { method: "GET", path: `/api/v1/runs/${seg}/checkpoints`, body: undefined, keyed: true, stream: false },
      options,
    );
  }

  /** `POST /api/v1/runs/{run_id}/resume`: resume a run from `checkpointId`. */
  resumeRun(
    runId: string,
    checkpointId?: string | null,
    options: ResumeRunOptions = {},
  ): Promise<WithRequestId<ResumeRunResult>> {
    const seg = pathSegment("runId", runId);
    const { stateOverrides, state_overrides, ...reqOptions } = options;
    const payload: Record<string, unknown> = {};
    if (checkpointId !== undefined && checkpointId !== null) {
      payload.checkpoint_id = requireNonBlank("checkpointId", checkpointId);
    }
    const resolvedOverrides = stateOverrides ?? state_overrides;
    if (resolvedOverrides !== undefined) payload.state_overrides = resolvedOverrides;
    return this.json<ResumeRunResult>(
      { method: "POST", path: `/api/v1/runs/${seg}/resume`, body: payload, keyed: true, stream: false },
      reqOptions,
    );
  }

  /** `GET /api/v1/reliability/metrics`: retrieve aggregate reliability metrics. */
  getReliabilityMetrics(
    agentIdOrOptions?: string | GetReliabilityMetricsOptions | null,
    options: RequestOptions = {},
  ): Promise<WithRequestId<ReliabilityMetrics>> {
    let agentId: string | undefined;
    let reqOptions: RequestOptions = options;
    if (typeof agentIdOrOptions === "string") {
      agentId = agentIdOrOptions;
    } else if (agentIdOrOptions && typeof agentIdOrOptions === "object") {
      const { agentId: a1, agent_id: a2, ...rest } = agentIdOrOptions;
      agentId = a1 ?? a2;
      reqOptions = { ...rest, ...options };
    }
    const qs = buildQuery({ agent_id: agentId });
    return this.json<ReliabilityMetrics>(
      { method: "GET", path: `/api/v1/reliability/metrics${qs}`, body: undefined, keyed: true, stream: false },
      reqOptions,
    );
  }

  /** `GET /api/v1/reliability/slo`: retrieve the service-level objective compliance report. */
  getReliabilitySlo(options: RequestOptions = {}): Promise<WithRequestId<ReliabilitySloReport>> {
    return this.json<ReliabilitySloReport>(
      { method: "GET", path: "/api/v1/reliability/slo", body: undefined, keyed: true, stream: false },
      options,
    );
  }

  /** `GET /api/v1/reliability/trends`: retrieve historical reliability trend buckets and anomalies. */
  getReliabilityTrends(options: RequestOptions = {}): Promise<WithRequestId<ReliabilityTrends>> {
    return this.json<ReliabilityTrends>(
      { method: "GET", path: "/api/v1/reliability/trends", body: undefined, keyed: true, stream: false },
      options,
    );
  }

  /** `GET /api/v1/telemetry/status`: retrieve the status of the platform telemetry stack. */
  getTelemetryStatus(options: RequestOptions = {}): Promise<WithRequestId<TelemetryStackStatus>> {
    return this.json<TelemetryStackStatus>(
      { method: "GET", path: "/api/v1/telemetry/status", body: undefined, keyed: true, stream: false },
      options,
    );
  }

  /** `GET /api/v1/telemetry/executions/{execution_id}/metrics`: retrieve per-step telemetry metrics for `executionId`. */
  getExecutionTelemetry(
    executionId: string,
    options: RequestOptions = {},
  ): Promise<WithRequestId<TelemetryExecutionMetrics>> {
    const seg = pathSegment("executionId", executionId);
    return this.json<TelemetryExecutionMetrics>(
      { method: "GET", path: `/api/v1/telemetry/executions/${seg}/metrics`, body: undefined, keyed: true, stream: false },
      options,
    );
  }

  /** `GET /api/v1/hitl/interactions`: list human-in-the-loop interaction requests. */
  listHitlInteractions(options: ListHitlInteractionsOptions = {}): Promise<WithRequestId<HitlInteractionList>> {
    const { status, ...reqOptions } = options;
    const qs = buildQuery({ status });
    return this.json<HitlInteractionList>(
      { method: "GET", path: `/api/v1/hitl/interactions${qs}`, body: undefined, keyed: true, stream: false },
      reqOptions,
    );
  }

  /** `POST /api/v1/hitl/interactions/{interaction_id}/respond`: submit a decision for a HITL interaction. */
  respondHitlInteraction(
    interactionId: string,
    decision: string,
    options: RespondHitlInteractionOptions = {},
  ): Promise<WithRequestId<HitlInteraction>> {
    const seg = pathSegment("interactionId", interactionId);
    const { responseData, response_data, respondedBy, responded_by, ...reqOptions } = options;
    const payload: Record<string, unknown> = {
      decision: requireNonBlank("decision", decision),
    };
    const resolvedData = responseData ?? response_data;
    if (resolvedData !== undefined) payload.response_data = resolvedData;
    const resolvedBy = respondedBy ?? responded_by;
    if (resolvedBy !== undefined) payload.responded_by = resolvedBy;
    return this.json<HitlInteraction>(
      { method: "POST", path: `/api/v1/hitl/interactions/${seg}/respond`, body: payload, keyed: true, stream: false },
      reqOptions,
    );
  }

  /** `POST /api/v1/guardrails/evaluate`: evaluate content or tool calls against guardrails. */
  evaluateGuardrails(
    railType: GuardrailType,
    content: string,
    options: EvaluateGuardrailsOptions = {},
  ): Promise<WithRequestId<GuardrailEvaluation>> {
    const { toolName, tool_name, toolArgs, tool_args, policies, ...reqOptions } = options;
    const payload: Record<string, unknown> = {
      rail_type: requireNonBlank("railType", railType),
      content,
    };
    const resolvedToolName = toolName ?? tool_name;
    if (resolvedToolName !== undefined) payload.tool_name = resolvedToolName;
    const resolvedToolArgs = toolArgs ?? tool_args;
    if (resolvedToolArgs !== undefined) payload.tool_args = resolvedToolArgs;
    if (policies !== undefined) payload.policies = policies;
    return this.json<GuardrailEvaluation>(
      { method: "POST", path: "/api/v1/guardrails/evaluate", body: payload, keyed: true, stream: false },
      reqOptions,
    );
  }

  /** `POST /api/v1/tools/plan`: generate a dependency-ordered tool execution plan for `goal`. */
  planTools(
    goal: string,
    availableTools?: string[] | null,
    options: PlanToolsOptions = {},
  ): Promise<WithRequestId<ToolPlan>> {
    const cleanedGoal = requireNonBlank("goal", goal);
    const { constraints, ...reqOptions } = options;
    const payload: Record<string, unknown> = {
      task: cleanedGoal,
      goal: cleanedGoal,
    };
    if (availableTools !== undefined && availableTools !== null) {
      payload.available_tools = availableTools;
    }
    if (constraints !== undefined) payload.constraints = constraints;
    return this.json<ToolPlan>(
      { method: "POST", path: "/api/v1/tools/plan", body: payload, keyed: true, stream: false },
      reqOptions,
    );
  }

  /** `POST /v1/rerank`: score and order candidate `documents` against `query` using `MatterWaveAI/grt-30m-reranker`. */
  rerank(
    query: string,
    documents: string[],
    options: RerankOptions = {},
  ): Promise<WithRequestId<RerankResponse>> {
    const cleanedQuery = requireNonBlank("query", query);
    if (!Array.isArray(documents) || documents.length === 0) {
      throw new MatterWaveConfigError("documents must be a non-empty array");
    }
    const {
      model = "MatterWaveAI/grt-30m-reranker",
      topN,
      top_n,
      returnDocuments,
      return_documents,
      ...reqOptions
    } = options;
    const cleanedModel = requireNonBlank("model", model);
    const resolvedTopN = topN ?? top_n;
    const resolvedReturnDocs = returnDocuments ?? return_documents ?? true;
    const payload: Record<string, unknown> = {
      model: cleanedModel,
      query: cleanedQuery,
      documents,
      return_documents: resolvedReturnDocs,
    };
    if (resolvedTopN !== undefined) payload.top_n = resolvedTopN;
    return this.json<RerankResponse>(
      { method: "POST", path: "/v1/rerank", body: payload, keyed: true, stream: false },
      reqOptions,
    );
  }

  /** `POST /v1/audio/speech`: synthesize speech audio from `input` text using `MatterWaveAI/grt-30m-tts`. */
  synthesizeSpeech(
    input: string,
    options: SynthesizeSpeechOptions = {},
  ): Promise<WithRequestId<SpeechSynthesisResponse>> {
    const cleanedInput = requireNonBlank("input", input);
    const {
      model = "MatterWaveAI/grt-30m-tts",
      voice = "aurora",
      responseFormat,
      response_format,
      speed = 1.0,
      ...reqOptions
    } = options;
    const cleanedModel = requireNonBlank("model", model);
    const cleanedVoice = requireNonBlank("voice", voice);
    const cleanedFormat = requireNonBlank("responseFormat", responseFormat ?? response_format ?? "json");
    const payload: Record<string, unknown> = {
      model: cleanedModel,
      input: cleanedInput,
      voice: cleanedVoice,
      response_format: cleanedFormat,
      speed,
    };
    return this.json<SpeechSynthesisResponse>(
      { method: "POST", path: "/v1/audio/speech", body: payload, keyed: true, stream: false },
      reqOptions,
    );
  }

  /** `GET /api/v1/models/grt-suite`: retrieve the 9-model `MatterWaveAI/grt-30m*` HuggingFace suite manifest. */
  getGrtSuite(options: RequestOptions = {}): Promise<WithRequestId<GrtSuiteManifest>> {
    return this.json<GrtSuiteManifest>(
      { method: "GET", path: "/api/v1/models/grt-suite", body: undefined, keyed: true, stream: false },
      options,
    );
  }

  /** @internal */
  async json<T extends object>(prepared: Prepared, options: RequestOptions): Promise<WithRequestId<T>> {
    const { response } = await this.send(prepared, options);
    const requestId = response.headers.get(REQUEST_ID_HEADER);
    const raw = await response.text();
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new APIError("The API answered with a body that is not JSON.", {
        status: response.status,
        requestId,
        body: raw,
      });
    }
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      throw new APIError("The API answered with JSON that is not an object.", {
        status: response.status,
        requestId,
        body: payload,
      });
    }
    return withRequestId(payload as T, requestId);
  }

  /** @internal A route that answers 204, or a body the caller has no use for. */
  async empty(prepared: Prepared, options: RequestOptions): Promise<void> {
    const { response } = await this.send(prepared, options);
    await response.arrayBuffer();
  }

  /** @internal A body that is text, not JSON: the usage CSV. */
  async text(prepared: Prepared, options: RequestOptions): Promise<string> {
    const { response } = await this.send(prepared, options);
    return response.text();
  }

  /** @internal A body that is a file's bytes. */
  async bytes(prepared: Prepared, options: RequestOptions): Promise<ArrayBuffer> {
    const { response } = await this.send(prepared, options);
    return response.arrayBuffer();
  }

  /**
   * One operation, with the retry loop. A streamed response is handed back
   * unread with the controller that can cut it; a buffered one's body is
   * read here so the retry decision and the error can see it.
   * @internal
   */
  async send(
    prepared: Prepared,
    options: RequestOptions,
  ): Promise<{ response: Response; controller: AbortController }> {
    // One key per call, made before the first attempt so every retry
    // presents the same one.
    const idempotencyKey = READ_METHODS.has(prepared.method)
      ? null
      : (options.idempotencyKey ?? this.idempotencyKey ?? newIdempotencyKey());
    // The call's extra fields join the body before anything reads it, so the
    // content type follows the body that is actually sent.
    const sending: Prepared = { ...prepared, body: withExtraBody(prepared, options.extraBody) };
    // A token function is asked once per call, and only for a keyed route;
    // a static credential adds no await, so the request still leaves in the
    // same tick it was made in.
    const provided =
      prepared.keyed && typeof this.accessToken === "function" ? await this.providedToken(this.accessToken) : null;
    const headers = this.headersFor(sending, { ...options.headers, ...options.extraHeaders }, idempotencyKey, provided);
    const url = withQuery(this.baseUrl + prepared.path, options.extraQuery);
    // The call's own bounds win, then the operation's (an MCP tool that
    // runs a whole model turn), then the client's defaults.
    const maxRetries = options.maxRetries ?? this.maxRetries;
    const maxRetryWaitMs = options.maxRetryWaitMs ?? this.maxRetryWaitMs;
    const timeoutMs = options.timeoutMs ?? prepared.timeoutMs ?? this.timeoutMs;
    const explicitIdempotencyKey =
      !READ_METHODS.has(prepared.method) &&
      (options.idempotencyKey !== undefined ||
        this.idempotencyKey !== null ||
        Object.keys({
          ...this.defaultHeaders,
          ...(prepared.headers ?? {}),
          ...(options.headers ?? {}),
          ...(options.extraHeaders ?? {}),
        }).some((name) => name.toLowerCase() === IDEMPOTENCY_HEADER.toLowerCase()));
    const repeatable = safeToRepeat(prepared) || explicitIdempotencyKey;
    // A FormData goes as it is, so fetch writes the multipart boundary; it
    // can be sent again on a retry, unlike a stream.
    const body =
      sending.body === undefined ? undefined : isForm(sending.body) ? sending.body : JSON.stringify(sending.body);
    for (let attempt = 0; ; attempt += 1) {
      if (this.onRequest) this.onRequest({ method: prepared.method, path: prepared.path });
      const controller = new AbortController();
      const stop = linkSignals(controller, options.signal, timeoutMs);
      this.log.attempt(prepared.method, prepared.path, attempt);
      const since = this.log.started();
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: prepared.method,
          headers,
          body,
          signal: controller.signal,
        });
      } catch (cause) {
        stop.clear();
        this.log.failure(prepared.method, prepared.path, cause, since);
        if (options.signal?.aborted) throw cause;
        // Our own timeout fired after the request may have gone out, so only
        // a refused connection proves a write never arrived.
        const again = repeatable || (!stop.timedOut && neverSent(cause));
        if (attempt >= maxRetries || !again) {
          throw stop.timedOut
            ? new APITimeoutError(`${prepared.method} ${prepared.path} timed out.`, { cause })
            : new APIConnectionError(
                `${prepared.method} ${prepared.path} could not reach the API: ${describe(cause)}`,
                { cause },
              );
        }
        const wait = backoffMs(attempt, null);
        this.log.retry(prepared.method, prepared.path, wait, attempt);
        await pause(wait, options.signal);
        continue;
      }
      this.log.response(prepared.method, prepared.path, response, since);
      this.log.deprecated(prepared.method, prepared.path, response.headers);
      if (response.ok) {
        // The timeout covers the connection phase only: a streamed body
        // outlives this call, and a long answer must not be cut by it.
        stop.clear();
        this._lastResponse = new RawResponse(response);
        if (this.onResponse) this.onResponse(this._lastResponse);
        return { response, controller };
      }
      const raw = await response.text();
      stop.clear();
      this._lastResponse = new RawResponse(response);
      if (this.onResponse) this.onResponse(this._lastResponse);
      const delay = backoffMs(attempt, retryAfterSeconds(response));
      if (attempt < maxRetries && delay <= maxRetryWaitMs && shouldRetry(response, raw, repeatable)) {
        this.log.retry(prepared.method, prepared.path, delay, attempt);
        await pause(delay, options.signal);
        continue;
      }
      throw errorFromResponse(response, raw);
    }
  }

  /**
   * A request to another origin -- the identity provider's endpoints --
   * through the client's `fetch`, with the client's timeout and none of
   * the API's headers or credential.
   * @internal
   */
  async fetchExternal(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const stop = linkSignals(controller, undefined, this.timeoutMs);
    try {
      return await this.fetchImpl(url, {
        ...init,
        headers: { "User-Agent": USER_AGENT, ...(init.headers as Record<string, string>) },
        signal: controller.signal,
      });
    } catch (cause) {
      throw stop.timedOut
        ? new APITimeoutError(`${init.method ?? "GET"} ${url} timed out.`, { cause })
        : new APIConnectionError(`${init.method ?? "GET"} ${url} could not be reached: ${describe(cause)}`, { cause });
    } finally {
      stop.clear();
    }
  }

  /** A token function's answer, refused unless it is a token. */
  private async providedToken(provider: AccessTokenProvider): Promise<string> {
    const token = await provider();
    if (typeof token !== "string" || token === "") {
      throw new MatterWaveConfigError("accessToken's function must return the token, a non-empty string");
    }
    return token;
  }

  /**
   * Least specific first: the client's own `Accept` and `User-Agent`, then
   * `defaultHeaders`, which may replace them (a client built on this one
   * names itself), then what the operation needs (`Last-Event-ID` on a
   * resume) and the call's own, then a write's idempotency key, then the
   * bearer: the key, the person's token, or `provided`, a token function's
   * answer for this call.
   */
  private headersFor(
    prepared: Prepared,
    extra: Record<string, string> | undefined,
    idempotencyKey: string | null,
    provided: string | null,
  ): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: prepared.stream ? "text/event-stream" : "application/json",
      "User-Agent": USER_AGENT,
      ...this.defaultHeaders,
      ...(prepared.headers ?? {}),
      ...(extra ?? {}),
    };
    // A key the caller set by hand, under any spelling, is theirs to keep.
    const named = Object.keys(headers).some((name) => name.toLowerCase() === IDEMPOTENCY_HEADER.toLowerCase());
    if (idempotencyKey !== null && !named) headers[IDEMPOTENCY_HEADER] = idempotencyKey;
    if (prepared.body !== undefined && !isForm(prepared.body)) headers["Content-Type"] = "application/json";
    if (prepared.keyed) {
      const bearer = provided ?? (typeof this.accessToken === "string" ? this.accessToken : this.apiKey);
      if (bearer === null) {
        throw new MissingAPIKeyError(
          `${prepared.method} ${prepared.path} needs a credential: pass apiKey (or set ${API_KEY_ENV}), or a person's accessToken.`,
        );
      }
      headers.Authorization = `Bearer ${bearer}`;
    }
    return headers;
  }
}

export { MatterWave as MatterWaveClient };

function pathSegment(name: string, value: string): string {
  if (!value || value.includes("/") || value === "." || value === "..") {
    throw new MatterWaveConfigError(`${name} must be a non-empty id without '/', got ${value}`);
  }
  return encodeURIComponent(value);
}

function requireNonBlank(name: string, value: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new MatterWaveConfigError(`${name} must not be blank`);
  }
  return value;
}

function buildQuery(params: Record<string, string | undefined>): string {
  const pairs = Object.entries(params).filter((p): p is [string, string] => p[1] !== undefined);
  return pairs.length === 0 ? "" : `?${new URLSearchParams(pairs).toString()}`;
}

/** The URL with the call's extra query parameters added after any it already has. */
function withQuery(url: string, query: Record<string, string> | undefined): string {
  if (!query || Object.keys(query).length === 0) return url;
  return `${url}${url.includes("?") ? "&" : "?"}${new URLSearchParams(query).toString()}`;
}

/** The body with the call's extra fields merged over it; a GET or an upload refuses them. */
function withExtraBody(prepared: Prepared, extra: Record<string, unknown> | undefined): unknown {
  if (!extra || Object.keys(extra).length === 0) return prepared.body;
  if (prepared.method === "GET") {
    throw new MatterWaveConfigError(`${prepared.method} ${prepared.path} has no body to add extraBody to.`);
  }
  if (isForm(prepared.body)) {
    throw new MatterWaveConfigError(`${prepared.method} ${prepared.path} is an upload; extraBody cannot join its form.`);
  }
  return { ...((prepared.body as Record<string, unknown> | undefined) ?? {}), ...extra };
}

function isForm(body: unknown): body is FormData {
  return typeof FormData !== "undefined" && body instanceof FormData;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("This operation was aborted", "AbortError");
}

let sleeper: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/**
 * @internal Wait the way the retry loop waits, so tests that replace it see
 * every pause. The caller's `signal` ends the wait at once, with the
 * signal's reason, whatever sleeper is installed.
 */
export async function pause(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return sleeper(ms);
  if (signal.aborted) throw abortReason(signal);
  let onAbort = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([sleeper(ms, signal), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Replace how the retry loop waits. Tests use it to measure the delays the
 * client asked for instead of waiting through them; it returns the previous
 * sleeper so they can put it back.
 */
export function setSleep(fn: Sleep): Sleep {
  const previous = sleeper;
  sleeper = fn;
  return previous;
}

/**
 * One controller for the fetch, aborted by the caller's signal or by the
 * timeout, whichever first. `timedOut` says which, so a timeout is reported
 * as one rather than as a generic connection failure.
 */
function linkSignals(
  controller: AbortController,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): { clear: () => void; timedOut: boolean } {
  const state = { timedOut: false, clear: () => {} };
  const timer = setTimeout(() => {
    state.timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  state.clear = () => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  };
  return state;
}
