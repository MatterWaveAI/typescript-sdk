/**
 * The native API clients: `keys`, `usage`, `webhooks`, `attachments`,
 * `library`, `shares` and `budget`, one method per route on top of the
 * client's request and retry loop.
 *
 *     const key = await client.keys.create({ name: "ci", expires_in_days: 90 });
 *     const csv = await client.usage.exportCsv({ period: "2026-10" });
 *
 * These are the routes the web app's settings panes use, open to an API key
 * as its owner. Managing keys needs a key with `keys:manage` (or a
 * session), webhooks a key with `webhooks:manage`, the org usage report
 * (`usage.org`, `usage.exportCsv`) a key with `usage:read`, and moving a
 * budget cap an owner or admin. The scope never widens the owner's role:
 * webhooks still need the owner to be an org owner or admin, and a member's
 * `usage:read` key sees only their own row.
 */

import { MatterWaveConfigError } from "./client.js";
import type { MatterWave, Prepared, RequestOptions } from "./client.js";
import type { Conversation, SearchResults } from "./conversation-types.js";
import { query, segment } from "./conversations.js";
import type {
  ApiKey,
  ApiKeyList,
  ApiKeyWithSecret,
  Attachment,
  AttachmentLimits,
  Budget,
  ConversationTags,
  CreateKeyParams,
  CreateShareParams,
  CreateWebhookParams,
  CreatedShare,
  DeliveryStatus,
  Folder,
  Library,
  LibrarySearchParams,
  MemberBudget,
  MemberBudgetList,
  OrgUsage,
  SetMemberCapParams,
  SetMemberDefaultCapParams,
  SetOverageCapParams,
  ShareList,
  SharedConversation,
  Tag,
  UpdateFolderParams,
  UpdateKeyParams,
  UpdateWebhookParams,
  UploadAttachmentParams,
  UsageBalance,
  UsagePeriodParams,
  WebhookDelivery,
  WebhookDeliveryList,
  WebhookEndpoint,
  WebhookEndpointList,
  WebhookEndpointWithSecret,
} from "./native-types.js";
import type { WithRequestId } from "./types.js";

const DELIVERY_STATUSES: readonly DeliveryStatus[] = ["pending", "sending", "delivered", "failed"];
const KEY_FIELDS = ["name", "scopes", "expires_in_days", "expires_at", "allowed_cidrs", "rpm_limit"] as const;

/** The keys that were given, `null` included: where null means "clear it", it has to be sent. */
function given(body: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
}

/** The keys that carry a value, where the server reads null and absent alike. */
function present(body: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined && v !== null));
}

abstract class Resource {
  constructor(protected readonly client: MatterWave) {}

  protected call<T extends object>(
    method: Prepared["method"],
    path: string,
    body: unknown,
    options: RequestOptions,
  ): Promise<WithRequestId<T>> {
    return this.client.json<T>({ method, path, body, keyed: true, stream: false }, options);
  }

  protected none(method: Prepared["method"], path: string, options: RequestOptions): Promise<void> {
    return this.client.empty({ method, path, body: undefined, keyed: true, stream: false }, options);
  }
}

// --- keys ----------------------------------------------------------------------

function keyPath(keyId: string, suffix = ""): string {
  return `/api/keys/${segment("keyId", keyId)}${suffix}`;
}

function checkExpiry(params: { expires_in_days?: number | null; expires_at?: string | null }): void {
  if (params.expires_in_days != null && params.expires_at != null) {
    throw new MatterWaveConfigError("pass expires_in_days or expires_at, not both");
  }
}

/** `/api/keys`: the org's API keys. The secret is on the answer to `create` and `rotate` and nowhere else, ever. */
export class Keys extends Resource {
  /** Every key, revoked ones included; never a secret. */
  list(options: RequestOptions = {}): Promise<WithRequestId<ApiKeyList>> {
    return this.call("GET", "/api/keys", undefined, options);
  }

  /** Mint a key. `key` on the answer is the secret, shown this once. */
  create(params: CreateKeyParams, options: RequestOptions = {}): Promise<WithRequestId<ApiKeyWithSecret>> {
    if (!params.name?.trim()) throw new MatterWaveConfigError("a key must have a name");
    checkExpiry(params);
    return this.call("POST", "/api/keys", present(params), options);
  }

  /**
   * `PATCH /api/keys/{id}`: change a key in place; the secret stays. A field
   * left out is left alone, `null` clears it.
   */
  update(keyId: string, params: UpdateKeyParams, options: RequestOptions = {}): Promise<WithRequestId<ApiKey>> {
    checkExpiry(params);
    const body = given(params);
    if (!KEY_FIELDS.some((field) => field in body)) {
      throw new MatterWaveConfigError(`update needs one of ${KEY_FIELDS.join(", ")}`);
    }
    return this.call("PATCH", keyPath(keyId), body, options);
  }

  /** A new secret for the same key; the old one works until `previous_valid_until`. */
  rotate(keyId: string, options: RequestOptions = {}): Promise<WithRequestId<ApiKeyWithSecret>> {
    return this.call("POST", keyPath(keyId, "/rotate"), undefined, options);
  }

  /** Revoke, for good; the row stays as evidence. A key may always revoke itself. */
  revoke(keyId: string, options: RequestOptions = {}): Promise<void> {
    return this.none("DELETE", keyPath(keyId), options);
  }
}

// --- usage ---------------------------------------------------------------------

/** What the org has used: the balance this period, the per-member month, and that month as CSV. */
export class UsageClient extends Resource {
  /** `GET /api/me/usage`: the org's balance this period, by model and by day. */
  get(options: RequestOptions = {}): Promise<WithRequestId<UsageBalance>> {
    return this.call("GET", "/api/me/usage", undefined, options);
  }

  /**
   * `GET /api/org/usage`: per member for one calendar month. An owner or
   * admin sees everyone; anyone else their own row.
   */
  org(params: UsagePeriodParams = {}, options: RequestOptions = {}): Promise<WithRequestId<OrgUsage>> {
    return this.call("GET", `/api/org/usage${query({ period: params.period })}`, undefined, options);
  }

  /** `GET /api/org/usage.csv`: the rows of `org`, scoped the same way, as the CSV text the server wrote. */
  exportCsv(params: UsagePeriodParams = {}, options: RequestOptions = {}): Promise<string> {
    return this.client.text(
      {
        method: "GET",
        path: `/api/org/usage.csv${query({ period: params.period })}`,
        body: undefined,
        keyed: true,
        stream: false,
        headers: { Accept: "text/csv" },
      },
      options,
    );
  }
}

// --- webhooks ------------------------------------------------------------------

function endpointPath(endpointId: string, suffix = ""): string {
  return `/api/org/webhooks/${segment("endpointId", endpointId)}${suffix}`;
}

/** `/api/org/webhooks`: outbound endpoints and their delivery log. The signing secret is on `create` and `rotateSecret` only. */
export class Webhooks extends Resource {
  /** The endpoints, and every event type one may subscribe to. */
  list(options: RequestOptions = {}): Promise<WithRequestId<WebhookEndpointList>> {
    return this.call("GET", "/api/org/webhooks", undefined, options);
  }

  /** A new endpoint for a public https URL, subscribed to `events`. */
  create(params: CreateWebhookParams, options: RequestOptions = {}): Promise<WithRequestId<WebhookEndpointWithSecret>> {
    if (params.events.length === 0) throw new MatterWaveConfigError("subscribe to at least one event");
    return this.call("POST", "/api/org/webhooks", present(params), options);
  }

  get(endpointId: string, options: RequestOptions = {}): Promise<WithRequestId<WebhookEndpoint>> {
    return this.call("GET", endpointPath(endpointId), undefined, options);
  }

  /** Change what was given; `enabled: true` re-enables one the failures switched off. */
  update(
    endpointId: string,
    params: UpdateWebhookParams,
    options: RequestOptions = {},
  ): Promise<WithRequestId<WebhookEndpoint>> {
    const body = present(params);
    if (Object.keys(body).length === 0) {
      throw new MatterWaveConfigError("update needs one of url, events, description, enabled");
    }
    if (params.events?.length === 0) throw new MatterWaveConfigError("subscribe to at least one event");
    return this.call("PATCH", endpointPath(endpointId), body, options);
  }

  delete(endpointId: string, options: RequestOptions = {}): Promise<void> {
    return this.none("DELETE", endpointPath(endpointId), options);
  }

  /** A new signing secret, shown once; the old one stops signing now. */
  rotateSecret(endpointId: string, options: RequestOptions = {}): Promise<WithRequestId<WebhookEndpointWithSecret>> {
    return this.call("POST", endpointPath(endpointId, "/rotate"), undefined, options);
  }

  /** Send a `ping` now. Answers whether or not the receiver took it: the delivery's `status` says which. */
  test(endpointId: string, options: RequestOptions = {}): Promise<WithRequestId<WebhookDelivery>> {
    return this.call("POST", endpointPath(endpointId, "/test"), undefined, options);
  }

  /** The delivery log, filtered by `status` when one is given. */
  deliveries(
    endpointId: string,
    params: { status?: DeliveryStatus } = {},
    options: RequestOptions = {},
  ): Promise<WithRequestId<WebhookDeliveryList>> {
    if (params.status !== undefined && !DELIVERY_STATUSES.includes(params.status)) {
      throw new MatterWaveConfigError(`status must be one of ${DELIVERY_STATUSES.join(", ")}, got ${params.status}`);
    }
    return this.call("GET", endpointPath(endpointId, `/deliveries${query({ status: params.status })}`), undefined, options);
  }

  /** Queue the same event again as a new delivery; its result lands in the log. */
  redeliver(endpointId: string, deliveryId: string, options: RequestOptions = {}): Promise<WithRequestId<WebhookDelivery>> {
    const path = endpointPath(endpointId, `/deliveries/${segment("deliveryId", deliveryId)}/redeliver`);
    return this.call("POST", path, undefined, options);
  }
}

// --- attachments ---------------------------------------------------------------

function attachmentPath(attachmentId: string, suffix = ""): string {
  return `/api/attachments/${segment("attachmentId", attachmentId)}${suffix}`;
}

/** `/api/attachments`: files to attach to a message (`attachment_ids` on `conversations.send`). */
export class Attachments extends Resource {
  /**
   * Upload one file as multipart. The server decides its type from the
   * bytes and scans it; it is readable once `scan_status` is `clean`.
   */
  upload(params: UploadAttachmentParams, options: RequestOptions = {}): Promise<WithRequestId<Attachment>> {
    if (!params.filename) throw new MatterWaveConfigError("filename must be non-empty");
    const blob = params.file instanceof Blob ? params.file : new Blob([params.file as BlobPart]);
    const form = new FormData();
    form.append("file", blob, params.filename);
    return this.call("POST", `/api/attachments${query({ conversation_id: params.conversation_id })}`, form, options);
  }

  /** The metadata, with a fresh `download_url`. */
  get(attachmentId: string, options: RequestOptions = {}): Promise<WithRequestId<Attachment>> {
    return this.call("GET", attachmentPath(attachmentId), undefined, options);
  }

  /** Mark it deleted; the stored bytes go on the sweeper's next pass. */
  delete(attachmentId: string, options: RequestOptions = {}): Promise<void> {
    return this.none("DELETE", attachmentPath(attachmentId), options);
  }

  /**
   * The file's bytes, from an attachment's `download_url` (or the URL
   * itself). The URL expires in minutes: `get` mints a fresh one.
   */
  download(attachment: Pick<Attachment, "download_url"> | string, options: RequestOptions = {}): Promise<ArrayBuffer> {
    const url = typeof attachment === "string" ? attachment : attachment.download_url;
    const match = /^\/api\/attachments\/([^/?#]+)\/content(\?[^#]*)?$/.exec(url ?? "");
    if (!match) throw new MatterWaveConfigError(`not an attachment download URL: ${url}`);
    const path = attachmentPath(decodeURIComponent(match[1]!), `/content${match[2] ?? ""}`);
    return this.client.bytes(
      { method: "GET", path, body: undefined, keyed: true, stream: false, headers: { Accept: "*/*" } },
      options,
    );
  }

  /** What the caller may still upload. */
  limits(options: RequestOptions = {}): Promise<WithRequestId<AttachmentLimits>> {
    return this.call("GET", "/api/attachments/limits/me", undefined, options);
  }
}

// --- library -------------------------------------------------------------------

function folderPath(folderId: string): string {
  return `/api/library/folders/${segment("folderId", folderId)}`;
}

function libraryConversationPath(conversationId: string, suffix: string): string {
  return `/api/library/conversations/${segment("conversationId", conversationId)}${suffix}`;
}

/** The caller's folders and tags, and search across their conversations. */
export class LibraryClient extends Resource {
  /** Folders, tags and which tags each conversation carries, in one read. */
  get(options: RequestOptions = {}): Promise<WithRequestId<Library>> {
    return this.call("GET", "/api/library", undefined, options);
  }

  /** `GET /api/search`: titles and messages, ranked, a page at a time. */
  search(q: string, params: LibrarySearchParams = {}, options: RequestOptions = {}): Promise<WithRequestId<SearchResults>> {
    return this.call("GET", `/api/search${query({ q, cursor: params.cursor, limit: params.limit })}`, undefined, options);
  }

  createFolder(name: string, options: RequestOptions = {}): Promise<WithRequestId<Folder>> {
    return this.call("POST", "/api/library/folders", { name }, options);
  }

  /** Rename the folder, move it in the order, or both. */
  updateFolder(folderId: string, params: UpdateFolderParams, options: RequestOptions = {}): Promise<WithRequestId<Folder>> {
    const body = present(params);
    if (Object.keys(body).length === 0) throw new MatterWaveConfigError("update needs a name or a position");
    return this.call("PATCH", folderPath(folderId), body, options);
  }

  /** Its conversations go back to the main list; nothing else is deleted. */
  deleteFolder(folderId: string, options: RequestOptions = {}): Promise<void> {
    return this.none("DELETE", folderPath(folderId), options);
  }

  /** File the conversation in a folder; `null` returns it to the main list. */
  move(conversationId: string, folderId: string | null, options: RequestOptions = {}): Promise<WithRequestId<Conversation>> {
    return this.call("PUT", libraryConversationPath(conversationId, "/folder"), { folder_id: folderId }, options);
  }

  /** The tag of that name, made now or already there. */
  createTag(name: string, options: RequestOptions = {}): Promise<WithRequestId<Tag>> {
    return this.call("POST", "/api/library/tags", { name }, options);
  }

  deleteTag(tagId: string, options: RequestOptions = {}): Promise<void> {
    return this.none("DELETE", `/api/library/tags/${segment("tagId", tagId)}`, options);
  }

  /** Replace the conversation's tags with exactly these. */
  setTags(conversationId: string, tagIds: string[], options: RequestOptions = {}): Promise<WithRequestId<ConversationTags>> {
    return this.call("PUT", libraryConversationPath(conversationId, "/tags"), { tag_ids: tagIds }, options);
  }
}

// --- budget --------------------------------------------------------------------

/** A spend cap in micro-dollars at list price. A negative number is refused here rather than spent on a 422. */
function checkCap(name: string, micros: number | null): void {
  if (micros !== null && micros < 0) {
    throw new MatterWaveConfigError(`${name} must be 0 or more, got ${micros}`);
  }
}

/** `/api/budget`: the org's allowance, what it has spent past it, and the caps that stop it. Every member may read the balance; moving a cap is an owner or admin, and audited. */
export class BudgetClient extends Resource {
  /** `GET /api/budget`: the period, the overage and the caps, with the caller's own `member_cap` and `member_spent` beside the org's. */
  get(options: RequestOptions = {}): Promise<WithRequestId<Budget>> {
    return this.call("GET", "/api/budget", undefined, options);
  }

  /** `PUT /api/budget`: the most overage a period may run up, in micro-dollars at list price. 0 restores the plan's default. Owner or admin only. */
  setOverageCap(params: SetOverageCapParams, options: RequestOptions = {}): Promise<WithRequestId<Budget>> {
    checkCap("overage_cap_micros", params.overage_cap_micros);
    return this.call("PUT", "/api/budget", params, options);
  }

  /** `GET /api/budget/members`: every member's cap in force and spend this month. Owner or admin only. */
  members(options: RequestOptions = {}): Promise<WithRequestId<MemberBudgetList>> {
    return this.call("GET", "/api/budget/members", undefined, options);
  }

  /** `PUT /api/budget/members`: the cap every member without one of their own is held to; `null` lifts it. Owner or admin only. */
  setMemberDefaultCap(
    params: SetMemberDefaultCapParams,
    options: RequestOptions = {},
  ): Promise<WithRequestId<MemberBudgetList>> {
    checkCap("member_default_cap_micros", params.member_default_cap_micros);
    return this.call("PUT", "/api/budget/members", params, options);
  }

  /** `PUT /api/budget/members/{subject}`: one member's own cap; `null` removes it so the default applies. Owner or admin only, and only for a current member. */
  setMemberCap(
    subject: string,
    params: SetMemberCapParams,
    options: RequestOptions = {},
  ): Promise<WithRequestId<MemberBudget>> {
    checkCap("cap_micros", params.cap_micros);
    return this.call("PUT", `/api/budget/members/${segment("subject", subject)}`, params, options);
  }
}

// --- shares --------------------------------------------------------------------

/** Read-only links to a snapshot of a conversation. The token is on the answer to `create` and nowhere else. */
export class Shares extends Resource {
  /** Snapshot the active path and mint a link. */
  create(
    conversationId: string,
    params: CreateShareParams = {},
    options: RequestOptions = {},
  ): Promise<WithRequestId<CreatedShare>> {
    const path = `/api/conversations/${segment("conversationId", conversationId)}/share`;
    return this.call("POST", path, { expires_in_s: params.expires_in_s ?? null }, options);
  }

  /** The links made of one conversation. */
  list(conversationId: string, options: RequestOptions = {}): Promise<WithRequestId<ShareList>> {
    return this.call("GET", `/api/conversations/${segment("conversationId", conversationId)}/shares`, undefined, options);
  }

  /** Every link the caller made. */
  listMine(options: RequestOptions = {}): Promise<WithRequestId<ShareList>> {
    return this.call("GET", "/api/me/shares", undefined, options);
  }

  revoke(shareId: string, options: RequestOptions = {}): Promise<void> {
    return this.none("DELETE", `/api/shares/${segment("shareId", shareId)}`, options);
  }

  /** The public read anyone with the link gets; no key is sent. */
  view(token: string, options: RequestOptions = {}): Promise<WithRequestId<SharedConversation>> {
    return this.client.json<SharedConversation>(
      { method: "GET", path: `/api/share/${segment("token", token)}`, body: undefined, keyed: false, stream: false },
      options,
    );
  }
}
