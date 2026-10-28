/**
 * The client. `fetch`-based, so it runs in Node 18+ and in browsers alike;
 * nothing here imports a Node module.
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
 * A 429 (the per-key window) and any 5xx are retried `maxRetries` times
 * with backoff, honouring `Retry-After` when the server sends it; a 429
 * whose code is `insufficient_quota` is not, because waiting does not
 * refill a budget. Every error carries the `X-Request-Id` the server
 * stamped on the refusal.
 */

import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  MatterWaveError,
  MissingAPIKeyError,
  errorClassFor,
} from "./errors.js";
import type { RateLimit } from "./errors.js";
import { Auth, Conversations, Instructions, Messages } from "./conversations.js";
import { Mcp } from "./mcp.js";
import { Attachments, BudgetClient, Keys, LibraryClient, Shares, UsageClient, Webhooks } from "./native.js";
import { sseDataFrames } from "./sse.js";
import type {
  ApiIndex,
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

export const VERSION = "0.2.1";
export const API_KEY_ENV = "MATTERWAVE_API_KEY";
export const BASE_URL_ENV = "MATTERWAVE_BASE_URL";
const API_PREFIX = "/v1";
const REQUEST_ID_HEADER = "x-request-id";
const SSE_DONE = "[DONE]";
const USER_AGENT = `matterwave-typescript/${VERSION}`;

export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_RETRIES = 2;
// Backoff for a retry the server gave no `Retry-After` for: 0.5s, 1s, 2s ...
// capped, with jitter so a fleet of clients does not retry in lockstep.
export const BACKOFF_BASE_MS = 500;
export const BACKOFF_CAP_MS = 8_000;
// A 429 the server says is the organisation's budget, not the window.
const NON_RETRYABLE_429_CODES = new Set(["insufficient_quota"]);

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export interface ClientOptions {
  /** Defaults to `MATTERWAVE_API_KEY`. Only `index()` works without one. */
  apiKey?: string | null;
  /** The origin the API is served from; defaults to `MATTERWAVE_BASE_URL`. The OpenAI-style form ending in `/v1` is accepted too. */
  baseUrl?: string | null;
  /** Per attempt. The default is 60 seconds. */
  timeoutMs?: number;
  /** Retries after the first attempt, for 429 and 5xx. The default is 2. */
  maxRetries?: number;
  /** Sent on every request, under the ones the client sets. */
  defaultHeaders?: Record<string, string>;
  /** A replacement `fetch`: a mock in tests, a wrapped one in an app. */
  fetch?: Fetch;
}

export interface RequestOptions {
  /** Aborts the request, and a stream being read. */
  signal?: AbortSignal;
  /** Headers for this one call. */
  headers?: Record<string, string>;
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
}

function envValue(name: string): string | null {
  // `process` exists in Node and in bundlers that polyfill it; in a browser
  // without either there is no environment to read, and that is fine.
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  const value = env?.[name]?.trim();
  return value ? value : null;
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

/** A client option that cannot be used: no origin, a bad origin, a negative retry count. */
export class MatterWaveConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MatterWaveConfigError";
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
    // FastAPI's shape with the ids beside it, rather than OpenAI's.
    return new Cls(detail, { status: response.status, requestId, retryAfter, rateLimit, body: payload });
  }
  const text = raw.trim();
  const message = text ? `HTTP ${response.status}: ${text.slice(0, 200)}` : `HTTP ${response.status}`;
  return new Cls(message, { status: response.status, requestId, retryAfter, rateLimit, body: payload });
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

/** 429 and 5xx, except the 429 that means the budget is spent. */
export function shouldRetry(response: Response, raw: string): boolean {
  if (response.status >= 500) return true;
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
  /** The `/mcp` JSON-RPC endpoint: list tools, call one, send a message. */
  readonly mcp: Mcp;
  private readonly apiKey: string | null;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly defaultHeaders: Record<string, string>;
  private readonly fetchImpl: Fetch;

  constructor(options: ClientOptions = {}) {
    this.apiKey = options.apiKey ?? envValue(API_KEY_ENV);
    this.baseUrl = resolveBaseUrl(options.baseUrl);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    if (this.maxRetries < 0) throw new MatterWaveConfigError("maxRetries must be 0 or more");
    this.defaultHeaders = { ...(options.defaultHeaders ?? {}) };
    // Bound at construction: a bare `fetch` reference loses its `this` in
    // some runtimes, and an injected one is whatever the caller gave.
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.chat = new Chat(this);
    this.models = new Models(this);
    this.embeddings = new Embeddings(this);
    this.conversations = new Conversations(this);
    this.messages = new Messages(this);
    this.instructions = new Instructions(this);
    this.auth = new Auth(this);
    this.keys = new Keys(this);
    this.usage = new UsageClient(this);
    this.webhooks = new Webhooks(this);
    this.attachments = new Attachments(this);
    this.library = new LibraryClient(this);
    this.shares = new Shares(this);
    this.budget = new BudgetClient(this);
    this.mcp = new Mcp(this);
  }

  /** `GET /v1`: the version, the endpoints and the stability promise. No key needed. */
  index(options: RequestOptions = {}): Promise<WithRequestId<ApiIndex>> {
    return this.json<ApiIndex>(
      { method: "GET", path: "/v1", body: undefined, keyed: false, stream: false },
      options,
    );
  }

  /** `GET /api/me`: who the key (or device-login token) acts as. */
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
    const headers = this.headersFor(prepared, options.headers);
    const url = this.baseUrl + prepared.path;
    // A FormData goes as it is, so fetch writes the multipart boundary; it
    // can be sent again on a retry, unlike a stream.
    const body =
      prepared.body === undefined
        ? undefined
        : isForm(prepared.body)
          ? prepared.body
          : JSON.stringify(prepared.body);
    for (let attempt = 0; ; attempt += 1) {
      const controller = new AbortController();
      const stop = linkSignals(controller, options.signal, prepared.timeoutMs ?? this.timeoutMs);
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
        if (options.signal?.aborted) throw cause;
        if (attempt >= this.maxRetries) {
          throw stop.timedOut
            ? new APITimeoutError(`${prepared.method} ${prepared.path} timed out.`, { cause })
            : new APIConnectionError(
                `${prepared.method} ${prepared.path} could not reach the API: ${describe(cause)}`,
                { cause },
              );
        }
        await sleeper(backoffMs(attempt, null));
        continue;
      }
      if (response.ok) {
        // The timeout covers the connection phase only: a streamed body
        // outlives this call, and a long answer must not be cut by it.
        stop.clear();
        return { response, controller };
      }
      const raw = await response.text();
      stop.clear();
      if (attempt < this.maxRetries && shouldRetry(response, raw)) {
        await sleeper(backoffMs(attempt, retryAfterSeconds(response)));
        continue;
      }
      throw errorFromResponse(response, raw);
    }
  }

  /**
   * Least specific first: the client's own `Accept` and `User-Agent`, then
   * `defaultHeaders`, which may replace them (a client built on this one
   * names itself), then what the operation needs (`Last-Event-ID` on a
   * resume) and the call's own, then the bearer.
   */
  private headersFor(prepared: Prepared, extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: prepared.stream ? "text/event-stream" : "application/json",
      "User-Agent": USER_AGENT,
      ...this.defaultHeaders,
      ...(prepared.headers ?? {}),
      ...(extra ?? {}),
    };
    if (prepared.body !== undefined && !isForm(prepared.body)) headers["Content-Type"] = "application/json";
    if (prepared.keyed) {
      if (this.apiKey === null) {
        throw new MissingAPIKeyError(
          `${prepared.method} ${prepared.path} needs an API key: pass apiKey or set ${API_KEY_ENV}.`,
        );
      }
      headers.Authorization = `Bearer ${this.apiKey}`;
    }
    return headers;
  }
}

function isForm(body: unknown): body is FormData {
  return typeof FormData !== "undefined" && body instanceof FormData;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

let sleeper: (ms: number) => Promise<void> = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Replace how the retry loop waits. Tests use it to measure the delays the
 * client asked for instead of waiting through them; it returns the previous
 * sleeper so they can put it back.
 */
/** @internal Wait the way the retry loop waits, so tests that replace it see every pause. */
export function pause(ms: number): Promise<void> {
  return sleeper(ms);
}

export function setSleep(fn: (ms: number) => Promise<void>): (ms: number) => Promise<void> {
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
