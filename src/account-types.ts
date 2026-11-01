/**
 * The account and data routes' wire types: the caller's name, terms,
 * preferences and sessions, data exports and imports, speech, an
 * attachment's scan, the enforcement banner, the billing status, and the
 * public plan and policy figures, spelled as the routes in api/matterwave
 * send them. The platform documents these bodies as open objects, so the
 * fields here are the ones its routes write today; a field added later is
 * ignored, not refused.
 */

import type { Entitlements, ImportJobStatusKind } from "./native-types.js";

// --- the account -------------------------------------------------------------

/** The body of `account.update`. */
export interface UpdateAccountParams {
  /** The display name, 1 to 120 characters once its whitespace is collapsed. */
  full_name: string;
}

/** `PATCH /api/me`: the display name as saved, whitespace collapsed. */
export interface UpdatedName {
  name: string;
}

/** `POST /api/me/accept-terms`: the version the person accepted and when. */
export interface TermsAcceptance {
  terms_version: string;
  terms_accepted_at: string | null;
  terms_current: boolean;
}

/** The window a `rate_limited` caller is held to: `messages` per `window_s` seconds. */
export interface EnforcementLimit {
  messages: number;
  window_s: number;
}

/**
 * `GET /api/me/enforcement`: the banner's state. `state` is `none`, the
 * whole body for nearly everyone, or `warned`, `rate_limited` or
 * `suspended` with the reason, since when, until when (null for
 * open-ended), whether it holds the person (`user`) or the whole org, and
 * where to appeal; `limit` is the window a `rate_limited` caller is held to.
 */
export interface Enforcement {
  state: string;
  reason?: string | null;
  since?: string | null;
  expires_at?: string | null;
  scope?: string | null;
  appeal_path?: string | null;
  limit?: EnforcementLimit | null;
}

/** Which mail the person gets. `billing_receipts` is transactional mail and is always sent; the toggle only says so. */
export interface EmailPreferences {
  product_updates: boolean;
  usage_alerts: boolean;
  billing_receipts: true;
}

export interface NotificationPreferences {
  budget_warn: boolean;
}

/** `GET`/`PUT /api/me/preferences`. `locale` is a BCP-47 tag (`en`, `en-GB`), or null for the browser's. */
export interface Preferences {
  email: EmailPreferences;
  locale: string | null;
  notifications: NotificationPreferences;
}

/**
 * What `preferences.update` changes, flat (`product_updates`) or nested as
 * the route spells them (`email`, `notifications`): a key left out keeps
 * its value. `account.updatePreferences` sends the nested shape as given,
 * the whole of it, as `preferences()` returned it.
 */
export interface UpdatePreferencesParams {
  /** A BCP-47 tag (`en`, `en-GB`); `null` clears it, back to the browser's. */
  locale?: string | null;
  product_updates?: boolean;
  usage_alerts?: boolean;
  budget_warn?: boolean;
  email?: Partial<EmailPreferences>;
  notifications?: Partial<NotificationPreferences>;
}

/** One signed-in browser. */
export interface Session {
  /**
   * The session cookie's own value, the one field that would authenticate:
   * a secret, so keep it out of logs. `sessions.revoke` takes it.
   */
  id: string;
  current: boolean;
  created_at: string;
  last_seen_at: string;
  user_agent: string | null;
  ip: string | null;
}

/** `GET /api/me/sessions`: every browser signed in as the caller. */
export interface SessionList {
  /** The calling session's id (null for a key or a token): a secret, like each session's `id`. */
  current_id: string | null;
  sessions: Session[];
}

/** `DELETE /api/me/sessions/{id}`: `current` when it was the caller's own. */
export interface RevokedSession {
  status: string;
  current: boolean;
}

/** `POST /api/me/sessions/revoke-others`: how many were signed out. */
export interface RevokedSessions {
  revoked: number;
}

// --- exports and imports -------------------------------------------------------

/** One export of the account's data. `status` is `pending`, `ready`, `failed` or `expired`. */
export interface AccountExport {
  id: string;
  status: string;
  size_bytes: number | null;
  created_at: string;
  completed_at: string | null;
  expires_at: string | null;
  /**
   * Set only when the export is `ready`: a same-origin path signed for the
   * owner, minted fresh on each read, that `exports.download` fetches. A
   * secret, so keep it out of logs.
   */
  download_url?: string | null;
}

/** How long `wait` asks after a job, and how often. */
export interface WaitOptions {
  /** Give up after this long: 10 minutes for an export and 30 for an import when omitted. */
  timeoutMs?: number;
  /** The pause between reads; 5 seconds when omitted. */
  pollIntervalMs?: number;
}

/**
 * One import of another assistant's export. `status` is `pending`,
 * `running`, `done` or `failed` (`error` says why); `source` is `chatgpt`
 * or `claude`. Importing the same file again creates nothing new: its
 * conversations count as `conversations_existing`.
 */
export interface ImportJob {
  id: string;
  status: ImportJobStatusKind | (string & {});
  source: string;
  filename: string;
  size_bytes: number;
  conversations_total: number;
  conversations_done: number;
  conversations_created: number;
  conversations_existing: number;
  conversations_skipped: number;
  messages_created: number;
  attachments_skipped: number;
  branches_dropped: number;
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

/** `GET /api/me/imports`: the latest ten, newest first. */
export interface ImportJobList {
  data: ImportJob[];
}

/** The body of `imports.create`. */
export interface CreateImportParams {
  /**
   * ChatGPT's `conversations.json` or its whole zip, or Claude's JSON
   * export, up to 100 MiB: a `Blob` (a `File` is one), or bytes. The server
   * tells them apart by their contents.
   */
  file: Blob | ArrayBuffer | Uint8Array;
  /** A name ending in `.zip` is sent as a zip, any other as JSON. */
  filename: string;
}

// --- speech and attachments ----------------------------------------------------

/** `POST /api/speech/transcribe`: the clip's words. The audio is never stored. */
export interface Transcription {
  text: string;
}

/** The body of `speech.transcribe`. */
export interface TranscribeParams {
  /** The clip, up to 10 MiB: a `Blob` (a `File` is one), or bytes. */
  file: Blob | ArrayBuffer | Uint8Array;
  /** The clip's file name; a `File`'s own name, else `clip`, when omitted. */
  filename?: string;
  /** A BCP-47 hint such as `en`; at most 35 characters. */
  language?: string;
  /**
   * The clip's audio type. Without it, a `Blob`'s own type is sent, and
   * failing that the type the file name's extension names: webm, ogg,
   * mp4/m4a, mp3, wav, flac and aac.
   */
  content_type?: string;
  /** `content_type` under its other spelling. */
  contentType?: string;
}

/**
 * `GET /api/attachments/{id}/scan`: `uploaded`, `scanning`, `clean`,
 * `infected` or `scan_failed`. Only a `clean` file can be read.
 */
export interface AttachmentScan {
  id: string;
  scan_status: string;
}

// --- billing, plans and policy -------------------------------------------------

export interface DunningSchedule {
  warn_at: string;
  warn_final_at: string;
  limited_at: string;
  suspended_at: string | null;
  days_limit_at: string;
}

export interface DunningStep {
  stage: string;
  at: string;
}

export interface DunningLimits {
  stops_overage: boolean;
  blocks_new_keys: boolean;
  blocks_upgrades: boolean;
}

/**
 * A late payment and what happens next: the stage, how overdue and how
 * much, the dates of each step, and the link to pay (`pay_url`).
 */
export interface Dunning {
  stage: string;
  source: string;
  first_overdue_at: string;
  days_overdue: number;
  outstanding_micros: number;
  schedule: DunningSchedule | null;
  next_step: DunningStep | null;
  overage_stopped: boolean;
  limited: DunningLimits | null;
  auto_suspend: boolean;
  pay_url: string | null;
}

/**
 * `GET /api/billing/status`: what a billing page renders, in one read any
 * member may make -- the org's entitlements (every field of
 * `entitlements.get`), whether billing is on at all, how the org pays, and
 * `dunning` when a payment is late (null in good standing).
 */
export interface BillingStatus extends Entitlements {
  billing_enabled: boolean;
  /** `charge_automatically` (a card) or `send_invoice` (invoices on net terms). */
  collection_method: string;
  /** The net terms an invoice is due in, in days; null where there are none. */
  days_until_due: number | null;
  dunning: Dunning | null;
}

/**
 * One plan on the price list. Prices are in cents; `limits` is the plan's
 * raw limits object (the keys `Entitlements.limits` reads).
 */
export interface Plan {
  code: string;
  name: string;
  price_cents_monthly: number;
  price_cents_annual: number;
  included_tokens: number;
  included_tokens_per_seat: number | null;
  per_seat: boolean;
  overage_enabled: boolean;
  default_overage_cap_micros: number;
  trial_days: number;
  models: string[];
  limits: Record<string, unknown>;
}

/**
 * A model's list price per million tokens, and the multiplier its use is
 * counted at against a plan's allowance.
 */
export interface ModelPrice {
  id: string;
  label: string;
  multiplier: number;
  input_usd_per_m: number;
  output_usd_per_m: number;
  partner: boolean;
}

/**
 * `GET /api/plans`: every plan, cheapest first, the model prices, and the
 * deployment's default model. Public: no credential is sent.
 */
export interface PlanCatalog {
  data: Plan[];
  models: ModelPrice[];
  default_model: string;
}

/**
 * `GET /api/policy/stats`: the public policy page's counts. `reports` holds
 * `by_kind` and `unsafe_by_status`; `enforcement` holds `by_state`,
 * `active` and `appeals`; each is a map of name to count.
 */
export interface PolicyStats {
  reports: Record<string, Record<string, number>>;
  enforcement: Record<string, Record<string, number>>;
}
