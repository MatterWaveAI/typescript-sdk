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
