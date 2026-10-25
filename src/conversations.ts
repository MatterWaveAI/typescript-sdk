/**
 * The app's conversation API and device login, on top of the client's
 * request and retry loop.
 *
 *     const stream = await client.conversations.send(id, { content: "Hi" });
 *     for await (const frame of stream) {
 *       if (frame.event === "delta" && frame.content) process.stdout.write(frame.content);
 *     }
 *
 * A conversation is a tree: `get` returns the active path, `tree` every
 * branch, and `setActiveLeaf` moves between them.
 */

import { MatterWaveConfigError, backoffMs, pause } from "./client.js";
import type { MatterWave, Prepared, RequestOptions } from "./client.js";
import type {
  Conversation,
  ConversationContext,
  ConversationFilter,
  ConversationList,
  ListConversationsParams,
  ConversationMessage,
  ConversationWithMessages,
  CreateConversationParams,
  DeviceCode,
  DeviceToken,
  EditMessageParams,
  RegenerateMessageParams,
  SearchResults,
  SendMessageParams,
  UpdateConversationParams,
} from "./conversation-types.js";
import { APIConnectionError, APIError, APITimeoutError, DeviceAuthError, MatterWaveError } from "./errors.js";
import { frameFromEvent, isTerminal, type ConversationFrame } from "./frames.js";
import { sseEvents, type SSEEvent } from "./sse.js";
import type { WithRequestId } from "./types.js";

const REQUEST_ID_HEADER = "x-request-id";
const LIST_FILTERS: readonly ConversationFilter[] = ["default", "all", "pinned", "archived"];

// The resume path only reads `Last-Event-ID`, but the request body is
// validated before the route runs, so it has to be a valid send. A turn that
// was not a send (an edit, a regenerate) resumes through the same route with
// this in place of the text it never had.
export const RESUME_PLACEHOLDER = "(resume)";

const DEVICE_ERRORS = new Set(["authorization_pending", "slow_down", "expired_token", "access_denied"]);
// RFC 8628 section 3.5: each `slow_down` adds five seconds to the interval, for good.
const SLOW_DOWN_STEP_S = 5;

/** @internal An id for a path segment; one that would change the path it is spliced into is a bug at the call site. */
export function segment(name: string, value: string): string {
  if (!value || value.includes("/") || value === "." || value === "..") {
    throw new MatterWaveConfigError(`${name} must be a non-empty id without '/', got ${value}`);
  }
  return encodeURIComponent(value);
}

function conversationPath(conversationId: string, suffix = ""): string {
  return `/api/conversations/${segment("conversationId", conversationId)}${suffix}`;
}

/** @internal */
export function query(params: Record<string, string | number | undefined>): string {
  const pairs = Object.entries(params).filter((p): p is [string, string | number] => p[1] !== undefined);
  return pairs.length === 0 ? "" : `?${new URLSearchParams(pairs.map(([k, v]) => [k, String(v)]))}`;
}

/** The fields that were given, so the server's defaults apply to the rest. */
function defined(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined && v !== null));
}

function turnBody(params: { content?: string } & Record<string, unknown>): Record<string, unknown> {
  if ("content" in params && !params.content) throw new MatterWaveConfigError("content must be non-empty");
  return defined(params);
}

/**
 * The request that picks a dropped turn up after `lastEventId`. It goes to
 * the send route whatever started the turn: that is where the server keeps
 * the resume path, and the header makes it replay rather than generate, so
 * the prompt is never billed twice.
 */
export function resumeRequest(original: Prepared, conversationId: string, lastEventId: string): Prepared {
  const body = { ...((original.body as Record<string, unknown> | undefined) ?? {}) };
  if (!body.content) body.content = RESUME_PLACEHOLDER;
  return {
    method: "POST",
    path: conversationPath(conversationId, "/messages"),
    body,
    keyed: true,
    stream: true,
    headers: { "Last-Event-ID": lastEventId },
  };
}

function dropped(cause: unknown): APIConnectionError {
  return new APIConnectionError(
    "The conversation stream ended before the turn did, and could not be resumed.",
    { cause },
  );
}

/**
 * One conversation turn as it streams: `for await` it for typed frames, or
 * `text()` for the answer's words.
 *
 * The stream ends after `done`, `error` or `moderation_block`. If the body
 * drops before then, the turn is picked up once from the last frame seen by
 * re-presenting `Last-Event-ID`; the server replays the rest of the same
 * generation rather than starting another. `result` is the saved assistant
 * message once `done` has arrived.
 */
export class ConversationStream implements AsyncIterable<ConversationFrame> {
  readonly requestId: string | null;
  lastEventId: string | null = null;
  result: ConversationMessage | null = null;
  private consumed = false;

  constructor(
    private readonly client: MatterWave,
    private readonly prepared: Prepared,
    private readonly conversationId: string,
    private response: Response,
    private controller: AbortController,
    private readonly options: RequestOptions,
  ) {
    this.requestId = response.headers.get(REQUEST_ID_HEADER);
  }

  private frame(event: SSEEvent): ConversationFrame {
    if (event.id !== null) this.lastEventId = event.id;
    let data: unknown;
    try {
      data = JSON.parse(event.data);
    } catch {
      throw new APIError(`The stream carried a '${event.event}' frame that is not JSON.`, {
        status: null,
        requestId: this.requestId,
        body: event.data,
      });
    }
    const frame = frameFromEvent(event.event, data, event.id);
    if (frame.event === "done") this.result = frame.message;
    return frame;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<ConversationFrame> {
    if (this.consumed) throw new MatterWaveError("A stream can be iterated once.");
    this.consumed = true;
    let resumed = false;
    try {
      for (;;) {
        let cause: unknown = undefined;
        const body = this.response.body;
        if (body === null) {
          throw new APIError("The stream has no body.", { status: null, requestId: this.requestId });
        }
        try {
          for await (const event of sseEvents(body)) {
            const frame = this.frame(event);
            yield frame;
            if (isTerminal(frame)) return;
          }
        } catch (err) {
          // A broken frame or the caller's abort is not a dropped body.
          if (err instanceof MatterWaveError || this.options.signal?.aborted) throw err;
          cause = err;
        }
        // One resume per stream; a turn that dropped before any frame carried
        // an id cannot resume without re-sending, which would bill twice.
        if (resumed || this.lastEventId === null) throw dropped(cause);
        resumed = true;
        this.controller.abort();
        await pause(backoffMs(0, null));
        const next = await this.client.send(
          resumeRequest(this.prepared, this.conversationId, this.lastEventId),
          this.options,
        );
        this.response = next.response;
        this.controller = next.controller;
      }
    } finally {
      this.controller.abort();
    }
  }

  /** The answer's text, skipping reasoning and every other frame. */
  async *text(): AsyncGenerator<string> {
    for await (const frame of this) {
      if (frame.event === "delta" && frame.content) yield frame.content;
    }
  }

  abort(): void {
    this.controller.abort();
  }
}

export class Conversations {
  constructor(private readonly client: MatterWave) {}

  private call<T extends object>(
    method: Prepared["method"],
    path: string,
    body: unknown,
    options: RequestOptions,
  ): Promise<WithRequestId<T>> {
    return this.client.json<T>({ method, path, body, keyed: true, stream: false }, options);
  }

  /**
   * `GET /api/conversations`: one page of the sidebar list. `filter` is `default` (unarchived,
   * pinned first), `all`, `pinned` or `archived`; `cursor` is a previous page's `next_cursor`,
   * which is null on the last page. `pages()` walks them.
   */
  list(params: ListConversationsParams = {}, options: RequestOptions = {}): Promise<WithRequestId<ConversationList>> {
    if (params.filter !== undefined && !LIST_FILTERS.includes(params.filter)) {
      throw new MatterWaveConfigError(`filter must be one of ${LIST_FILTERS.join(", ")}, got ${params.filter}`);
    }
    const path = `/api/conversations${query({ filter: params.filter, limit: params.limit, cursor: params.cursor })}`;
    return this.call("GET", path, undefined, options);
  }

  /** Every page of `list`, first to last, each fetched as the previous one is consumed. */
  async *pages(
    params: Omit<ListConversationsParams, "cursor"> = {},
    options: RequestOptions = {},
  ): AsyncGenerator<WithRequestId<ConversationList>> {
    let cursor: string | undefined;
    do {
      const page = await this.list({ ...params, cursor }, options);
      yield page;
      cursor = page.next_cursor ?? undefined;
    } while (cursor !== undefined);
  }

  /** `GET /api/conversations/search`: full text over the caller's own messages. */
  search(q: string, params: { limit?: number } = {}, options: RequestOptions = {}): Promise<WithRequestId<SearchResults>> {
    return this.call("GET", `/api/conversations/search${query({ q, limit: params.limit })}`, undefined, options);
  }

  /** `POST /api/conversations`. An untitled one is named from its first message. */
  create(params: CreateConversationParams = {}, options: RequestOptions = {}): Promise<WithRequestId<Conversation>> {
    return this.call("POST", "/api/conversations", defined({ ...params }), options);
  }

  /** The conversation and its active path; `full: true` adds `tree`. */
  get(
    conversationId: string,
    params: { full?: boolean } = {},
    options: RequestOptions = {},
  ): Promise<WithRequestId<ConversationWithMessages>> {
    const path = conversationPath(conversationId) + query({ full: params.full ? "1" : undefined });
    return this.call("GET", path, undefined, options);
  }

  /**
   * `PATCH /api/conversations/{id}`: rename the conversation, set the model
   * its turns use when a turn names none, or both.
   *
   * `default_model: null` clears the model back to the deployment's default,
   * so that key is sent whenever it is present, null included; a key left
   * out is left alone on the server, which reads an empty body as "nothing
   * to update" -- refused here before the request is made.
   */
  update(
    conversationId: string,
    params: UpdateConversationParams,
    options: RequestOptions = {},
  ): Promise<WithRequestId<Conversation>> {
    const body: Record<string, unknown> = {};
    if (params.default_model !== undefined) body.default_model = params.default_model;
    if (params.title !== undefined) body.title = params.title;
    if (Object.keys(body).length === 0) {
      throw new MatterWaveConfigError("update needs a title or a default_model");
    }
    return this.call("PATCH", conversationPath(conversationId), body, options);
  }

  /** Every message, branches included, in creation order, as `messages`. */
  tree(conversationId: string, options: RequestOptions = {}): Promise<WithRequestId<ConversationWithMessages>> {
    return this.call("GET", conversationPath(conversationId, "/tree"), undefined, options);
  }

  /** Show the branch ending at `messageId`; returns the new path. */
  setActiveLeaf(
    conversationId: string,
    messageId: string,
    options: RequestOptions = {},
  ): Promise<WithRequestId<ConversationWithMessages>> {
    segment("messageId", messageId);
    return this.call("PUT", conversationPath(conversationId, "/active-leaf"), { message_id: messageId }, options);
  }

  /** Copy the path down to `messageId` into a new conversation. */
  fork(
    conversationId: string,
    messageId: string,
    params: { title?: string | null } = {},
    options: RequestOptions = {},
  ): Promise<WithRequestId<ConversationWithMessages>> {
    segment("messageId", messageId);
    const body = defined({ message_id: messageId, title: params.title });
    return this.call("POST", conversationPath(conversationId, "/fork"), body, options);
  }

  /** How much of the model's context window the conversation uses. */
  context(conversationId: string, options: RequestOptions = {}): Promise<WithRequestId<ConversationContext>> {
    return this.call("GET", conversationPath(conversationId, "/context"), undefined, options);
  }

  /** Fold the earlier messages into a summary now, without a turn. Returns the summary message; `ConflictError` when there is nothing to fold yet. */
  compact(conversationId: string, options: RequestOptions = {}): Promise<WithRequestId<ConversationMessage>> {
    return this.call("POST", conversationPath(conversationId, "/compact"), {}, options);
  }

  private async stream(prepared: Prepared, conversationId: string, options: RequestOptions): Promise<ConversationStream> {
    const { response, controller } = await this.client.send(prepared, options);
    return new ConversationStream(this.client, prepared, conversationId, response, controller, options);
  }

  /**
   * Append a user message and stream the reply. The server builds the prompt
   * from the stored history and instructions; `parent_id` sends onto that
   * branch instead of the current leaf.
   */
  send(conversationId: string, params: SendMessageParams, options: RequestOptions = {}): Promise<ConversationStream> {
    const body = turnBody({ ...params, attachment_ids: params.attachment_ids?.length ? params.attachment_ids : undefined });
    const prepared: Prepared = {
      method: "POST",
      path: conversationPath(conversationId, "/messages"),
      body,
      keyed: true,
      stream: true,
    };
    return this.stream(prepared, conversationId, options);
  }

  /** Edit a user message as a new branch beside it, and stream the answer. */
  edit(
    conversationId: string,
    messageId: string,
    params: EditMessageParams,
    options: RequestOptions = {},
  ): Promise<ConversationStream> {
    const prepared: Prepared = {
      method: "POST",
      path: conversationPath(conversationId, `/messages/${segment("messageId", messageId)}/edit`),
      body: turnBody({ ...params }),
      keyed: true,
      stream: true,
    };
    return this.stream(prepared, conversationId, options);
  }

  /** Answer an assistant message's turn again, as a sibling of it. */
  regenerate(
    conversationId: string,
    messageId: string,
    params: RegenerateMessageParams = {},
    options: RequestOptions = {},
  ): Promise<ConversationStream> {
    const prepared: Prepared = {
      method: "POST",
      path: conversationPath(conversationId, `/messages/${segment("messageId", messageId)}/regenerate`),
      body: defined({ ...params }),
      keyed: true,
      stream: true,
    };
    return this.stream(prepared, conversationId, options);
  }
}

/** The device-flow refusal inside an error response, or null for any other failure. Read bare or inside the API's `detail`. */
function deviceErrorOf(error: APIError): DeviceAuthError | null {
  const body = (typeof error.body === "object" && error.body !== null ? error.body : {}) as Record<string, unknown>;
  const detail = body.detail;
  let code: unknown = body.error;
  if (code === undefined && typeof detail === "object" && detail !== null) code = (detail as { error?: unknown }).error;
  else if (code === undefined && typeof detail === "string") code = detail;
  if (typeof code !== "string" || !DEVICE_ERRORS.has(code)) return null;
  const description = typeof body.error_description === "string" ? body.error_description : code;
  return new DeviceAuthError(description, {
    status: error.status,
    code,
    requestId: error.requestId,
    body: error.body,
  });
}

export interface DeviceLoginOptions {
  /** Show the person the code and URL. May return a promise; the poll starts once it settles. */
  onCode: (code: DeviceCode) => unknown;
  /** Give up after this long, if it is sooner than the code's own expiry. */
  timeoutMs?: number;
  clientName?: string;
  signal?: AbortSignal;
}

/**
 * Sign a person in from a device with no browser of its own (RFC 8628): show
 * them a code, they approve it in any browser, and the poll returns an API
 * key that acts as them. Nothing is stored here; keeping the token is the
 * caller's job.
 */
export class DeviceAuth {
  constructor(private readonly client: MatterWave) {}

  /** `POST /api/auth/device`: a code to show and the URL to approve it at. */
  start(params: { client_name?: string } = {}, options: RequestOptions = {}): Promise<WithRequestId<DeviceCode>> {
    return this.client.json<DeviceCode>(
      { method: "POST", path: "/api/auth/device", body: defined({ ...params }), keyed: false, stream: false },
      options,
    );
  }

  /** `POST /api/auth/device/token`, once. The token when approved; `DeviceAuthError` with the RFC's `code` while it is not. */
  async poll(deviceCode: string, options: RequestOptions = {}): Promise<WithRequestId<DeviceToken>> {
    if (!deviceCode) throw new MatterWaveConfigError("deviceCode must be non-empty");
    try {
      return await this.client.json<DeviceToken>(
        {
          method: "POST",
          path: "/api/auth/device/token",
          body: { device_code: deviceCode },
          keyed: false,
          stream: false,
        },
        options,
      );
    } catch (err) {
      const device = err instanceof APIError ? deviceErrorOf(err) : null;
      throw device ?? err;
    }
  }

  /**
   * Start, hand the code to `onCode` to show, and poll at the server's
   * interval (longer after each `slow_down`) until approved. Throws
   * `DeviceAuthError` when denied or expired, `APITimeoutError` when
   * `timeoutMs` passes first.
   */
  async login(options: DeviceLoginOptions): Promise<WithRequestId<DeviceToken>> {
    const request = { signal: options.signal };
    const code = await this.start(options.clientName ? { client_name: options.clientName } : {}, request);
    await options.onCode(code);
    let intervalS = Math.max(1, code.interval || 5);
    const expiresMs = (code.expires_in || 600) * 1000;
    const timedOut = options.timeoutMs !== undefined && options.timeoutMs < expiresMs;
    const deadline = Date.now() + (timedOut ? options.timeoutMs! : expiresMs);
    for (;;) {
      if (Date.now() + intervalS * 1000 > deadline) {
        throw timedOut
          ? new APITimeoutError(`The device login was not approved within ${options.timeoutMs}ms.`)
          : new DeviceAuthError("The device code expired before it was approved.", {
              status: null,
              code: "expired_token",
            });
      }
      await pause(intervalS * 1000);
      if (options.signal?.aborted) throw new MatterWaveError("The device login was aborted.");
      try {
        return await this.poll(code.device_code, request);
      } catch (err) {
        if (!(err instanceof DeviceAuthError)) throw err;
        if (err.code === "slow_down") intervalS += SLOW_DOWN_STEP_S;
        else if (err.code !== "authorization_pending") throw err;
      }
    }
  }
}

export class Auth {
  readonly device: DeviceAuth;
  constructor(client: MatterWave) {
    this.device = new DeviceAuth(client);
  }
}
