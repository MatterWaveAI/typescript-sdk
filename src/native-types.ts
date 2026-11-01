/**
 * The native API's wire types: keys, usage, webhooks, attachments, the
 * library and shares, spelled as the routes in api/matterwave send them.
 * Their bodies may grow; a field added later is ignored, not refused.
 */

import type { Dunning, ModelPrice } from "./account-types.js";
import type { OrgRole, RecoveryCode } from "./org-types.js";

// --- keys --------------------------------------------------------------------

/**
 * One API key as `GET /api/keys` lists it: never the secret. After a
 * rotation the old secret keeps working until `previous_valid_until`.
 */
export interface ApiKey {
  id: string;
  prefix: string;
  name: string;
  kind: string;
  scopes: string[];
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  rotated_at: string | null;
  previous_prefix: string | null;
  previous_valid_until: string | null;
  allowed_cidrs: string[] | null;
  rpm_limit: number | null;
}

/** The answer to `create` and `rotate`: the row, and `key`, the secret, this once. */
export interface ApiKeyWithSecret extends ApiKey {
  key: string;
}

export interface ApiKeyList {
  data: ApiKey[];
}

/** What a key is allowed to do and from where. */
export interface KeySettings {
  /** Omitted is the default (`chat:read`, `chat:write`); a list can only narrow. */
  scopes?: string[] | null;
  /** Days from now, 1 to 3650. Not with `expires_at`. */
  expires_in_days?: number | null;
  /** An absolute instant with a timezone offset. Not with `expires_in_days`. */
  expires_at?: string | null;
  /** Addresses or CIDR ranges the key may be presented from; omitted is anywhere. */
  allowed_cidrs?: string[] | null;
  /** Requests per minute, under the platform's ceiling. */
  rpm_limit?: number | null;
}

export interface CreateKeyParams extends KeySettings {
  name: string;
}

/**
 * A key's edit. A field left out is left alone; `null` clears it (the
 * default scopes, no expiry, any network, the platform's limit).
 */
export interface UpdateKeyParams extends KeySettings {
  name?: string;
}

// --- usage -------------------------------------------------------------------

export interface ModelUsage {
  model: string;
  label: string;
  multiplier: number;
  prompt_tokens: number;
  completion_tokens: number;
  tokens: number;
  weighted_tokens: number;
  cost_micros: number;
  overage_micros: number;
  requests: number;
  compaction_weighted_tokens: number;
  compaction_requests: number;
}

export interface DailyUsage {
  day: string;
  weighted_tokens: number;
  tokens: number;
  cost_micros: number;
  overage_micros: number;
  requests: number;
  compaction_weighted_tokens: number;
  compaction_requests: number;
}

/**
 * `GET /api/me/usage`: the org's balance this period. `used`, `included` and
 * `remaining` are weighted tokens; `warn`, `in_overage` and `exhausted`
 * never overlap. `seats` is null on a plan not sold per seat.
 */
export interface UsageBalance {
  unit: "tokens" | (string & {});
  used: number;
  included: number;
  remaining: number;
  percent: number;
  warn: boolean;
  in_overage: boolean;
  exhausted: boolean;
  period_start: string;
  resets_at: string;
  plan: { code: string; name: string };
  seats: { billed: number; included_tokens_per_seat: number } | null;
  overage: { enabled: boolean; spent_micros: number; cap_micros: number };
  models: ModelUsage[];
  compaction: { weighted_tokens: number; requests: number };
  history: DailyUsage[];
}

/** One member's month; `subject` is `unattributed` for usage no member owns. */
export interface MemberUsage {
  subject: string;
  email: string | null;
  name: string | null;
  weighted_tokens: number;
  cost_micros: number;
  turns: number;
  tokens: number;
  last_active: string | null;
}

/**
 * One connector connection's share of the month: what the turns it answered
 * cost, biggest first. `connector` and `display_name` are null once the
 * connection is deleted; its spend keeps its id.
 */
export interface ConnectionUsage {
  connection_id: string;
  connector: string | null;
  display_name: string | null;
  weighted_tokens: number;
  cost_micros: number;
  turns: number;
  tokens: number;
  last_active: string | null;
}

/**
 * `GET /api/org/usage`: one calendar month per member. `scope` is `org` for
 * an owner or admin (every member), `self` for anyone else (their own row);
 * `totals` are over the rows returned. `by_connection` is the part of those
 * rows that connector turns made, per connection, scoped the same way: every
 * connection for an owner or admin, the ones a member paid for otherwise;
 * absent from an API that predates connectors.
 */
export interface OrgUsage {
  period: string;
  period_start: string;
  period_end: string;
  unit: "tokens" | (string & {});
  scope: "org" | "self";
  data: MemberUsage[];
  by_connection?: ConnectionUsage[];
  totals: { weighted_tokens: number; cost_micros: number; turns: number; tokens: number };
}

export interface UsagePeriodParams {
  /** A calendar month like `2026-10`; this month when omitted. */
  period?: string;
}

// --- audit -------------------------------------------------------------------

/**
 * One row of the org's audit trail: who changed what, and when. `actor` is
 * the subject the writer had in hand (a system actor's looks like
 * `stripe:evt_...`); `actor_email` is filled in where that subject has a
 * users row, null otherwise.
 */
export interface AuditEvent {
  id: string;
  occurred_at: string;
  actor: string;
  actor_email: string | null;
  action: string;
  target: string | null;
  detail: Record<string, unknown>;
}

/**
 * `GET /api/org/audit`: one page of the trail, newest first. `next_cursor`
 * fetches the page after this one and is null on the last; `actions` lists
 * every action the trail holds, for a filter's options.
 */
export interface AuditPage {
  data: AuditEvent[];
  next_cursor: string | null;
  actions: string[];
}

/** What narrows the trail. `event` matches an action exactly or as a dotted prefix (`org.sso` finds `org.sso.enforced`); `actor` matches a subject or an email, case-insensitively. */
export interface AuditFilters {
  event?: string;
  actor?: string;
  /** ISO timestamp; a bare one is read as UTC. */
  since?: string;
  until?: string;
}

export interface AuditListParams extends AuditFilters {
  /** A previous page's `next_cursor`. */
  cursor?: string;
  /** Rows per page, 1 to 200; 50 when omitted. */
  limit?: number;
}

// --- budget ------------------------------------------------------------------

/**
 * `GET /api/budget`: the org's period as of now. `included_tokens` and
 * `tokens_used` are weighted tokens; the money fields are micro-dollars at
 * list price, `overage_cap_micros` the org's own cap or the plan's default.
 * The `member_*` fields are the caller's own cap and spend against it.
 */
export interface Budget {
  period_start: string;
  included_tokens: number;
  tokens_used: number;
  remaining_tokens: number;
  overage_enabled: boolean;
  overage_cap_micros: number;
  overage_micros: number;
  member_default_cap_micros: number | null;
  member_cap: number | null;
  member_spent: number | null;
  member_exhausted: boolean | null;
}

/**
 * One member's month: the cap in force (`own` says it is the member's row
 * rather than the org's default; null is unlimited) and the spend the usage
 * report shows beside them. `email`, `name`, `role` and `state` are filled
 * in only where the route answers rows for the whole org.
 */
export interface MemberBudget {
  subject: string;
  period_start: string;
  cap_micros: number | null;
  own: boolean;
  spent_micros: number;
  exhausted: boolean;
  email?: string | null;
  name?: string | null;
  role?: string | null;
  state?: string | null;
}

/** `GET /api/budget/members`, and the answer to `setMemberDefaultCap`: every member with the cap in force and the month's spend beside them. */
export interface MemberBudgetList {
  period_start: string;
  member_default_cap_micros: number | null;
  data: MemberBudget[];
}

/** The most overage a period may run up, in micro-dollars; 0 restores the plan's default (its monthly price). */
export interface SetOverageCapParams {
  overage_cap_micros: number;
}

/** The cap every member without one of their own is held to; `null` lifts it. */
export interface SetMemberDefaultCapParams {
  member_default_cap_micros: number | null;
}

/** One member's own cap, which beats the org's default up or down; `null` removes it so the default applies. */
export interface SetMemberCapParams {
  cap_micros: number | null;
}

// --- webhooks ----------------------------------------------------------------

export interface WebhookEndpoint {
  id: string;
  url: string;
  description: string;
  events: string[];
  enabled: boolean;
  failure_count: number;
  created_at: string;
  updated_at: string;
  disabled_at: string | null;
}

/**
 * The answer to `create` and `rotateSecret`: the row, the signing secret
 * this once, and `verification`, the receiver-side check by language with
 * the secret filled in.
 */
export interface WebhookEndpointWithSecret extends WebhookEndpoint {
  secret: string;
  shown_once: true;
  verification: Record<string, string>;
}

/** The endpoints, and `events`, every event type one may subscribe to. */
export interface WebhookEndpointList {
  data: WebhookEndpoint[];
  events: string[];
}

export interface CreateWebhookParams {
  url: string;
  events: string[];
  description?: string;
}

/** Every field optional; one left out (or null) is unchanged. */
export interface UpdateWebhookParams {
  url?: string;
  events?: string[];
  description?: string;
  enabled?: boolean;
}

export type DeliveryStatus = "pending" | "sending" | "delivered" | "failed";

export interface WebhookDelivery {
  id: string;
  endpoint_id: string;
  event: string;
  event_id: string;
  payload: Record<string, unknown>;
  attempt: number;
  status: DeliveryStatus;
  response_code: number | null;
  response_ms: number | null;
  response_excerpt: string | null;
  next_attempt_at: string | null;
  delivered_at: string | null;
  last_error: string | null;
  created_at: string;
}

export interface WebhookDeliveryList {
  data: WebhookDelivery[];
  status: DeliveryStatus | null;
}

// --- attachments -------------------------------------------------------------

/**
 * An uploaded file. `content_type` is what the server read from the bytes,
 * not what was sent. `download_url` is a signed path that expires in
 * minutes and works only with this client's key: pass it to
 * `attachments.download`.
 */
export interface Attachment {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  scan_status: string;
  created_at: string;
  message_id: string | null;
  extract_truncated: boolean;
  download_url: string;
}

export interface AttachmentLimits {
  max_upload_bytes: number;
  quota_bytes: number;
  quota_used_bytes: number;
  quota_remaining_bytes: number;
}

export interface UploadAttachmentParams {
  /** The file: a `Blob` (a `File` is one), or bytes. */
  file: Blob | ArrayBuffer | Uint8Array;
  filename: string;
  conversation_id?: string;
}

// --- library -----------------------------------------------------------------

export interface Folder {
  id: string;
  name: string;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface Tag {
  id: string;
  name: string;
  created_at: string;
}

/** Folders, tags, and `assignments`: conversation id to the ids of its tags. */
export interface Library {
  folders: Folder[];
  tags: Tag[];
  assignments: Record<string, string[]>;
}

export interface LibrarySearchParams {
  /** A previous page's `next_cursor`. */
  cursor?: string;
  /** Hits per page, 1 to 50; 20 when omitted. */
  limit?: number;
}

export interface UpdateFolderParams {
  name?: string;
  position?: number;
}

export interface ConversationTags {
  conversation_id: string;
  tag_ids: string[];
}

// --- shares ------------------------------------------------------------------

export interface Share {
  id: string;
  conversation_id: string;
  title: string;
  message_count: number;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  view_count: number;
  status: "active" | "expired" | "revoked";
}

export interface ShareList {
  data: Share[];
}

/** A new link. `token` is here and nowhere else; `path` is the web app's route, to prefix with its origin. */
export interface CreatedShare {
  share: Share;
  token: string;
  path: string;
}

export interface CreateShareParams {
  /** 60 seconds to a year; omitted or null lives until revoked. */
  expires_in_s?: number | null;
}

/** What anyone holding the link reads; `org_name` only where the org opted in. */
export interface SharedConversation {
  title: string;
  shared_at: string | null;
  messages: Record<string, unknown>[];
  org_name: string | null;
}

// --- notifications ------------------------------------------------------------

/**
 * One notification: a budget threshold crossed, a plan moved, a member
 * joined or left, an export ready. `link` is a path in the web app, to
 * prefix with its origin; `read_at` is null until it is read.
 */
export interface Notification {
  id: string;
  kind: string;
  title: string;
  body: string;
  link: string | null;
  created_at: string;
  read_at: string | null;
}

export interface NotificationListParams {
  /** Only the unread rows; the unread count is the same either way. */
  unread?: boolean;
  /** Rows per page, 1 to 100; 30 when omitted. */
  limit?: number;
}

/** `GET /api/me/notifications`: the caller's rows, newest first, and the count the bell shows. */
export interface NotificationList {
  data: Notification[];
  unread_count: number;
}

/** The answer to `read`: the row, with the caller's remaining unread count beside it. */
export interface ReadNotification extends Notification {
  unread_count: number;
}

/** The answer to `readAll`: how many rows it marked, and the count that is left, always 0. */
export interface ReadAllNotifications {
  read: number;
  unread_count: number;
}

// --- announcements ------------------------------------------------------------

export type AnnouncementSeverity = "info" | "warning" | "critical";

/** One announcement as the banner reads it: the message, its severity, an optional link and the window. Nothing about who wrote it. */
export interface Announcement {
  id: string;
  message: string;
  severity: AnnouncementSeverity | (string & {});
  link: string | null;
  starts_at: string;
  /** Null is open-ended. */
  ends_at: string | null;
  /** Never true for a critical one; the store refuses the row otherwise. */
  dismissible: boolean;
}

/** `GET /api/announcements`: the ones inside their window right now, most severe first. */
export interface AnnouncementList {
  data: Announcement[];
}

// --- admin announcements ------------------------------------------------------

/**
 * One announcement as the admin tab's table sees it (`GET
 * /api/admin/announcements`): every column -- who wrote it and who last
 * changed it -- plus `state`, where the window stands now: `active`,
 * `scheduled` or `ended`. These are the operator routes: they need the
 * platform `admin` role, and an API key with user scopes cannot call them.
 */
export interface AdminAnnouncement {
  id: string;
  message: string;
  severity: AnnouncementSeverity | (string & {});
  link: string | null;
  starts_at: string;
  /** Null is open-ended. */
  ends_at: string | null;
  /** Never true for a critical one; the store refuses the row otherwise. */
  dismissible: boolean;
  created_by: string;
  created_at: string;
  updated_by: string;
  updated_at: string;
  state: string;
}

/** `GET /api/admin/announcements`: every announcement, newest first. */
export interface AdminAnnouncementList {
  data: AdminAnnouncement[];
}

/** The body of `admin.announcements.create`. Omitted fields take the server's defaults. */
export interface CreateAnnouncementParams {
  /** Plain text, at most 500 characters once trimmed. */
  message: string;
  /** Defaults to `info`. */
  severity?: AnnouncementSeverity;
  /** An absolute http(s) URL or a path on this site; 2000 characters at most. */
  link?: string | null;
  /** ISO timestamp; the server's clock when omitted. */
  starts_at?: string | null;
  /** ISO timestamp; null (the default) is open-ended. Must be after `starts_at`. */
  ends_at?: string | null;
  /** Defaults to true; forced false for a critical one. */
  dismissible?: boolean;
}

/**
 * The body of `admin.announcements.update`: only the fields given change.
 * `link: null` clears the link and `ends_at: null` makes the window
 * open-ended for good; on the rest, null is not a value the server reads.
 */
export interface UpdateAnnouncementParams {
  message?: string;
  severity?: AnnouncementSeverity;
  link?: string | null;
  starts_at?: string;
  ends_at?: string | null;
  dismissible?: boolean;
  /** End it at the server's clock rather than a caller's `ends_at`. */
  end_now?: boolean;
}

// --- account self-service -------------------------------------------------------

/**
 * One live browser session, as `GET /api/me/sessions` lists it. `current`
 * flags the session that made the request; `current_id` on the list is null
 * for a session minted before sessions had rows (or an API caller with no
 * cookie), and then nothing is flagged.
 */
export interface SessionRow {
  id: string;
  current: boolean;
  created_at: string;
  last_seen_at: string;
  user_agent: string | null;
  ip: string | null;
}

/** The answer to `revokeSession`: which session went, and whether it was the caller's own. */
export interface SessionRevoked {
  status: string;
  current: boolean;
}

/** The answer to `revokeOtherSessions`: how many other sessions ended. */
export interface SessionsRevokedOthers {
  revoked: number;
}

/** The body of `account.changePassword`. A session only: an API key acts for its owner, and its owner's password is not the key's to change. */
export interface PasswordChangeParams {
  current_password: string;
  /** At least 12 characters -- the signup floor, checked here and again by the server. */
  new_password: string;
}

/** The answer to `changePassword`: every other session ended with it, the count beside the fact. */
export interface PasswordChanged {
  status: string;
  revoked: number;
}

/** The body of `account.rename`. Whitespace-collapsed; at most 100 characters once it is. */
export interface RenameParams {
  full_name: string;
}

/** The answer to `rename`: the name as the row now holds it. */
export interface Renamed {
  name: string;
}

/** The answer to `acceptTerms`: the version recorded, when, and that it is the one in force. */
export interface TermsAccepted {
  terms_version: string;
  terms_accepted_at: string | null;
  terms_current: boolean;
}

/** The body of `acceptTerms`. Only the current version is accepted; a stale constant is a 422. */
export interface AcceptTermsParams {
  version: string;
}

/** The answer to `completeOnboarding`: the flag and the timestamp it was first set, idempotently. */
export interface OnboardingComplete {
  onboarding_completed: true;
  completed_at: string;
}

/** `GET /api/me/email`: the sign-in address and any change still waiting for its code. */
export interface EmailChangeState {
  email: string | null;
  pending_email: string | null;
}

/** The body of `startEmailChange`. A session only; the new address is mailed a code. */
export interface StartEmailChangeParams {
  new_email: string;
  current_password: string;
}

/** The answer to `startEmailChange` and `resendEmailChange`: a code went to the new address (or did not -- `mail_sent` says which). */
export interface EmailCodeSent {
  status: string;
  new_email: string;
  mail_sent: boolean;
}

/** The body of `verifyEmailChange`. */
export interface VerifyEmailChangeParams {
  code: string;
}

/** The answer to `verifyEmailChange`: the address moved, every other session ended, and the old address was told. */
export interface EmailChanged {
  status: string;
  email: string;
  revoked: number;
  notice_sent: boolean;
}

/** The answer to `cancelEmailChange`: the pending change is gone and the old address stands. */
export interface EmailChangeCancelled {
  status: string;
  email: string;
}

/**
 * The answer to `deleteAccount`. Danger: this soft-deletes every
 * conversation the caller owns, revokes their API keys, drops their
 * instructions and asks the identity provider to deactivate the login,
 * and it cannot be undone from the API. `identity_removed: false` means
 * the data is gone but the login is not -- the client must say so rather
 * than smooth it over.
 */
export interface AccountDeleted {
  status: string;
  conversations_deleted: number;
  attachments_marked_deleted: number;
  api_keys_revoked: number;
  custom_instructions_deleted: number;
  retention_days: number;
  identity_removed: boolean;
  deletion_request_id: string | null;
}

/** The body of `deleteAccount`: the confirmation phrase, exactly (`"delete my account"`). */
export interface DeleteAccountParams {
  confirm: string;
}

// --- export + import jobs -------------------------------------------------------

/** Where an export job stands: `pending`, then `ready` (downloadable until `expires_at`), `failed`, or `expired` (the blob is gone; the row stays as the record). */
export type ExportJobStatusKind = "pending" | "ready" | "failed" | "expired";

/**
 * One account export job, as `POST /api/me/export` (202) answers and
 * `GET /api/me/export/{id}` returns it. Never the blob key.
 */
export interface ExportJob {
  id: string;
  status: ExportJobStatusKind | (string & {});
  size_bytes: number | null;
  created_at: string;
  completed_at: string | null;
  /** When the download stops working and the blob is swept. */
  expires_at: string | null;
}

/** `GET /api/me/export/{id}`: the job, plus a fresh signed `download_url` once it is ready (null before that). */
export interface ExportJobStatus extends ExportJob {
  download_url: string | null;
}

/** Where an import stands: `pending`, `running`, `done`, or `failed` (with `error` beside it). */
export type ImportJobStatusKind = "pending" | "running" | "done" | "failed";

/** The body of `imports.start`: one export file, up to 100 MiB. */
export interface UploadImportParams {
  /** The file: a `Blob` (a `File` is one), or bytes. */
  file: Blob | ArrayBuffer | Uint8Array;
  filename: string;
}

// --- members, invites, join -----------------------------------------------------

/**
 * One member, as `GET /api/org/members` lists them and the role, invite
 * and join writes answer. `state` is `active`, `suspended` or
 * `unverified`; `last_seen_at` is null for someone who has never signed
 * in, which is how an admin spots a paid seat nobody uses.
 */
export interface OrgMember {
  subject: string;
  email: string | null;
  name: string | null;
  role: OrgRole | (string & {});
  state: string;
  created_at: string;
  last_seen_at: string | null;
}

/** The seats against the plan: `max` null when there is no cap, `billed` the seats the org pays for on a per-seat plan (null on any other). */
export interface MemberSeats {
  used: number;
  max: number | null;
  billed: number | null;
}

/** The body of `members.setRole`. */
export interface SetRoleParams {
  role: OrgRole;
}

/** How an invite or a link stands: `pending` until accepted, expired, used up or revoked. */
export type InviteStatus = "pending" | "accepted" | "expired" | "revoked" | "used_up" | "active";

/**
 * One mailed invite, as `GET /api/org/invites` lists it. Never the token:
 * the hash is the row's, the plaintext went out in the mail.
 */
export interface OrgInvite {
  id: string;
  email: string;
  role: OrgRole | (string & {});
  invited_by: string;
  created_at: string;
  expires_at: string;
  status: InviteStatus | (string & {});
}

/** The answer to `create` and `resend`: the invite, whether its mail went, and the reason when it did not (the row exists either way; a resend is the recovery). */
export interface CreatedInvite extends OrgInvite {
  mail: "sent" | "failed";
  detail?: string;
}

/** What the anonymous `/join` page asks of a mailed invite: whose org, which address, which role, and whether the link still works. */
export interface InvitePreview {
  org_name: string;
  email: string;
  role: OrgRole | (string & {});
  expires_at: string;
  status: InviteStatus | (string & {});
}

/** What the anonymous `/join` page asks of a link: whose org, which role, whether it still works -- not how many have used it. */
export interface JoinPreview {
  org_name: string;
  role: OrgRole | (string & {});
  expires_at: string;
  status: InviteStatus | (string & {});
}

/**
 * One invite link, as `GET /api/org/invite-links` lists it. Never the
 * token: only its hash is kept, so the plaintext exists in the response
 * that made the link and wherever the owner pasted it.
 */
export interface InviteLinkRow {
  id: string;
  role: OrgRole | (string & {});
  max_uses: number;
  uses: number;
  created_by: string;
  created_at: string;
  expires_at: string;
  status: InviteStatus | (string & {});
}

/** The answer to `createInviteLink`: the row, and `token` and `url`, shown this once. */
export interface CreatedInviteLink extends InviteLinkRow {
  token: string;
  url: string;
}

// --- org management -------------------------------------------------------------

/** `GET /api/org`: the org and the caller's place in it. Any member may read it. */
export interface OrgProfile {
  id: string;
  name: string;
  created_at: string;
  role: OrgRole | (string & {});
}

/** The body of `org.rename`. */
export interface RenameOrgParams {
  name: string;
}

/**
 * The answer to `close`: the closure is recorded first (every later request
 * from the org is a 410) and the side effects follow, each reported. Danger:
 * this closes the workspace for everyone in it, soft-deletes its
 * conversations and cancels the subscription, and is idempotent only in
 * that a repeat re-runs the side effects. Owner only, by membership row.
 */
export interface OrgClosed {
  status: string;
  closed_at: string;
  already_closed: boolean;
  conversations_deleted: number;
  retention_days: number;
  api_keys_revoked: number | null;
  invites_revoked: number | null;
  invite_links_revoked: number | null;
  subscription: string;
  members_mailed: number;
  members_not_mailed: number;
  identity_removed: boolean;
}

/** The body of `org.setModels`: the ids members may use, or null for every model the plan permits. The house model is added back whatever is sent. */
export interface SetModelPolicyParams {
  allowed: string[] | null;
}

/** One share link as the org's view lists it: every link a member made, with who made it. Never the tokens. */
export interface OrgShareRow {
  id: string;
  conversation_id: string;
  title: string;
  message_count: number;
  include_attachments: boolean;
  created_by: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  view_count: number;
  status: "active" | "expired" | "revoked" | (string & {});
}

/** The answer to `org.revokeShare`. */
export interface OrgShareRevoked {
  status: string;
}

/** The answer to `setSso({ sso_required: true })`: enforced, with the way back in minted in the same breath -- the recovery code is shown exactly once. */
export interface SsoEnforced {
  sso_required: true;
  recovery: RecoveryCode;
}

/** The answer to `setSso({ sso_required: false })`: any admin may disable; only an owner may enable. */
export interface SsoRelaxed {
  sso_required: false;
}

/** The body of `org.setSso`. */
export interface SetSsoParams {
  sso_required: boolean;
}

/** The answer to `org.mintRecoveryCode`: a fresh break-glass code, superseding any unused one. Owner only. */
export interface RecoveryCodeMinted {
  recovery: RecoveryCode;
}

/** The DNS TXT record the org publishes to prove it owns a domain: on the host, under the claimed domain, with this value. */
export interface DnsChallenge {
  type: "TXT";
  host: string;
  /** The full record name: the host prefixed with the domain. */
  name: string;
  value: string;
}

/** `GET /api/org/domains/{domain}/challenge`: the record to publish. Minted on first ask and stable thereafter. */
export interface DomainChallengeAnswer {
  record: DnsChallenge;
}

/** One claimed domain: the claim, and whether it has been proven. */
export interface OrgDomainRow {
  domain: string;
  verified: boolean;
  verified_at: string | null;
  verified_by: string | null;
  created_at: string;
}

/** The body of `org.claimDomain`. */
export interface ClaimDomainParams {
  domain: string;
}

/**
 * One attached identity provider, as the org's routes describe it. Never
 * the client secret: it went to the IdP and is not stored here.
 */
export interface OrgIdpRow {
  /** The provider handle, for `detachIdp` and the login link. */
  provider: string;
  kind: "oidc" | (string & {});
  name: string;
  issuer: string | null;
  created_at: string;
}

/** `GET /api/org/idp`. */
export interface IdpList {
  data: OrgIdpRow[];
}

// --- plans and billing ----------------------------------------------------------

/** The body of `billing.switchPlan`: the plan's code and, optionally, why. No money moves here -- a paid plan is a 402 pointing at checkout. */
export interface SwitchPlanParams {
  plan: string;
  reason?: string;
}

/** One row of `GET /api/plan/history`: the append-only billing trail, newest first. */
export interface PlanEvent {
  from_plan: string | null;
  to_plan: string | null;
  from_status: string | null;
  to_status: string | null;
  kind: string;
  actor: string | null;
  reason: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

/** The answer to `checkout` and `portal`: the Stripe URL to redirect to. */
export interface BillingUrl {
  url: string;
}

/** How Stripe collects from the org: a card, or invoices on net terms. */
export interface Collection {
  collection_method: string;
  days_until_due: number | null;
}

/** The open late-payment episode on `BillingStatus.dunning`: the name `Dunning` has too. */
export type DunningState = Dunning;

/** One row of the price list beside the catalog: the name `ModelPrice` has too. */
export type PlanModelPrice = ModelPrice;

// --- passkeys -------------------------------------------------------------------

/** One registered passkey, as the Security pane lists it: what the person called it and when it was made. The credential itself lives at the identity provider. */
export interface Passkey {
  id: string;
  name: string;
  created_at: string;
}

/** `GET /api/me/passkeys`: the caller's passkeys, the relying-party id the browser ceremony needs, and the cap. */
export interface PasskeyList {
  passkeys: Passkey[];
  rp_id: string;
  max: number;
}

/** `POST /api/me/passkeys/start`: the creation options for `navigator.credentials.create`, and the id to verify the attestation under. */
export interface PasskeyRegistrationStart {
  passkey_id: string;
  options: Record<string, unknown>;
}

/** The body of `passkeys.verifyRegistration`: the browser's attestation, and the name the row keeps. */
export interface PasskeyRegistrationParams {
  credential: Record<string, unknown>;
  name: string;
}

/** The body of `passkeys.rename`. */
export interface PasskeyRenameParams {
  name: string;
}

/** `POST /api/auth/passkey/start`: the request options for `navigator.credentials.get`, with the provider's session sealed beside them as `challenge` -- opaque, hand it back. */
export interface PasskeyLoginStart {
  challenge: string;
  options: Record<string, unknown>;
}

/** The body of `passkeys.finishLogin`. */
export interface PasskeyLoginFinishParams {
  challenge: string;
  credential: Record<string, unknown>;
}

/** The answer to `finishLogin`: where to send the browser to finish the sign-in. */
export interface PasskeyLoginFinished {
  redirect: string;
}

// --- mfa ------------------------------------------------------------------------

/** `GET /api/me/mfa`: what the Security section shows. `org_requires_mfa` is why Remove is unavailable for a member of an org that insists. */
export interface MfaState {
  totp_enrolled: boolean;
  recovery_codes_left: number;
  org_requires_mfa: boolean;
}

/** `POST /api/me/mfa/totp/start`: the secret, the otpauth URI, and the QR as an SVG data URI. Nothing is live until the first code confirms it. */
export interface TotpEnrolment {
  secret: string;
  uri: string;
  qr_svg: string;
}

/** The body of `mfa.confirmTotp` and `mfa.reissueRecoveryCodes`: the current six digits. */
export interface TotpCodeParams {
  code: string;
}

/** The answer to `confirmTotp`: the ten recovery codes, shown this once. */
export interface TotpConfirmed {
  totp_enrolled: true;
  recovery_codes: string[];
  recovery_codes_left: number;
}

/** A code from the authenticator, or a recovery code -- one or the other, never both. The recovery code is burned whether or not what follows succeeds. */
export interface TotpProof {
  code?: string;
  recovery_code?: string;
}

/** The answer to `removeTotp`. */
export interface TotpRemoved {
  totp_enrolled: false;
  recovery_codes_left: number;
}

/** The answer to `reissueRecoveryCodes`: ten new codes, the old ones retired, shown this once. */
export interface RecoveryCodesReissued {
  recovery_codes: string[];
  recovery_codes_left: number;
}

/** The body of `mfa.verify`: the sealed challenge the password step handed out, and the code or recovery code that proves it. */
export interface MfaLoginParams {
  challenge: string;
  code?: string;
  recovery_code?: string;
}

/** The answer to `mfa.verify`: where to send the browser to finish the sign-in, and, on a recovery code, how many are left. */
export interface MfaVerified {
  redirect: string;
  recovery_codes_left?: number;
}

/** The body of `mfa.enrolConfirm`: the enrolment challenge and the first code. */
export interface MfaEnrolConfirmParams {
  challenge: string;
  code: string;
}

/** The answer to `enrolConfirm`: the recovery codes, and a fresh challenge that now owes the `totp` factor -- the sign-in finishes through `mfa.verify` with the NEXT code. */
export interface MfaEnrolConfirmed {
  recovery_codes: string[];
  challenge: string;
}

// --- account switching ------------------------------------------------------------

/**
 * One signed-in account as the browser holds it: `slot` 0 is the acting
 * one, 1 and up are parked. Answers only what the session envelopes
 * already told this browser -- never account data. Rides the session
 * cookies, so a non-browser caller passes theirs via `defaultHeaders`.
 */
export interface SignedInAccount {
  slot: number;
  current: boolean;
  subject: string;
  email: string | null;
  name: string | null;
  org_name: string | null;
}

/** `GET /api/accounts`: who is signed in on this browser, acting one first, and whether there is room for another. Anonymous on purpose. */
export interface AccountRoster {
  accounts: SignedInAccount[];
  max: number;
  room: boolean;
}

/** The body of `accounts.switch`: which parked slot to make the acting one. */
export interface AccountSwitchParams {
  slot: number;
}

/** The answer to `accounts.switch`. */
export interface AccountSwitched {
  status: string;
  subject: string;
  email: string | null;
}

/** The answer to `accounts.logout` and `accounts.logoutAll`. */
export interface AccountLoggedOut {
  status: string;
  /** Where the SPA sends the browser to end the provider session, under OIDC. */
  end_session_endpoint?: string;
}

// --- speech -----------------------------------------------------------------------

// --- edge pairing / sync ----------------------------------------------------------

/** `POST /api/sync/pairings` (201): a code the box redeems once for its key. Twelve Crockford characters with dashes, ten minutes to live. Admin only, by session. */
export interface PairingCode {
  code: string;
  name: string;
  expires_in: number;
  expires_at: string;
}

/** The body of `edge.mint`: what to call the box, which names its key (`Edge: <name>`). */
export interface MintPairingParams {
  name: string;
}

/** One paired box: its key row (never a secret) with the box's own name beside it. Revoked ones stay listed -- they are the record of an unpairing. */
export interface EdgeDevice extends ApiKey {
  box_name: string;
}

/** `GET /api/sync/devices`: the org's paired boxes. */
export interface EdgeDeviceList {
  data: EdgeDevice[];
}

/** The body of `edge.pair`. `device_id` keeps a box's identity across re-pairings; mint a uuid and keep it if you want the platform to tell the same box apart. */
export interface PairParams {
  code: string;
  device_id?: string;
}

/** The answer to `pair`: the box's key -- `conversations:import` and nothing else, shown this once -- beside its id, name and scopes. */
export interface PairingGranted {
  key: string;
  key_id: string;
  name: string;
  scopes: string[];
}

/** What the box's sync job last did, for the shell's one status line. `{"box": false}` on a platform pod, `{"paired": false}` for a box holding no pairing; the counts, times and stop reasons past that -- never content. */
export interface EdgeSyncStatus {
  box: boolean;
  paired: boolean;
  device_id?: string;
  platform_url?: string;
  name?: string | null;
  paired_at?: string | null;
  last_synced_at?: string | null;
  last_attempt_at?: string | null;
  offline?: boolean;
  pending?: number;
  pending_messages?: number | null;
  pending_capped?: boolean;
  stopped?: string | null;
  last_error?: string | null;
  skipped?: number;
  skipped_recent?: number;
  next_attempt_at?: string | null;
}

/** Where one pushed message came from; the platform fills the device in from the request's `device_id` when the message does not name one. */
export interface EdgeOrigin {
  device_id?: string | null;
  model?: string | null;
}

/** One message of a pushed conversation, the export's shape. */
export interface EdgeMessage {
  id: string;
  conversation_id: string;
  role: "user" | "assistant" | "system" | "tool" | (string & {});
  parts: Record<string, unknown>[];
  created_at: string;
  parent_id?: string | null;
  model?: string | null;
  truncated?: boolean;
  finish_reason?: string | null;
  origin?: EdgeOrigin;
}

/** The conversation half of a push: the row and its messages, upserted by id. */
export interface EdgeConversation {
  id: string;
  title?: string;
  created_at: string;
  updated_at: string;
  default_model?: string | null;
  system_prompt?: string | null;
  current_leaf_message_id?: string | null;
  messages?: EdgeMessage[];
}

/** The body of `edge.push`: one conversation per request, `format_version` 1 (the default, and the only version this platform reads). */
export interface EdgePushParams {
  format_version?: number;
  source?: string;
  device_id?: string;
  conversation: EdgeConversation;
}

/** The answer to `push`: what the platform did with each message. 200 even when some were rejected -- read `rejected` per id; the rest stands. */
export interface EdgePushOutcome {
  conversation_id: string;
  accepted: number;
  updated: number;
  already_present: number;
  rejected: Record<string, unknown>[];
}

// --- entitlements -------------------------------------------------------------

/**
 * The plan's limits with the conventions applied: null is unlimited, not
 * zero, and `included_tokens` already counts the seats on a plan sold per
 * seat.
 */
export interface EntitlementLimits {
  included_tokens: number;
  included_tokens_per_seat: number | null;
  overage_enabled: boolean;
  budget_duration: string;
  tpm_limit: number | null;
  rpm_limit: number | null;
  max_parallel_requests: number | null;
  /** Null is unlimited, not zero. */
  max_conversations: number | null;
  max_seats: number | null;
  /** Null means every model but the partner ones; a list is the allow-list. */
  allowed_models: string[] | null;
  features: Record<string, boolean>;
}

/**
 * `GET /api/entitlements`: what the caller's org is allowed to do. Past 0,
 * `over_capacity` says a downgrade left conversations behind -- read-only,
 * never deleted -- and `writes_blocked` with `read_only_reason` are what
 * the UI shows then. `dunning_stage` is the late-payment stage, `clear` in
 * good standing.
 */
export interface Entitlements {
  org_id: string;
  /** The plan's code; `plan_name` is its display name. */
  plan: string;
  plan_name: string;
  status: string;
  seats: number;
  /** True when the plan's price and allowance are per seat. */
  per_seat: boolean;
  /** The seats the price is multiplied by: `seats` on a per-seat plan, 1 otherwise. */
  billed_seats: number;
  price_cents_monthly: number;
  price_cents_annual: number;
  /** True when the org has no subscription row at all: on free by default, not a missing record. */
  implicit: boolean;
  billing_interval: string;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  /** When the org's free trial ends, while it is in one. */
  trial_end: string | null;
  default_overage_cap_micros: number;
  limits: EntitlementLimits;
  over_capacity: number;
  writes_blocked: boolean;
  read_only_reason: string | null;
  dunning_stage: string;
}
