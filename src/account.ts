/**
 * The account and data clients: `account` (the caller's name, terms and
 * enforcement state), `preferences`, `sessions`, `exports`, `imports`,
 * `speech`, `billing`, `plans` and `policy`, one method per route on top of
 * the client's request and retry loop.
 *
 *     await client.preferences.update({ product_updates: true });
 *     const document = await client.exports.createAndDownload();
 *
 * Every route here takes an API key, acting as its owner, or a person's
 * token: exports need a key with `chat:read`, imports one with `chat:write`.
 * `plans.list` and `policy.stats` are public and send no credential.
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
    notifications: { budget_warn: changes.budget_warn ?? current.notifications.budget_warn },
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

// --- the account ---------------------------------------------------------------

/** The caller's own account: their name, the terms they accepted, and whether moderation holds them. */
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
   * `POST /api/me/accept-terms`: accept the terms `version` names; a version
   * other than the current one is the server's 422, which says the current one.
   */
  acceptTerms(version: string, options: RequestOptions = {}): Promise<WithRequestId<TermsAcceptance>> {
    if (!version) throw new MatterWaveConfigError("version must be the terms version the person accepted");
    return this.call("POST", "/api/me/accept-terms", { version }, options);
  }

  /**
   * `GET /api/me/enforcement`: `state` `none`, or the warning, rate limit or
   * suspension that holds the caller or their org.
   */
  enforcement(options: RequestOptions = {}): Promise<WithRequestId<Enforcement>> {
    return this.call("GET", "/api/me/enforcement", undefined, options);
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
 * `create` starts a job (three an hour, one at a time) and `wait` follows
 * it; `download` fetches a ready one; `createAndDownload` is the three in
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

  /** The export's state, with a fresh `download_url` once it is ready. */
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
   * the URL itself). The signature is bound to the owner, so the link is
   * fetched with the client's credential: it takes both.
   */
  download(exported: AccountExport | string, options: RequestOptions = {}): Promise<ArrayBuffer> {
    const url = typeof exported === "string" ? exported : exported.download_url;
    if (!url) throw new MatterWaveConfigError("the export carries no download_url; wait() until it is ready");
    const match = /^\/api\/me\/export\/([^/?#]+)\/download(\?[^#]*)?$/.exec(url);
    if (!match) throw new MatterWaveConfigError(`not an export download URL: ${url}`);
    const path = exportPath(decodeURIComponent(match[1]!), `/download${match[2] ?? ""}`);
    return this.client.bytes({ method: "GET", path, body: undefined, keyed: true, stream: false }, options);
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
 * JSON file, up to 100 MiB. A job runs one at a time, ten an hour, and
 * importing the same file again creates nothing new.
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

  list(options: RequestOptions = {}): Promise<WithRequestId<ImportJobList>> {
    return this.call("GET", "/api/me/imports", undefined, options);
  }

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
 * `POST /api/speech/transcribe`: dictation. `NotFoundError` on a deployment
 * with no transcriber configured.
 */
export class Speech extends Resource {
  /**
   * The words in an audio clip of up to 10 MiB (webm, ogg, mp4/m4a, mp3,
   * wav, flac or aac; `content_type` names it when the file name does not).
   * `language` is a BCP-47 hint such as `en`. The route refuses a part that
   * does not say it is audio (415), so the type is named from the extension
   * when the caller does not give one, and from a `Blob`'s own type when
   * the extension does not say.
   */
  transcribe(params: TranscribeParams, options: RequestOptions = {}): Promise<WithRequestId<Transcription>> {
    const dot = params.filename.lastIndexOf(".");
    const suffix = dot >= 0 ? params.filename.slice(dot).toLowerCase() : "";
    const own = params.file instanceof Blob ? params.file.type : "";
    const kind = params.content_type || AUDIO_TYPES[suffix] || own;
    const clip = filePart(params.file, kind);
    if (clip.size === 0) throw new MatterWaveConfigError("the clip is empty");
    if (clip.size > SPEECH_LIMIT_BYTES) throw new MatterWaveConfigError("a clip is 10 MiB at most; send shorter pieces");
    if (!kind) throw new MatterWaveConfigError(`name the clip's content_type; ${params.filename} does not say it`);
    const form = new FormData();
    form.append("file", clip, params.filename);
    if (params.language != null) form.append("language", params.language);
    return this.call("POST", "/api/speech/transcribe", form, options);
  }
}

// --- billing, plans and policy -------------------------------------------------

/** The org's billing as any member sees it. */
export class Billing extends Resource {
  /**
   * `GET /api/billing/status`: the plan and its limits, whether billing is
   * on, how the org pays, and the dunning schedule when a payment is late.
   */
  status(options: RequestOptions = {}): Promise<WithRequestId<BillingStatus>> {
    return this.call("GET", "/api/billing/status", undefined, options);
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
