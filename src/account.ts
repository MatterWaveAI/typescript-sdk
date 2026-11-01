/**
 * The account and data clients: `account` (the caller's name, terms,
 * enforcement state, password, email, sessions, preferences, onboarding and
 * deletion), `preferences`, `sessions`, `exports`, `imports`, `speech`,
 * `billing`, `plans` and `policy`, one method per route on top of the
 * client's request and retry loop.
 *
 *     await client.preferences.update({ product_updates: true });
 *     const document = await client.exports.createAndDownload();
 *
 * Most routes here take an API key, acting as its owner, or a person's
 * token: exports need a key with `chat:read`, imports one with `chat:write`.
 * `plans.list` and `policy.stats` are public and send no credential. The
 * exceptions need a person's token (or the web app's signed-in session) and
 * refuse every API key: billing's administration (`checkout`, `portal`,
 * `invoices`, `changePlan`, `planHistory`), and the account's password,
 * email and deletion routes.
 */

import type {
  AccountExport,
  BillingStatus,
  CreateImportParams,
  Enforcement,
  ImportJob,
  ImportJobList,
  PlanCatalog,
  PolicyStats,
  Preferences,
  RevokedSession,
  RevokedSessions,
  SessionList,
  TermsAcceptance,
  TranscribeParams,
  Transcription,
  UpdateAccountParams,
  UpdatePreferencesParams,
  UpdatedName,
  WaitOptions,
} from "./account-types.js";
import type {
  AccountDeleted,
  DeleteAccountParams,
  EmailChangeCancelled,
  EmailChangeState,
  EmailChanged,
  EmailCodeSent,
  Entitlements,
  OnboardingComplete,
  PasswordChangeParams,
  PasswordChanged,
  StartEmailChangeParams,
  VerifyEmailChangeParams,
} from "./native-types.js";
import type { BillingLink, ChangePlanParams, CheckoutParams, InvoiceList, PlanHistory } from "./org-types.js";
import { MatterWaveConfigError, pause } from "./client.js";
import type { RequestOptions } from "./client.js";
import { segment } from "./conversations.js";
import { APITimeoutError, MatterWaveError } from "./errors.js";
import { Resource } from "./native.js";
import type { WithRequestId } from "./types.js";

// How often `wait` asks after a job, and for how long, unless told otherwise.
const POLL_INTERVAL_MS = 5_000;
const EXPORT_TIMEOUT_MS = 600_000;
const IMPORT_TIMEOUT_MS = 1_800_000;
const EXPORT_DONE: readonly string[] = ["ready", "failed", "expired"];
const IMPORT_DONE: readonly string[] = ["done", "failed"];
const IMPORT_LIMIT_BYTES = 100 * 1024 * 1024;
const SPEECH_LIMIT_BYTES = 10 * 1024 * 1024;
const LANGUAGE_MAX_LENGTH = 35;
const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_MAX_LENGTH = 256;
const DELETE_ACCOUNT_PHRASE = "delete my account";
// The audio types the route takes, by the extension a clip usually carries.
const AUDIO_TYPES: Record<string, string> = {
  ".webm": "audio/webm",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".mp4": "audio/mp4",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".mpeg": "audio/mpeg",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".aac": "audio/aac",
};
// The media types the route names when it refuses one (415).
const ACCEPTED_AUDIO_TYPES: readonly string[] = [
  "audio/webm",
  "audio/ogg",
  "audio/mp4",
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/flac",
  "audio/x-m4a",
  "audio/m4a",
  "audio/aac",
  "video/webm",
  "video/mp4",
];

/**
 * The whole object to PUT: the current settings with the changes laid over
 * them. A key left out keeps its value; `locale: null` clears it.
 */
function mergedPreferences(current: Preferences, changes: UpdatePreferencesParams): Preferences {
  return {
    locale: changes.locale === undefined ? current.locale : changes.locale,
    email: {
      product_updates: changes.product_updates ?? current.email.product_updates,
      usage_alerts: changes.usage_alerts ?? current.email.usage_alerts,
      // Receipts cannot be turned off; the route refuses false.
      billing_receipts: true,
    },
    notifications: {
      budget_warn: changes.budget_warn ?? current.notifications.budget_warn,
    },
  };
}

/**
 * Read the job until `finished` says it is, pausing between reads.
 * `APITimeoutError` when the next pause would run past `timeoutMs`.
 */
async function poll<T>(
  read: () => Promise<T>,
  finished: (job: T) => boolean,
  what: string,
  params: WaitOptions,
  defaultTimeoutMs: number,
): Promise<T> {
  const timeoutMs = params.timeoutMs ?? defaultTimeoutMs;
  const intervalMs = params.pollIntervalMs ?? POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await read();
    if (finished(job)) return job;
    if (Date.now() + intervalMs > deadline) throw new APITimeoutError(`${what} did not finish within ${timeoutMs}ms.`);
    await pause(intervalMs);
  }
}

/** The upload as a Blob of the type named, which a retry can send again. */
function filePart(file: Blob | ArrayBuffer | Uint8Array, type: string): Blob {
  return new Blob([file as BlobPart], { type });
}

function checkNewPassword(newPassword: string): void {
  if (newPassword.length < PASSWORD_MIN_LENGTH) {
    throw new MatterWaveConfigError(
      `Use at least ${PASSWORD_MIN_LENGTH} characters: length is what makes a password hard to guess, not symbols.`,
    );
  }
  if (newPassword.length > PASSWORD_MAX_LENGTH) {
    throw new MatterWaveConfigError(`new_password must be at most ${PASSWORD_MAX_LENGTH} characters`);
  }
}

// --- the account ---------------------------------------------------------------

/**
 * The caller's own account: their name, the terms they accepted, whether
 * moderation holds them, and beyond that the password, the email address,
 * onboarding and deletion. Every route here is about the caller and nobody
 * else -- the subject in the principal is the only key any of them use.
 * The sessions are `client.sessions`, the preferences `client.preferences`.
 *
 * The password, email and deletion routes need a person's token (or the
 * web app's signed-in session), never an API key: a key acts for its owner,
 * and its owner's password is not the key's to change, so those routes
 * answer a key with 403. The rest work with either.
 */
export class Account extends Resource {
  /**
   * `PATCH /api/me`: the display name, 1 to 120 characters once its
   * whitespace is collapsed; written to the identity provider first.
   */
  update(params: UpdateAccountParams, options: RequestOptions = {}): Promise<WithRequestId<UpdatedName>> {
    if (!params.full_name?.trim()) throw new MatterWaveConfigError("full_name must be non-empty");
    return this.call("PATCH", "/api/me", { full_name: params.full_name }, options);
  }

  /**
   * `POST /api/me/accept-terms`: accept the terms `version` names. Only the
   * current version is accepted -- a version other than the current one is
   * the server's 422, which says the current one -- and the answer says
   * which was recorded.
   */
  acceptTerms(version: string, options: RequestOptions = {}): Promise<WithRequestId<TermsAcceptance>> {
    if (!version?.trim()) throw new MatterWaveConfigError("version must be the terms version the person accepted");
    return this.call("POST", "/api/me/accept-terms", { version }, options);
  }

  /**
   * `GET /api/me/enforcement`: `state` `none`, or the warning, rate limit or
   * suspension that holds the caller or their org.
   */
  enforcement(options: RequestOptions = {}): Promise<WithRequestId<Enforcement>> {
    return this.call("GET", "/api/me/enforcement", undefined, options);
  }

  /** `POST /api/me/onboarding/complete`: record that the first-run walkthrough was finished or skipped. Idempotent; a second call keeps the first timestamp. */
  completeOnboarding(options: RequestOptions = {}): Promise<WithRequestId<OnboardingComplete>> {
    return this.call("POST", "/api/me/onboarding/complete", undefined, options);
  }

  /**
   * `POST /api/me/password`: change the password. A person's token or a
   * signed-in session; an API key gets 403. On success every other session
   * ends -- a changed password is most often a response to a device the
   * person no longer trusts -- and the answer counts them.
   */
  changePassword(params: PasswordChangeParams, options: RequestOptions = {}): Promise<WithRequestId<PasswordChanged>> {
    if (!params.current_password) throw new MatterWaveConfigError("current_password must be non-empty");
    checkNewPassword(params.new_password);
    return this.call("POST", "/api/me/password", params, options);
  }

  /** `GET /api/me/email`: the sign-in address and any change still waiting for its code, so a client can come back to the code step after a reload. A person's token or a signed-in session. */
  emailChangeState(options: RequestOptions = {}): Promise<WithRequestId<EmailChangeState>> {
    return this.call("GET", "/api/me/email", undefined, options);
  }

  /**
   * `POST /api/me/email`: mail a code to the new address. Nothing about
   * the login changes here -- the old address keeps signing in until the
   * code comes back. A person's token or a signed-in session. SSO-managed
   * accounts are refused with a 409 (the organisation's directory owns the
   * address).
   */
  startEmailChange(params: StartEmailChangeParams, options: RequestOptions = {}): Promise<WithRequestId<EmailCodeSent>> {
    if (!params.new_email?.includes("@")) throw new MatterWaveConfigError("new_email must be an email address");
    if (!params.current_password) throw new MatterWaveConfigError("current_password must be non-empty");
    return this.call("POST", "/api/me/email", params, options);
  }

  /**
   * `POST /api/me/email/verify`: the code back; the address moves, every
   * other session ends, and the old address is told. A person's token or a
   * signed-in session.
   */
  verifyEmailChange(params: VerifyEmailChangeParams, options: RequestOptions = {}): Promise<WithRequestId<EmailChanged>> {
    if (!params.code?.trim()) throw new MatterWaveConfigError("code must be non-empty");
    return this.call("POST", "/api/me/email/verify", params, options);
  }

  /** `POST /api/me/email/resend`: a fresh code for the pending address; 409 when nothing is pending. A person's token or a signed-in session. */
  resendEmailChange(options: RequestOptions = {}): Promise<WithRequestId<EmailCodeSent>> {
    return this.call("POST", "/api/me/email/resend", undefined, options);
  }

  /** `POST /api/me/email/cancel`: abandon a change that was started and not finished. Harmless when nothing is pending. A person's token or a signed-in session. */
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
   * and again by the server. A person's token or a signed-in session.
   */
  delete(params: DeleteAccountParams, options: RequestOptions = {}): Promise<WithRequestId<AccountDeleted>> {
    if (params.confirm?.trim().toLowerCase() !== DELETE_ACCOUNT_PHRASE) {
      throw new MatterWaveConfigError(`Confirmation phrase must be "${DELETE_ACCOUNT_PHRASE}".`);
    }
    return this.call("DELETE", "/api/me", params, options);
  }
}

/** `/api/me/preferences`: the mail the caller gets, their notices and their locale. */
export class PreferencesClient extends Resource {
  get(options: RequestOptions = {}): Promise<WithRequestId<Preferences>> {
    return this.call("GET", "/api/me/preferences", undefined, options);
  }

  /**
   * Change what was given and keep the rest. The route replaces the whole
   * object, so this reads it first and sends it back with the changes;
   * `locale: null` clears the locale (a BCP-47 tag otherwise). Billing
   * receipts cannot be turned off.
   */
  async update(params: UpdatePreferencesParams, options: RequestOptions = {}): Promise<WithRequestId<Preferences>> {
    const current = await this.get(options);
    return this.call("PUT", "/api/me/preferences", mergedPreferences(current, params), options);
  }
}

/** `/api/me/sessions`: the browsers signed in as the caller. A session's `id` is a secret. */
export class Sessions extends Resource {
  list(options: RequestOptions = {}): Promise<WithRequestId<SessionList>> {
    return this.call("GET", "/api/me/sessions", undefined, options);
  }

  /** Sign one browser out. `NotFoundError` for an id that is not one of the caller's. */
  revoke(sessionId: string, options: RequestOptions = {}): Promise<WithRequestId<RevokedSession>> {
    return this.call("DELETE", `/api/me/sessions/${segment("sessionId", sessionId)}`, undefined, options);
  }

  /**
   * Sign out every browser but the calling one; called with a key or a
   * token, which no browser session is, that is every browser.
   */
  revokeOthers(options: RequestOptions = {}): Promise<WithRequestId<RevokedSessions>> {
    return this.call("POST", "/api/me/sessions/revoke-others", undefined, options);
  }
}

// --- exports and imports -------------------------------------------------------

function exportPath(exportId: string, suffix = ""): string {
  return `/api/me/export/${segment("exportId", exportId)}${suffix}`;
}

/**
 * `/api/me/export`: everything the account holds, as one JSON document.
 * `create` begins a job -- three an hour, one at a time, 409 while one is
 * building -- and `wait` follows it; `download` fetches a
 * ready one, downloadable for a week; `createAndDownload` is the three in
 * one. `document` builds it inside the request instead.
 */
export class Exports extends Resource {
  /**
   * `GET /api/me/export`: the whole export, built while the request waits.
   * A large account is better served by `createAndDownload`.
   */
  document(options: RequestOptions = {}): Promise<WithRequestId<Record<string, unknown>>> {
    return this.call("GET", "/api/me/export", undefined, options);
  }

  /**
   * `POST /api/me/export`: start an export; the answer is `pending`.
   * `ConflictError` while another is being built.
   */
  create(options: RequestOptions = {}): Promise<WithRequestId<AccountExport>> {
    return this.call("POST", "/api/me/export", undefined, options);
  }

  /**
   * `GET /api/me/export/{id}`: the export's state, with a fresh signed
   * `download_url` once it is ready (null before that). Another person's
   * export is the same 404 as none.
   */
  get(exportId: string, options: RequestOptions = {}): Promise<WithRequestId<AccountExport>> {
    return this.call("GET", exportPath(exportId), undefined, options);
  }

  /**
   * Ask after the export until it is ready, and return it. `MatterWaveError`
   * when it failed or expired, `APITimeoutError` when `timeoutMs` passes
   * first.
   */
  async wait(
    exportId: string,
    params: WaitOptions = {},
    options: RequestOptions = {},
  ): Promise<WithRequestId<AccountExport>> {
    const done = await poll(
      () => this.get(exportId, options),
      (exported) => EXPORT_DONE.includes(exported.status),
      `The export ${exportId}`,
      params,
      EXPORT_TIMEOUT_MS,
    );
    if (done.status !== "ready") throw new MatterWaveError(`The export ${done.id} is ${done.status}; request a new one.`);
    return done;
  }

  /**
   * A ready export's JSON document, as bytes, from its `download_url` (or
   * the URL itself). The link is signed for the owner and dies with the
   * export's `expires_at` (`get` mints a fresh one), so it is fetched with
   * the client's credential: it takes both.
   */
  download(
    exported: AccountExport | Pick<AccountExport, "download_url"> | string,
    options: RequestOptions = {},
  ): Promise<ArrayBuffer> {
    const url = typeof exported === "string" ? exported : exported.download_url;
    if (!url) throw new MatterWaveConfigError("the export carries no download_url; wait() until it is ready");
    const match = /^\/api\/me\/export\/([^/?#]+)\/download(\?[^#]*)?$/.exec(url);
    if (!match) throw new MatterWaveConfigError(`not an export download URL: ${url}`);
    const path = exportPath(decodeURIComponent(match[1]!), `/download${match[2] ?? ""}`);
    return this.client.bytes(
      { method: "GET", path, body: undefined, keyed: true, stream: false, headers: { Accept: "*/*" } },
      options,
    );
  }

  /** Start an export, wait until it is ready, and return its document. */
  async createAndDownload(params: WaitOptions = {}, options: RequestOptions = {}): Promise<ArrayBuffer> {
    const started = await this.create(options);
    return this.download(await this.wait(started.id, params, options), options);
  }
}

/**
 * `/api/me/imports`: bring conversations over from another assistant's data
 * export -- ChatGPT's `conversations.json` (or its whole zip) or Claude's
 * JSON file, up to 100 MiB. A job runs one at a time (409 while one does),
 * ten an hour, and importing the same file again creates nothing new. The
 * import creates conversations, so an org over its plan's cap is refused
 * until there is room.
 */
export class Imports extends Resource {
  /** Upload the export as multipart and start the job; the answer is `pending`. */
  create(params: CreateImportParams, options: RequestOptions = {}): Promise<WithRequestId<ImportJob>> {
    if (!params.filename) throw new MatterWaveConfigError("filename must be non-empty");
    const kind = params.filename.toLowerCase().endsWith(".zip") ? "application/zip" : "application/json";
    const file = filePart(params.file, kind);
    if (file.size > IMPORT_LIMIT_BYTES) throw new MatterWaveConfigError("an import is 100 MiB at most");
    const form = new FormData();
    form.append("file", file, params.filename);
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

  /**
   * Ask after the job until it is `done`, and return it. `MatterWaveError`
   * with the job's `error` when it failed, `APITimeoutError` when
   * `timeoutMs` passes first.
   */
  async wait(importId: string, params: WaitOptions = {}, options: RequestOptions = {}): Promise<WithRequestId<ImportJob>> {
    const job = await poll(
      () => this.get(importId, options),
      (read) => IMPORT_DONE.includes(read.status),
      `The import ${importId}`,
      params,
      IMPORT_TIMEOUT_MS,
    );
    if (job.status === "failed") throw new MatterWaveError(`The import ${job.id} failed: ${job.error || "no reason given"}`);
    return job;
  }
}

// --- speech --------------------------------------------------------------------

/**
 * `POST /api/speech/transcribe`: dictation, one short clip in and its text
 * out, nothing kept -- the audio is held in memory for the length of the
 * request and nowhere else. Thirty clips a minute per person.
 * `NotFoundError` on a deployment with no transcriber configured.
 */
export class Speech extends Resource {
  /**
   * The words in an audio clip of up to 10 MiB (webm, ogg, mp4/m4a, mp3,
   * wav, flac or aac). `language` is a BCP-47 hint such as `en`. The route
   * refuses a part that does not say it is audio (415), so the clip is
   * sent under `content_type` when given, else a `Blob`'s own type, else
   * the type its file name's extension names. A type that is not audio at
   * all is refused here, before sending.
   */
  transcribe(params: TranscribeParams, options: RequestOptions = {}): Promise<WithRequestId<Transcription>> {
    const filename = params.filename || (params.file instanceof File ? params.file.name : "") || "clip";
    const dot = filename.lastIndexOf(".");
    const suffix = dot >= 0 ? filename.slice(dot).toLowerCase() : "";
    const own = params.file instanceof Blob ? params.file.type : "";
    const kind = params.content_type || own || AUDIO_TYPES[suffix] || "";
    const mediaType = kind.split(";")[0]!.trim().toLowerCase();
    if (!mediaType) throw new MatterWaveConfigError(`name the clip's content_type; ${filename} does not say it`);
    if (!ACCEPTED_AUDIO_TYPES.includes(mediaType) && !mediaType.startsWith("audio/")) {
      throw new MatterWaveConfigError(`Send an audio clip (${ACCEPTED_AUDIO_TYPES.join(", ")}), got ${mediaType}`);
    }
    if (params.language != null && (!params.language || params.language.length > LANGUAGE_MAX_LENGTH)) {
      throw new MatterWaveConfigError(`language must be a BCP-47 tag of at most ${LANGUAGE_MAX_LENGTH} characters`);
    }
    const clip = filePart(params.file, kind);
    if (clip.size === 0) throw new MatterWaveConfigError("the clip is empty");
    if (clip.size > SPEECH_LIMIT_BYTES) throw new MatterWaveConfigError("a clip is 10 MiB at most; send shorter pieces");
    const form = new FormData();
    form.append("file", clip, filename);
    if (params.language != null) form.append("language", params.language);
    return this.call("POST", "/api/speech/transcribe", form, options);
  }
}

// --- billing, plans and policy -------------------------------------------------

/**
 * The org's billing: the public catalog, the status any member reads (with
 * a key or a person's token), and the administration -- checkout, the
 * portal, invoices, plan changes and the plan history -- which is an
 * owner's or admin's by membership row and needs a person's token: an API
 * key is refused 403 "Membership is managed by a person, not an API key.".
 * No money moves through the SDK: a paid plan is granted by a confirmed
 * Stripe subscription, and a direct plan change is the move to Free (a paid
 * code answers 402 pointing at checkout).
 */
export class Billing extends Resource {
  /**
   * `GET /api/billing/status`: the plan and its limits, whether billing is
   * on, how the org pays, and the dunning schedule when a payment is late.
   * Any member: a non-admin is told to ask an admin rather than shown a 403.
   */
  status(options: RequestOptions = {}): Promise<WithRequestId<BillingStatus>> {
    return this.call("GET", "/api/billing/status", undefined, options);
  }

  /**
   * `POST /api/billing/checkout`: a Stripe Checkout page for `plan`, monthly
   * unless `annual`. The plan changes once Stripe confirms the payment.
   * `ConflictError` while an invoice is overdue.
   */
  checkout(plan: string, params: CheckoutParams = {}, options: RequestOptions = {}): Promise<WithRequestId<BillingLink>> {
    if (!plan?.trim()) throw new MatterWaveConfigError("plan must be a plan code, such as `pro`");
    return this.call("POST", "/api/billing/checkout", { plan, annual: params.annual ?? false }, options);
  }

  /** `POST /api/billing/portal`: the Stripe customer portal, where the card and invoices are managed. */
  portal(options: RequestOptions = {}): Promise<WithRequestId<BillingLink>> {
    return this.call("POST", "/api/billing/portal", undefined, options);
  }

  /** `GET /api/billing/invoices`: the latest 24, newest first, with Stripe's hosted page and PDF links. */
  invoices(options: RequestOptions = {}): Promise<WithRequestId<InvoiceList>> {
    return this.call("GET", "/api/billing/invoices", undefined, options);
  }

  /**
   * `PUT /api/plan`: move to `plan` directly -- in practice to `free`; a
   * paid plan starts with `checkout` and the server answers 402 saying so.
   * Nothing is deleted on a downgrade, but writes past the new limits stop
   * (`writes_blocked`).
   */
  changePlan(plan: string, params: ChangePlanParams = {}, options: RequestOptions = {}): Promise<WithRequestId<Entitlements>> {
    if (!plan) throw new MatterWaveConfigError("plan must be a plan code, such as `free`");
    const body: Record<string, unknown> = { plan };
    if (params.reason != null) body.reason = params.reason;
    return this.call("PUT", "/api/plan", body, options);
  }

  /** `GET /api/plan/history`: the latest 50 plan and status changes, newest first. */
  planHistory(options: RequestOptions = {}): Promise<WithRequestId<PlanHistory>> {
    return this.call("GET", "/api/plan/history", undefined, options);
  }
}

/** The public price list. */
export class Plans extends Resource {
  /** `GET /api/plans`: the public price list; no credential is sent. */
  list(options: RequestOptions = {}): Promise<WithRequestId<PlanCatalog>> {
    return this.client.json<PlanCatalog>(
      { method: "GET", path: "/api/plans", body: undefined, keyed: false, stream: false },
      options,
    );
  }
}

/** The public policy page's figures. */
export class Policy extends Resource {
  /**
   * `GET /api/policy/stats`: the public policy page's report and
   * enforcement counts; no credential is sent.
   */
  stats(options: RequestOptions = {}): Promise<WithRequestId<PolicyStats>> {
    return this.client.json<PolicyStats>(
      { method: "GET", path: "/api/policy/stats", body: undefined, keyed: false, stream: false },
      options,
    );
  }
}
