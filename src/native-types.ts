/**
 * The native API's wire types: keys, usage, webhooks, attachments, the
 * library and shares, spelled as the routes in api/matterwave send them.
 * Their bodies may grow; a field added later is ignored, not refused.
 */

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
 * `GET /api/org/usage`: one calendar month per member. `scope` is `org` for
 * an owner or admin (every member), `self` for anyone else (their own row);
 * `totals` are over the rows returned.
 */
export interface OrgUsage {
  period: string;
  period_start: string;
  period_end: string;
  unit: "tokens" | (string & {});
  scope: "org" | "self";
  data: MemberUsage[];
  totals: { weighted_tokens: number; cost_micros: number; turns: number; tokens: number };
}

export interface UsagePeriodParams {
  /** A calendar month like `2026-10`; this month when omitted. */
  period?: string;
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
