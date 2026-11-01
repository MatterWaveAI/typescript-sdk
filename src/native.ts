/**
 * The native API clients: `keys`, `usage`, `webhooks`, `attachments`,
 * `library`, `shares`, `budget`, `notifications`, `announcements`,
 * `entitlements` and the `admin` namespace, one method per route on top of
 * the client's request and retry loop.
 *
 *     const key = await client.keys.create({ name: "ci", expires_in_days: 90 });
 *     const csv = await client.usage.exportCsv({ period: "2026-10" });
 *
 * These are the routes the web app's settings panes use, open to an API key
 * as its owner. Managing keys needs a key with `keys:manage` (or a
 * session), webhooks a key with `webhooks:manage`, the org usage report
 * (`usage.org`, `usage.exportCsv`) a key with `usage:read`, and moving a
 * budget cap an owner or admin. The audit trail (`client.audit`) is the one
 * exception among the reads: those routes gate on the membership row alone,
 * so an API key is refused there outright and a signed-in session is what
 * answers. The scope never widens the owner's role:
 * webhooks still need the owner to be an org owner or admin, and a member's
 * `usage:read` key sees only their own row. Notifications, announcements
 * and entitlements are the caller's own view, the way `/api/me` is: a
 * notification id belonging to someone else is a 404, indistinguishable
 * from a missing one. The `admin` namespace is the exception to all of it:
 * the operator's own routes, the platform `admin` role, not an API key's.
 */

import { MatterWaveConfigError } from "./client.js";
import type { MatterWave, Prepared, RequestOptions } from "./client.js";
import type { Conversation, SearchResults } from "./conversation-types.js";
import { query, segment } from "./conversations.js";
import type {
  AccountDeleted,
  AcceptTermsParams,
  AdminAnnouncement,
  AdminAnnouncementList,
  AnnouncementList,
  ApiKey,
  ApiKeyList,
  ApiKeyWithSecret,
  Attachment,
  AttachmentLimits,
  AttachIdpParams,
  AuditFilters,
  AuditListParams,
  AuditPage,
  Budget,
  BillingStatus,
  BillingUrl,
  CheckoutParams,
  ClaimDomainParams,
  CloseOrgParams,
  ConversationTags,
  CreateAnnouncementParams,
  CreateInviteLinkParams,
  CreateInviteParams,
  CreateKeyParams,
  CreateShareParams,
  CreateWebhookParams,
  CreatedInvite,
  CreatedInviteLink,
  CreatedShare,
  DeliveryStatus,
  DeleteAccountParams,
  DomainChallengeAnswer,
  DomainList,
  DomainVerification,
  EmailChangeCancelled,
  EmailChangeState,
  EmailCodeSent,
  EmailChanged,
  Entitlements,
  ExportJob,
  ExportJobStatus,
  Folder,
  IdpList,
  ImportJob,
  ImportJobList,
  InvoiceList,
  InviteList,
  InviteLinkList,
  InvitePreview,
  JoinPreview,
  Library,
  LibrarySearchParams,
  MemberBudget,
  MemberBudgetList,
  MemberList,
  ModelPolicy,
  NotificationList,
  NotificationListParams,
  OnboardingComplete,
  OrgProfile,
  OrgClosed,
  OrgDomainRow,
  OrgIdpRow,
  OrgMember,
  OrgRole,
  OrgShareList,
  OrgShareRevoked,
  OrgUsage,
  PasswordChangeParams,
  PasswordChanged,
  PlanCatalog,
  PlanHistory,
  Preferences,
  ReadAllNotifications,
  ReadNotification,
  RecoveryCodeMinted,
  RenameOrgParams,
  RenameParams,
  SessionList,
  SessionRevoked,
  SessionsRevokedOthers,
  SetMemberCapParams,
  SetMemberDefaultCapParams,
  SetModelPolicyParams,
  SetOverageCapParams,
  SetRoleParams,
  SetSsoParams,
  ShareList,
  SharedConversation,
  SharingPolicy,
  SwitchPlanParams,
  SsoEnforced,
  SsoRelaxed,
  SsoSettings,
  StartEmailChangeParams,
  Tag,
  TermsAccepted,
  UpdateAnnouncementParams,
  UpdateFolderParams,
  UpdateKeyParams,
  UpdatePreferencesParams,
  UpdateWebhookParams,
  UploadAttachmentParams,
  UploadImportParams,
  UsageBalance,
  UsagePeriodParams,
  VerifyEmailChangeParams,
  WebhookDelivery,
  WebhookDeliveryList,
  WebhookEndpoint,
  WebhookEndpointList,
  WebhookEndpointWithSecret,
} from "./native-types.js";
import type { WithRequestId } from "./types.js";

const DELIVERY_STATUSES: readonly DeliveryStatus[] = ["pending", "sending", "delivered", "failed"];
const AUDIT_LIMIT_MAX = 200;
const KEY_FIELDS = ["name", "scopes", "expires_in_days", "expires_at", "allowed_cidrs", "rpm_limit"] as const;
const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_MAX_LENGTH = 256;
const DELETE_ACCOUNT_PHRASE = "delete my account";

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

  /** A route that needs no key: the token in the body is the credential, or the answer rides the session cookie. */
  protected callAnon<T extends object>(
    method: Prepared["method"],
    path: string,
    body: unknown,
    options: RequestOptions,
  ): Promise<WithRequestId<T>> {
    return this.client.json<T>({ method, path, body, keyed: false, stream: false }, options);
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

/** The audit filter params, spelled out so the CSV read can take them without a `limit`. */
function auditQuery(params: AuditFilters): string {
  return query({ event: params.event, actor: params.actor, since: params.since, until: params.until });
}

/**
 * `/api/org/audit`: the org's trail of who changed what, the reads the org
 * pane's audit tab makes. Owner or admin, and by membership row rather than
 * a token claim: the platform refuses an API key on these routes outright,
 * so they answer a signed-in session.
 */
export class Audit extends Resource {
  /**
   * One page, newest first. `event` matches an action exactly or as a
   * dotted prefix; `actor` a subject or an email, case-insensitively;
   * `since`/`until` bound the window (a bare one is read as UTC); `cursor`
   * is a previous page's `next_cursor`; `limit` is 1 to 200, 50 when
   * omitted. A cursor the API did not mint is the server's 422.
   */
  list(params: AuditListParams = {}, options: RequestOptions = {}): Promise<WithRequestId<AuditPage>> {
    if (params.limit !== undefined && !(params.limit >= 1 && params.limit <= AUDIT_LIMIT_MAX)) {
      throw new MatterWaveConfigError(`limit must be 1 to ${AUDIT_LIMIT_MAX}, got ${params.limit}`);
    }
    return this.call(
      "GET",
      `/api/org/audit${query({
        event: params.event,
        actor: params.actor,
        since: params.since,
        until: params.until,
        cursor: params.cursor,
        limit: params.limit,
      })}`,
      undefined,
      options,
    );
  }

  /** `GET /api/org/audit.csv`: every matching row, as the CSV text the server streams (RFC 4180 line endings, `detail` as JSON). */
  exportCsv(params: AuditFilters = {}, options: RequestOptions = {}): Promise<string> {
    return this.client.text(
      {
        method: "GET",
        path: `/api/org/audit.csv${auditQuery(params)}`,
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

// --- notifications -------------------------------------------------------------

function notificationPath(notificationId: string): string {
  return `/api/me/notifications/${segment("notificationId", notificationId)}/read`;
}

/** The bell: one row per person per event, written where the event happens. Reading is the caller's own; another person's id is a 404. */
export class Notifications extends Resource {
  /**
   * The caller's notifications, newest first, with the unread count the
   * bell shows. `unread: true` lists only the unread rows; the count is
   * the same either way. At most 100 rows a page, 30 when omitted.
   */
  list(
    params: NotificationListParams = {},
    options: RequestOptions = {},
  ): Promise<WithRequestId<NotificationList>> {
    return this.call(
      "GET",
      `/api/me/notifications${query({ unread: params.unread ? 1 : undefined, limit: params.limit })}`,
      undefined,
      options,
    );
  }

  /** Mark one read; an already-read row keeps its first `read_at`. The answer carries the unread count left. */
  read(notificationId: string, options: RequestOptions = {}): Promise<WithRequestId<ReadNotification>> {
    return this.call("POST", notificationPath(notificationId), undefined, options);
  }

  /** Mark every unread row read. The answer counts the rows it changed. */
  readAll(options: RequestOptions = {}): Promise<WithRequestId<ReadAllNotifications>> {
    return this.call("POST", "/api/me/notifications/read-all", undefined, options);
  }
}

// --- announcements -------------------------------------------------------------

/** The operator's banners: every signed-in principal reads the ones inside their window, most severe first. A critical one is never dismissible. The write side is one namespace up, `client.admin.announcements`. */
export class Announcements extends Resource {
  /** The announcements active now, most severe first; an empty list where there is no store behind them. */
  list(options: RequestOptions = {}): Promise<WithRequestId<AnnouncementList>> {
    return this.call("GET", "/api/announcements", undefined, options);
  }
}

// --- admin: announcements --------------------------------------------------------

const ADMIN_SEVERITIES: readonly string[] = ["info", "warning", "critical"];
const ADMIN_MAX_MESSAGE_LENGTH = 500;
const ADMIN_MAX_LINK_LENGTH = 2000;

/** The route's own check (`valid_link` in api/matterwave/announcements.py): an absolute http(s) URL or a path on this site; never `//host`, which a browser resolves to another origin; no other scheme; no whitespace or control character anywhere. */
function validAnnouncementLink(link: string): boolean {
  for (const ch of link) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f || /\s/u.test(ch)) return false;
  }
  if (link.startsWith("/")) return !link.startsWith("//") && !link.includes("\\");
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return false;
  }
  return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "";
}

function checkAnnouncementMessage(message: string): void {
  if (!message.trim()) throw new MatterWaveConfigError("The message is empty.");
  if (message.length > ADMIN_MAX_MESSAGE_LENGTH) {
    throw new MatterWaveConfigError(`message must be ${ADMIN_MAX_MESSAGE_LENGTH} characters or fewer`);
  }
}

function checkAnnouncementSeverity(severity: string): void {
  if (!ADMIN_SEVERITIES.includes(severity)) {
    throw new MatterWaveConfigError(`severity must be one of ${ADMIN_SEVERITIES.join(", ")}, got ${severity}`);
  }
}

/** The route's `_clean_link`: trimmed, empty is no link, and what is left has to be a link. */
function cleanAnnouncementLink(link: string | null | undefined): string | null {
  if (link === null || link === undefined) return null;
  const trimmed = link.trim();
  if (!trimmed) return null;
  if (trimmed.length > ADMIN_MAX_LINK_LENGTH) {
    throw new MatterWaveConfigError(`link must be ${ADMIN_MAX_LINK_LENGTH} characters or fewer`);
  }
  if (!validAnnouncementLink(trimmed)) {
    throw new MatterWaveConfigError("A link is an http(s) URL or a path on this site.");
  }
  return trimmed;
}

function announcementPath(announcementId: string): string {
  return `/api/admin/announcements/${segment("announcementId", announcementId)}`;
}

/**
 * The operator's announcement management: `/api/admin/announcements`, the
 * rows the admin console's Announcements tab manages -- every column and
 * every window, not just the ones active now, each write one audit row on
 * the platform's side. These are operator routes: they mirror the admin
 * console and need the platform `admin` role, so an API key with user
 * scopes cannot call them. The signed-in read side stays
 * `client.announcements.list()`.
 */
export class AdminAnnouncements extends Resource {
  /** Every announcement, newest first, each with its `state`: `active`, `scheduled` or `ended`. */
  list(options: RequestOptions = {}): Promise<WithRequestId<AdminAnnouncementList>> {
    return this.call("GET", "/api/admin/announcements", undefined, options);
  }

  /**
   * Post one. A critical announcement is never dismissible, whatever was
   * asked; a window whose `ends_at` is not after its `starts_at` is a 422.
   */
  create(
    params: CreateAnnouncementParams,
    options: RequestOptions = {},
  ): Promise<WithRequestId<AdminAnnouncement>> {
    checkAnnouncementMessage(params.message);
    checkAnnouncementSeverity(params.severity ?? "info");
    const body: Record<string, unknown> = {
      message: params.message,
      severity: params.severity ?? "info",
      dismissible: params.dismissible ?? true,
    };
    const link = cleanAnnouncementLink(params.link);
    if (link !== null) body.link = link;
    if (params.starts_at != null) body.starts_at = params.starts_at;
    if (params.ends_at != null) body.ends_at = params.ends_at;
    return this.call("POST", "/api/admin/announcements", body, options);
  }

  /**
   * Change what was given; the rest stays. `link: null` clears the link
   * and `ends_at: null` makes the window open-ended for good;
   * `end_now: true` ends it at the server's clock instead, which is what
   * the console's "End now" button does. `NotFoundError` for an id that
   * is not one.
   */
  update(
    announcementId: string,
    params: UpdateAnnouncementParams,
    options: RequestOptions = {},
  ): Promise<WithRequestId<AdminAnnouncement>> {
    const body = given({ ...params, end_now: undefined }) as Record<string, unknown>;
    if (typeof body.message === "string") checkAnnouncementMessage(body.message);
    if (typeof body.severity === "string") checkAnnouncementSeverity(body.severity);
    if ("link" in body) body.link = cleanAnnouncementLink(params.link);
    if (params.end_now) body.end_now = true;
    if (Object.keys(body).length === 0) {
      throw new MatterWaveConfigError(
        "update needs one of message, severity, link, starts_at, ends_at, dismissible, end_now",
      );
    }
    return this.call("PATCH", announcementPath(announcementId), body, options);
  }

  /** Remove it for good. `NotFoundError` when there is no such id. */
  delete(announcementId: string, options: RequestOptions = {}): Promise<void> {
    return this.none("DELETE", announcementPath(announcementId), options);
  }
}

/** `/api/admin/*`: the operator surface, the routes the admin console speaks. Everything under it needs the platform `admin` role; an API key with user scopes cannot call any of it. */
export class Admin {
  readonly announcements: AdminAnnouncements;
  constructor(client: MatterWave) {
    this.announcements = new AdminAnnouncements(client);
  }
}

// --- account ------------------------------------------------------------------

function checkNewPassword(newPassword: string): void {  if (newPassword.length < PASSWORD_MIN_LENGTH) {
    throw new MatterWaveConfigError(
      `Use at least ${PASSWORD_MIN_LENGTH} characters: length is what makes a password hard to guess, not symbols.`,
    );
  }
  if (newPassword.length > PASSWORD_MAX_LENGTH) {
    throw new MatterWaveConfigError(`new_password must be at most ${PASSWORD_MAX_LENGTH} characters`);
  }
}

/**
 * The person's own account, beyond reading it: rename, re-accept the
 * terms, change the password or the email address, list and sign out
 * sessions, keep preferences, complete onboarding, and delete the
 * account. Every route here is about the caller and nobody else -- the
 * subject in the principal is the only key any of them use.
 *
 * The password and email writes are a **signed-in session's, not an API
 * key's**: a key acts for its owner, and its owner's password is not the
 * key's to change, so those routes answer a key with 403. The reads and
 * the rest work with either.
 */
export class Account extends Resource {
  /** `PATCH /api/me`: rename. Whitespace-collapsed, at most 100 characters once it is. */
  rename(params: RenameParams, options: RequestOptions = {}): Promise<WithRequestId<{ name: string }>> {
    if (!params.full_name?.trim()) throw new MatterWaveConfigError("full_name must not be empty");
    if (params.full_name.length > 1000) {
      throw new MatterWaveConfigError("full_name must be at most 1000 characters");
    }
    return this.call("PATCH", "/api/me", params, options);
  }

  /**
   * `POST /api/me/accept-terms`: record acceptance of the current terms.
   * Only the current version is accepted -- a client holding a stale
   * constant gets the server's 422 -- and the answer says which version
   * was recorded.
   */
  acceptTerms(params: AcceptTermsParams, options: RequestOptions = {}): Promise<WithRequestId<TermsAccepted>> {
    if (!params.version?.trim()) throw new MatterWaveConfigError("version must be non-empty");
    return this.call("POST", "/api/me/accept-terms", params, options);
  }

  /** `POST /api/me/onboarding/complete`: record that the first-run walkthrough was finished or skipped. Idempotent; a second call keeps the first timestamp. */
  completeOnboarding(options: RequestOptions = {}): Promise<WithRequestId<OnboardingComplete>> {
    return this.call("POST", "/api/me/onboarding/complete", undefined, options);
  }

  /**
   * `POST /api/me/password`: change the password. A session only (403 for
   * an API key). On success every other session ends -- a changed password
   * is most often a response to a device the person no longer trusts --
   * and the answer counts them.
   */
  changePassword(params: PasswordChangeParams, options: RequestOptions = {}): Promise<WithRequestId<PasswordChanged>> {
    if (!params.current_password) throw new MatterWaveConfigError("current_password must be non-empty");
    checkNewPassword(params.new_password);
    return this.call("POST", "/api/me/password", params, options);
  }

  /** `GET /api/me/sessions`: the caller's live sessions, the one making the request flagged. */
  sessions(options: RequestOptions = {}): Promise<WithRequestId<SessionList>> {
    return this.call("GET", "/api/me/sessions", undefined, options);
  }

  /**
   * `DELETE /api/me/sessions/{id}`: sign one session out. The caller's own
   * is allowed -- it is "sign out" with the row revoked as well.
   * `NotFoundError` for one that is not the caller's.
   */
  revokeSession(sessionId: string, options: RequestOptions = {}): Promise<WithRequestId<SessionRevoked>> {
    return this.call("DELETE", `/api/me/sessions/${segment("sessionId", sessionId)}`, undefined, options);
  }

  /** `POST /api/me/sessions/revoke-others`: every session but this one; the answer counts them. */
  revokeOtherSessions(options: RequestOptions = {}): Promise<WithRequestId<SessionsRevokedOthers>> {
    return this.call("POST", "/api/me/sessions/revoke-others", undefined, options);
  }

  /** `GET /api/me/preferences`: the caller's preferences, defaults applied where nothing was saved. */
  preferences(options: RequestOptions = {}): Promise<WithRequestId<Preferences>> {
    return this.call("GET", "/api/me/preferences", undefined, options);
  }

  /**
   * `PUT /api/me/preferences`: the whole shape, validated by the server --
   * an unknown locale is a 422 before anything is written. Send what
   * `preferences()` returned; the type holds `billing_receipts` to `true`,
   * because receipts are transactional mail the server refuses to switch
   * off.
   */
  updatePreferences(params: UpdatePreferencesParams, options: RequestOptions = {}): Promise<WithRequestId<Preferences>> {
    if (params.locale !== undefined && params.locale !== null) {
      if (params.locale.length > 35 || !/^[a-zA-Z]{2,8}(-[a-zA-Z0-9]{1,8})*$/.test(params.locale.trim())) {
        throw new MatterWaveConfigError("locale must be a BCP-47 language tag such as en or en-GB");
      }
    }
    return this.call("PUT", "/api/me/preferences", params, options);
  }

  /** `GET /api/me/email`: the sign-in address and any change still waiting for its code, so a client can come back to the code step after a reload. Session only. */
  emailChangeState(options: RequestOptions = {}): Promise<WithRequestId<EmailChangeState>> {
    return this.call("GET", "/api/me/email", undefined, options);
  }

  /**
   * `POST /api/me/email`: mail a code to the new address. Nothing about
   * the login changes here -- the old address keeps signing in until the
   * code comes back. A session only. SSO-managed accounts are refused with
   * a 409 (the organisation's directory owns the address).
   */
  startEmailChange(params: StartEmailChangeParams, options: RequestOptions = {}): Promise<WithRequestId<EmailCodeSent>> {
    if (!params.new_email?.includes("@")) throw new MatterWaveConfigError("new_email must be an email address");
    if (!params.current_password) throw new MatterWaveConfigError("current_password must be non-empty");
    return this.call("POST", "/api/me/email", params, options);
  }

  /**
   * `POST /api/me/email/verify`: the code back; the address moves, every
   * other session ends, and the old address is told. A session only.
   */
  verifyEmailChange(params: VerifyEmailChangeParams, options: RequestOptions = {}): Promise<WithRequestId<EmailChanged>> {
    if (!params.code?.trim()) throw new MatterWaveConfigError("code must be non-empty");
    return this.call("POST", "/api/me/email/verify", params, options);
  }

  /** `POST /api/me/email/resend`: a fresh code for the pending address; 409 when nothing is pending. Session only. */
  resendEmailChange(options: RequestOptions = {}): Promise<WithRequestId<EmailCodeSent>> {
    return this.call("POST", "/api/me/email/resend", undefined, options);
  }

  /** `POST /api/me/email/cancel`: abandon a change that was started and not finished. Harmless when nothing is pending. Session only. */
  cancelEmailChange(options: RequestOptions = {}): Promise<WithRequestId<EmailChangeCancelled>> {
    return this.call("POST", "/api/me/email/cancel", undefined, options);
  }

  /**
   * `DELETE /api/me`: delete the account's data and end the session.
   * Danger: soft-deletes every conversation the caller owns, revokes their
   * API keys, drops their instructions and asks the identity provider to
   * deactivate the login, and cannot be undone from the API. The last
   * owner of an org that still has members must hand it over first (409).
   * `confirm` is the phrase `"delete my account"`, exactly, checked here
   * and again by the server. A session only.
   */
  deleteAccount(params: DeleteAccountParams, options: RequestOptions = {}): Promise<WithRequestId<AccountDeleted>> {
    if (params.confirm?.trim().toLowerCase() !== DELETE_ACCOUNT_PHRASE) {
      throw new MatterWaveConfigError(`Confirmation phrase must be "${DELETE_ACCOUNT_PHRASE}".`);
    }
    return this.call("DELETE", "/api/me", params, options);
  }
}

// --- exports / imports --------------------------------------------------------

function exportPath(exportId: string, suffix = ""): string {
  return `/api/me/export/${segment("exportId", exportId)}${suffix}`;
}

/**
 * The account export as a job, not a request. `GET /api/me/export` builds
 * the whole document inside one request; these are the routes the Data
 * pane uses instead: start one, poll it, download it. One pending export
 * per person (409 while one is building); a finished export is
 * downloadable for a week.
 */
export class Exports extends Resource {
  /** `POST /api/me/export` (202): queue the build. The answer is the row, `pending`. */
  start(options: RequestOptions = {}): Promise<WithRequestId<ExportJob>> {
    return this.call("POST", "/api/me/export", undefined, options);
  }

  /**
   * `GET /api/me/export/{id}`: where the job stands, with a fresh signed
   * `download_url` once it is ready. Another person's export is the same
   * 404 as none.
   */
  get(exportId: string, options: RequestOptions = {}): Promise<WithRequestId<ExportJobStatus>> {
    return this.call("GET", exportPath(exportId), undefined, options);
  }

  /**
   * The export's bytes, from `get`'s `download_url` (or the URL itself).
   * The link is signed and dies with the export's `expires_at`: `get`
   * mints a fresh one.
   */
  download(
    job: Pick<ExportJobStatus, "download_url"> | string,
    options: RequestOptions = {},
  ): Promise<ArrayBuffer> {
    const url = typeof job === "string" ? job : job.download_url;
    const match = /^\/api\/me\/export\/([^/?#]+)\/download(\?[^#]*)?$/.exec(url ?? "");
    if (!match) throw new MatterWaveConfigError(`not an export download URL: ${url}`);
    const path = exportPath(decodeURIComponent(match[1]!), `/download${match[2] ?? ""}`);
    return this.client.bytes(
      { method: "GET", path, body: undefined, keyed: true, stream: false, headers: { Accept: "*/*" } },
      options,
    );
  }
}

/**
 * Importing a ChatGPT or Claude export: start one from the file, then poll
 * the same row the Settings -> Data pane reads. One import runs at a time
 * per account (409 while one does), and the import creates conversations,
 * so an org over its plan's cap is refused until there is room.
 */
export class Imports extends Resource {
  /**
   * `POST /api/me/imports` (202): take the file (at most 100 MiB), check
   * it is an export this reads, and queue the work. The answer is the row:
   * what was found (`source`, `conversations_total`) and that it is
   * pending. Nothing is written to the caller's conversations here.
   */
  start(params: UploadImportParams, options: RequestOptions = {}): Promise<WithRequestId<ImportJob>> {
    if (!params.filename) throw new MatterWaveConfigError("filename must be non-empty");
    const blob = params.file instanceof Blob ? params.file : new Blob([params.file as BlobPart]);
    const form = new FormData();
    form.append("file", blob, params.filename);
    return this.call("POST", "/api/me/imports", form, options);
  }

  /** `GET /api/me/imports`: the caller's recent imports, newest first. */
  list(options: RequestOptions = {}): Promise<WithRequestId<ImportJobList>> {
    return this.call("GET", "/api/me/imports", undefined, options);
  }

  /** `GET /api/me/imports/{id}`: where the import stands. Another person's import is the same 404 as none. */
  get(importId: string, options: RequestOptions = {}): Promise<WithRequestId<ImportJob>> {
    return this.call("GET", `/api/me/imports/${segment("importId", importId)}`, undefined, options);
  }
}

// --- members / invites / join -------------------------------------------------

const ORG_ROLES: readonly OrgRole[] = ["owner", "admin", "member", "viewer"];
const LINK_MAX_USES = 500;
const LINK_MAX_DAYS = 30;

function checkRole(role: string, what: string): void {
  if (!ORG_ROLES.includes(role as OrgRole)) {
    throw new MatterWaveConfigError(`${what} must be one of ${ORG_ROLES.join(", ")}, got ${role}`);
  }
}

function memberPath(subject: string, suffix = ""): string {
  return `/api/org/members/${segment("subject", subject)}${suffix}`;
}

/**
 * Org membership: the members and their roles, the mailed invites, the
 * invite links, and the join that redeems either. Every org route here is
 * gated on the caller's membership row, never on a token claim: any member
 * lists members and invites and may leave (remove themselves); owner and
 * admin change roles, remove others, invite, resend, revoke and manage
 * links; only an owner touches an owner or grants ownership. These routes
 * refuse an API key outright -- team management is a person's act from a
 * signed-in session -- and an invite that would pass the plan's seat cap
 * is refused with the same 402 every other entitlement gate answers.
 */
export class Members extends Resource {
  /** `GET /api/org/members`: every member with their role, the caller's own role beside them, and the seats. */
  list(options: RequestOptions = {}): Promise<WithRequestId<MemberList>> {
    return this.call("GET", "/api/org/members", undefined, options);
  }

  /** `PUT /api/org/members/{subject}/role`: change a member's role. Only an owner grants ownership or touches an owner; the last owner cannot be demoted (409). Owner or admin. */
  setRole(subject: string, params: SetRoleParams, options: RequestOptions = {}): Promise<WithRequestId<OrgMember>> {
    checkRole(params.role, "role");
    return this.call("PUT", memberPath(subject, "/role"), params, options);
  }

  /**
   * `POST /api/org/members/{subject}/transfer-ownership`: hand the org to
   * another member in one step -- they become an owner and the caller an
   * admin, together or not at all. The target must be able to act and must
   * not own the org already. Owner only.
   */
  transferOwnership(subject: string, options: RequestOptions = {}): Promise<WithRequestId<OrgMember>> {
    return this.call("POST", memberPath(subject, "/transfer-ownership"), undefined, options);
  }

  /**
   * `DELETE /api/org/members/{subject}`: remove a member. Removing
   * yourself is leaving and needs nobody's permission (unless you are the
   * last owner); removing anyone else is owner or admin.
   */
  remove(subject: string, options: RequestOptions = {}): Promise<void> {
    return this.none("DELETE", memberPath(subject), options);
  }

  /** `GET /api/org/invites`: the mailed invites and where each stands. Any member may read them. */
  listInvites(options: RequestOptions = {}): Promise<WithRequestId<InviteList>> {
    return this.call("GET", "/api/org/invites", undefined, options);
  }

  /** `POST /api/org/invites` (201): invite an address at a role, and mail it. A relay failure does not undo the row -- `mail: "failed"` says so, and a resend is the recovery. Owner or admin. */
  createInvite(params: CreateInviteParams, options: RequestOptions = {}): Promise<WithRequestId<CreatedInvite>> {
    if (!params.email?.includes("@")) throw new MatterWaveConfigError("email must be an email address");
    if (params.role !== undefined) checkRole(params.role, "role");
    return this.call("POST", "/api/org/invites", { role: "member", ...present(params) }, options);
  }

  /**
   * `POST /api/org/invites/{id}/resend`: a new token, a new expiry and the
   * mail again -- the recovery for a mail that never arrived. Three an
   * hour per invite, so a refused resend leaves the last link working.
   * Owner or admin.
   */
  resendInvite(inviteId: string, options: RequestOptions = {}): Promise<WithRequestId<CreatedInvite>> {
    return this.call(
      "POST",
      `/api/org/invites/${segment("inviteId", inviteId)}/resend`,
      undefined,
      options,
    );
  }

  /** `DELETE /api/org/invites/{id}`: revoke an invite for good. Owner or admin. */
  revokeInvite(inviteId: string, options: RequestOptions = {}): Promise<void> {
    return this.none("DELETE", `/api/org/invites/${segment("inviteId", inviteId)}`, options);
  }

  /**
   * `POST /api/org/invites/lookup`: what a /join page asks before it
   * renders -- whose org, which address, which role, and whether the
   * invite still works. Anonymous: the token is the credential, sent in
   * the body so it stays out of access logs.
   */
  lookupInvite(token: string, options: RequestOptions = {}): Promise<WithRequestId<InvitePreview>> {
    if (!token) throw new MatterWaveConfigError("token must be non-empty");
    return this.callAnon("POST", "/api/org/invites/lookup", { token }, options);
  }

  /**
   * `POST /api/org/invites/accept`: redeem a mailed invite as the signed-in
   * account whose address was invited. An account in another org cannot be
   * moved (409 says so); a stranger joins through signup instead.
   */
  acceptInvite(token: string, options: RequestOptions = {}): Promise<WithRequestId<OrgMember>> {
    if (!token) throw new MatterWaveConfigError("token must be non-empty");
    return this.call("POST", "/api/org/invites/accept", { token }, options);
  }

  /** `GET /api/org/invite-links`: the links not revoked, with their uses. Owner or admin -- a link admits whoever holds it, so what is out and at what role is theirs to know. */
  listInviteLinks(options: RequestOptions = {}): Promise<WithRequestId<InviteLinkList>> {
    return this.call("GET", "/api/org/invite-links", undefined, options);
  }

  /**
   * `POST /api/org/invite-links` (201): make a link and get its `token`
   * and `url` -- once; only the hash is kept, so a lost link is revoked
   * and replaced, never shown again. Never an owner link. Owner or admin.
   */
  createInviteLink(
    params: CreateInviteLinkParams = {},
    options: RequestOptions = {},
  ): Promise<WithRequestId<CreatedInviteLink>> {
    const role = params.role ?? "member";
    checkRole(role, "role");
    if (role === "owner") throw new MatterWaveConfigError("An invite link is never an owner link.");
    const maxUses = params.max_uses ?? 10;
    const days = params.expires_in_days ?? 7;
    if (!(maxUses >= 1 && maxUses <= LINK_MAX_USES)) {
      throw new MatterWaveConfigError(`max_uses must be 1 to ${LINK_MAX_USES}, got ${maxUses}`);
    }
    if (!(days >= 1 && days <= LINK_MAX_DAYS)) {
      throw new MatterWaveConfigError(`expires_in_days must be 1 to ${LINK_MAX_DAYS}, got ${days}`);
    }
    return this.call("POST", "/api/org/invite-links", { role, max_uses: maxUses, expires_in_days: days }, options);
  }

  /** `DELETE /api/org/invite-links/{id}`: revoke a link; the joins it already made stand. Owner or admin. */
  revokeInviteLink(linkId: string, options: RequestOptions = {}): Promise<void> {
    return this.none("DELETE", `/api/org/invite-links/${segment("linkId", linkId)}`, options);
  }

  /** `POST /api/join/lookup`: what a /join page asks before it renders a link: whose org, which role, whether it still works. Anonymous -- the token is the credential. */
  lookupJoinLink(token: string, options: RequestOptions = {}): Promise<WithRequestId<JoinPreview>> {
    if (!token) throw new MatterWaveConfigError("token must be non-empty");
    return this.callAnon("POST", "/api/join/lookup", { token }, options);
  }

  /**
   * `POST /api/join`: join through a link as the signed-in account, which
   * must already be in the link's org without a membership in it (one
   * account, one org). A link that is revoked is the same 404 as none; one
   * that is expired or used up is a 410.
   */
  join(token: string, options: RequestOptions = {}): Promise<WithRequestId<OrgMember>> {
    if (!token) throw new MatterWaveConfigError("token must be non-empty");
    return this.call("POST", "/api/join", { token }, options);
  }
}

// --- org management ------------------------------------------------------------

function domainPath(domain: string, suffix = ""): string {
  return `/api/org/domains/${segment("domain", domain)}${suffix}`;
}

/**
 * The org itself and its admin self-service: the name, the closure, the
 * model allow-list, the sharing switch and every share link, and the SSO
 * configuration -- the identity provider, the email domains and their
 * DNS proof, and the enforcement switch with its break-glass code.
 *
 * **Admin scoping.** These routes gate on the caller's membership row,
 * never a token claim, and they refuse an API key outright: a signed-in
 * session of an org owner or admin is what answers them. Reading the org
 * and its model policy is admin; sharing and SSO/domains/IdP are admin;
 * `close`, enabling SSO enforcement and minting a recovery code are owner
 * only (disabling enforcement is open to any admin, because the person
 * undoing a lock-out should not need the person who caused it). The audit
 * trail beside these lives on `client.audit` (`list`, `exportCsv`).
 */
export class Org extends Resource {
  /** `GET /api/org`: the org and the caller's role in it. Any member may read it. */
  get(options: RequestOptions = {}): Promise<WithRequestId<OrgProfile>> {
    return this.call("GET", "/api/org", undefined, options);
  }

  /** `PATCH /api/org`: give the org a real name. Owner or admin. */
  rename(params: RenameOrgParams, options: RequestOptions = {}): Promise<WithRequestId<OrgProfile>> {
    if (!params.name?.trim()) throw new MatterWaveConfigError("name must not be blank");
    return this.call("PATCH", "/api/org", params, options);
  }

  /**
   * `POST /api/org/close`: close the workspace for everyone in it.
   * Danger: from the commit every request from the org is a 410, its
   * conversations are soft-deleted and purged after `retention_days`, its
   * keys, invites and links stop, and the subscription ends. `confirm` is
   * the org's name, exactly (case-insensitive). Idempotent: a repeat keeps
   * the first closure and re-runs the side effects, which is how a Stripe
   * or IdP failure is retried. Owner only.
   */
  close(params: CloseOrgParams, options: RequestOptions = {}): Promise<WithRequestId<OrgClosed>> {
    if (!params.confirm?.trim()) {
      throw new MatterWaveConfigError("Type the organisation's name exactly to confirm.");
    }
    return this.call("POST", "/api/org/close", params, options);
  }

  /** `GET /api/org/models`: the plan's models with the org's switch on each. Owner or admin; members learn the outcome from the picker (`/api/models`). */
  models(options: RequestOptions = {}): Promise<WithRequestId<ModelPolicy>> {
    return this.call("GET", "/api/org/models", undefined, options);
  }

  /**
   * `PUT /api/org/models`: set the allow-list. An id the plan does not
   * permit or the gateway does not serve is the server's 422 naming it;
   * `null` lifts the restriction and the house model is added back
   * whatever is sent. Owner or admin.
   */
  setModels(params: SetModelPolicyParams, options: RequestOptions = {}): Promise<WithRequestId<ModelPolicy>> {
    if (params.allowed !== null && !Array.isArray(params.allowed)) {
      throw new MatterWaveConfigError("allowed must be a list of model ids or null");
    }
    return this.call("PUT", "/api/org/models", params, options);
  }

  /** `GET /api/org/sharing`: whether members may share conversations by link. Owner or admin. */
  sharing(options: RequestOptions = {}): Promise<WithRequestId<SharingPolicy>> {
    return this.call("GET", "/api/org/sharing", undefined, options);
  }

  /** `PUT /api/org/sharing`: switch sharing on or off for the org. Switching off stops every existing link answering at once, without revoking them. Owner or admin, and audited. */
  setSharing(params: SharingPolicy, options: RequestOptions = {}): Promise<WithRequestId<SharingPolicy>> {
    if (typeof params.enabled !== "boolean") throw new MatterWaveConfigError("enabled must be a boolean");
    return this.call("PUT", "/api/org/sharing", params, options);
  }

  /** `GET /api/org/shares`: every link the org's members made, newest first, with who made each. Never the tokens. Owner or admin. */
  shares(options: RequestOptions = {}): Promise<WithRequestId<OrgShareList>> {
    return this.call("GET", "/api/org/shares", undefined, options);
  }

  /** `DELETE /api/org/shares/{id}`: revoke any link in the org. Another org's link and one that does not exist are the same 404. Owner or admin. */
  revokeShare(shareId: string, options: RequestOptions = {}): Promise<WithRequestId<OrgShareRevoked>> {
    return this.call("DELETE", `/api/org/shares/${segment("shareId", shareId)}`, undefined, options);
  }

  /** `GET /api/org/sso`: the policy, plus what would stop it being turned on. Owner or admin. */
  sso(options: RequestOptions = {}): Promise<WithRequestId<SsoSettings>> {
    return this.call("GET", "/api/org/sso", undefined, options);
  }

  /**
   * `PUT /api/org/sso`: enforce, or stop enforcing, SSO. Enabling is owner
   * only and runs the preflight first: with a blocker the answer is 409
   * naming it. Enforced, the response carries a minted break-glass
   * `recovery` code -- there is no way to reach the enforced state without
   * having been handed the way back out of it, and it is shown once.
   */
  setSso(params: SetSsoParams, options: RequestOptions = {}): Promise<WithRequestId<SsoEnforced | SsoRelaxed>> {
    if (typeof params.sso_required !== "boolean") {
      throw new MatterWaveConfigError("sso_required must be a boolean");
    }
    return this.call("PUT", "/api/org/sso", params, options);
  }

  /** `POST /api/org/sso/recovery-code` (201): a fresh break-glass code, superseding any unused one. Owner only, and audited. */
  mintRecoveryCode(options: RequestOptions = {}): Promise<WithRequestId<RecoveryCodeMinted>> {
    return this.call("POST", "/api/org/sso/recovery-code", undefined, options);
  }

  /** `GET /api/org/domains`: the claimed domains and whether each is proven. Owner or admin. */
  domains(options: RequestOptions = {}): Promise<WithRequestId<DomainList>> {
    return this.call("GET", "/api/org/domains", undefined, options);
  }

  /** `POST /api/org/domains` (201): claim a domain, unverified. A claim another org holds is a 409 with no hint of whose. Owner or admin. */
  claimDomain(params: ClaimDomainParams, options: RequestOptions = {}): Promise<WithRequestId<OrgDomainRow>> {
    if (!params.domain?.trim()) throw new MatterWaveConfigError("domain must be a domain like example.com");
    return this.call("POST", "/api/org/domains", params, options);
  }

  /** `GET /api/org/domains/{domain}/challenge`: the DNS TXT record to publish. Minted on first ask and stable thereafter. */
  domainChallenge(domain: string, options: RequestOptions = {}): Promise<WithRequestId<DomainChallengeAnswer>> {
    return this.call("GET", domainPath(domain, "/challenge"), undefined, options);
  }

  /**
   * `POST /api/org/domains/{domain}/verify`: prove the claim by looking
   * for the TXT record. 200 proven; 202 the record is not there yet (the
   * claim stands, `detail` says what was wrong); 503 the check could not
   * be run at all. This is a security boundary, not a form field: the
   * claim decides whose address gets an SSO button.
   */
  verifyDomain(domain: string, options: RequestOptions = {}): Promise<WithRequestId<DomainVerification>> {
    return this.call("POST", domainPath(domain, "/verify"), undefined, options);
  }

  /** `DELETE /api/org/domains/{domain}`: release the claim. Owner or admin. */
  releaseDomain(domain: string, options: RequestOptions = {}): Promise<void> {
    return this.none("DELETE", domainPath(domain), options);
  }

  /** `GET /api/org/idp`: the attached identity providers, never their secrets. Owner or admin. */
  idps(options: RequestOptions = {}): Promise<WithRequestId<IdpList>> {
    return this.call("GET", "/api/org/idp", undefined, options);
  }

  /** `POST /api/org/idp` (201): attach an OIDC provider by issuer, client id and secret. A 422 names the issuer when the IdP refused the configuration. Owner or admin. */
  attachIdp(params: AttachIdpParams, options: RequestOptions = {}): Promise<WithRequestId<OrgIdpRow>> {
    if (params.kind !== "oidc") throw new MatterWaveConfigError(`kind must be "oidc", got ${params.kind}`);
    if (!params.name?.trim()) throw new MatterWaveConfigError("name must not be blank");
    if (!params.issuer?.startsWith("https://")) throw new MatterWaveConfigError("issuer must be an https:// URL");
    if (!params.client_id?.trim()) throw new MatterWaveConfigError("client_id must not be blank");
    if (!params.client_secret) throw new MatterWaveConfigError("client_secret must be non-empty");
    const body: Record<string, unknown> = {
      kind: params.kind,
      name: params.name,
      issuer: params.issuer,
      client_id: params.client_id,
      client_secret: params.client_secret,
    };
    if (params.scopes !== undefined) body.scopes = params.scopes;
    return this.call("POST", "/api/org/idp", body, options);
  }

  /** `DELETE /api/org/idp/{provider}`: detach a provider. Postgres first, so nobody is sent to a provider that is about to disappear. Owner or admin. */
  detachIdp(provider: string, options: RequestOptions = {}): Promise<void> {
    return this.none("DELETE", `/api/org/idp/${segment("provider", provider)}`, options);
  }
}

// --- plans and billing --------------------------------------------------------

/**
 * Plans and billing: the public catalog, the move to Free, the billing
 * trail, and the Stripe checkout, portal, status and invoices.
 *
 * **Admin scoping.** `plans()` is the pricing page's data and no key is
 * needed; `status()` is deliberately readable by any member (a non-admin
 * is told to ask an admin rather than shown a 403). The rest -- switching
 * the plan, the history, checkout, the portal, the invoices -- is owner or
 * admin by membership row: these routes refuse an API key outright, so a
 * signed-in session answers them. No money moves through the SDK: a paid
 * plan is granted by a confirmed Stripe subscription, and `switchPlan` is
 * the move to Free (a paid code answers 402 pointing at checkout).
 */
export class Billing extends Resource {
  /** `GET /api/plans`: the public catalog, cheapest first, with the price list and the house model. No key needed. */
  plans(options: RequestOptions = {}): Promise<WithRequestId<PlanCatalog>> {
    return this.callAnon("GET", "/api/plans", undefined, options);
  }

  /** `PUT /api/plan`: move the org to Free. A paid code is the server's 402 pointing at checkout; the move never deletes anything -- past the Free cap the org is read-only and `writes_blocked` says so. Owner or admin. */
  switchPlan(params: SwitchPlanParams, options: RequestOptions = {}): Promise<WithRequestId<Entitlements>> {
    if (!params.plan?.trim()) throw new MatterWaveConfigError("plan must be a plan code");
    return this.call("PUT", "/api/plan", present(params), options);
  }

  /** `GET /api/plan/history`: the append-only billing trail, newest first. Owner or admin. */
  planHistory(options: RequestOptions = {}): Promise<WithRequestId<PlanHistory>> {
    return this.call("GET", "/api/plan/history", undefined, options);
  }

  /** `POST /api/billing/checkout`: begin a subscription; the answer is the Stripe Checkout URL to redirect to. Owner or admin. */
  checkout(params: CheckoutParams, options: RequestOptions = {}): Promise<WithRequestId<BillingUrl>> {
    if (!params.plan?.trim()) throw new MatterWaveConfigError("plan must be a plan code");
    return this.call("POST", "/api/billing/checkout", { annual: false, ...present(params) }, options);
  }

  /** `POST /api/billing/portal`: a Stripe customer portal session -- card update, plan change, cancel. The URL, to redirect to. Owner or admin. */
  portal(options: RequestOptions = {}): Promise<WithRequestId<BillingUrl>> {
    return this.call("POST", "/api/billing/portal", undefined, options);
  }

  /** `GET /api/billing/status`: the entitlements, whether billing is on, how the org pays, and the open late-payment episode. Any member. */
  status(options: RequestOptions = {}): Promise<WithRequestId<BillingStatus>> {
    return this.call("GET", "/api/billing/status", undefined, options);
  }

  /** `GET /api/billing/invoices`: the org's invoices, newest first, with Stripe's hosted page and PDF links. Owner or admin. */
  invoices(options: RequestOptions = {}): Promise<WithRequestId<InvoiceList>> {
    return this.call("GET", "/api/billing/invoices", undefined, options);
  }
}

// --- entitlements --------------------------------------------------------------

/** What the caller's org is allowed to do: the plan, its limits with the conventions applied, and what a downgrade blocks. Any member may read it. */
export class EntitlementsClient extends Resource {
  /**
   * `GET /api/entitlements`: `writes_blocked` and `read_only_reason` are
   * what an org over its plan's conversation cap shows its members, and
   * `limits` already applies the null-means-unlimited convention, so no
   * caller reads `plan.limits` by hand.
   */
  get(options: RequestOptions = {}): Promise<WithRequestId<Entitlements>> {
    return this.call("GET", "/api/entitlements", undefined, options);
  }
}
