# Changelog

All notable changes to `@matterwave/sdk` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `frequency_penalty` and `presence_penalty` on `chat.completions.create`,
  relayed to the model as OpenAI defines them (-2 to 2), and in
  `CHAT_COMPLETION_REQUEST_FIELDS`.
- `CompactingFrame` (exported) and `"compacting"` in `CONVERSATION_EVENTS`:
  the conversation stream's event sent first on a turn that folds earlier
  messages before it is answered, so a client can restart its wait for the
  first token. Not terminal; `compaction` or `notice` follows.
- `stream.finalMessage()` and `ChatCompletionAccumulator`: a stream's text
  and its tool calls, each reassembled from its `delta.tool_calls`
  fragments, as an `AssistantMessage`; the accumulator also keeps
  `finishReason`, `usage` and `model`.
- `toolMessage(callId, content)`: the `role: "tool"` message answering a
  call, for the next request's `messages`.
- `AppModel.supports_tools` (`GET /api/models`) and `Me.local_agent_tools`
  (`GET /api/me`): whether a model can call tools and whether the org lets
  clients run local agent tools. Absent or null when the server does not
  send them.
- The agent tool contract the coding clients share, version `1.0.0`
  (`CONTRACT_VERSION`), generated from the Python SDK's `contract.json`
  into `src/agent/contract.ts`: the seven local tools (`read_file`,
  `list_dir`, `glob`, `grep`, `edit`, `write_file`, `run_shell`) with
  their JSON Schemas, which are read-only, the approval modes `plan`, `ask`
  (the default), `auto-edit` and `yolo` with what each allows and asks for,
  the default deny list (`.env*`, `*.pem`, `id_*`, `.git/`, plus
  `.matterwaveignore`), the refusal and edit-error sentences, the limits,
  the shell per platform, and the versioned agent-mode system prompt. Typed
  constants and the pure helpers `allowed(tool, mode)`, `toolsForMode`
  (`plan` gets the read tools only), `systemPrompt`, `DenyList`,
  `applyEdit` and `unifiedDiff` are the `agent` namespace of the main
  entry; the new `@matterwave/sdk/agent` entry (Node only) adds `confine`,
  `loadDenyList` and `resolveLinks`.
- Agent contract `1.1.0`, regenerated from the Python SDK, all additions
  (every 1.0.0 name and default behaviour is unchanged):
  - The search rules: `IgnoreFile` and `SearchIgnore` (browser-safe; nested
    `.gitignore` and `.matterwaveignore` files, `!`, directory-only and
    anchored patterns, `**`, escapes, case ignored, the deny list on top),
    and in `@matterwave/sdk/agent` the walker `walk(root, path)` and
    `loadSearchIgnore(root)`.
  - The read tools' output as the contract spells it (`OUTPUTS`,
    `TOOL_ERRORS`, `ToolError`): `runReadFile`, `runListDir`, `runGlob` and
    `runGrep` in `@matterwave/sdk/agent`, and the browser-safe
    `formatReadFile`, `formatListDir`, `formatGlob`, `formatGrep` and
    `formatShell` for a client that reads files or runs commands itself.
    The contract carries their conformance cases (`CONTRACT.conformance`).
  - Tool kinds beyond the seven: `network`, `mcp` and `meta`
    (`TOOL_KINDS`, `KIND_DECISIONS`, `READ_ONLY_DECISIONS`, `ExtraTool`).
    `allowed(tool, mode, kind, { readOnly, path })` decides a client's own
    tool by its kind, and `toolsForMode(mode, extra)` offers them.
  - `refusal(code, values)` and `APPROVAL_REFUSALS`: the wording for a tool
    the mode denies, an unknown tool, a call the user rejected, a call a
    headless run cannot ask about, and a protected file without approval.
  - `systemPrompt(mode, root, { extraTools, contextFiles })`
    (`ContextFile`): a "More tools" section and a fenced "Project
    instructions" section for trusted context files; without them the
    prompt is unchanged.
  - `PROTECTED` adds `.matterwave/`, `MATTERWAVE.md`, `MATTERWAVE.local.md`
    and `AGENTS.md` (`SETTINGS_DIR`, `CONTEXT_FILES`); a write to any of them
    asks in every mode that allows writes (`allowed(..., { path })`,
    `isProtected`), and `confine(..., { write: true, approved: true })` lets
    an approved one through. `PROTECTED_LIST` and `EDIT_CRLF_FALLBACK` are
    exported from the agent index.
  - New limits: `read_max_file_bytes`, `grep_max_file_bytes` and
    `binary_sniff_bytes`.
  - `confine` refuses, on every platform, a name Windows would read as
    another file or a device: alternate data streams and drive-relative
    names (`stream`), a name ending in a dot or a space (`trailing`), CON,
    PRN, AUX, NUL, COM1-9, LPT1-9, CONIN$ and CONOUT$ with or without an
    extension (`device`), and `\\?\`, `\\.\`, `\??\` and UNC paths (`unc`);
    `windowsAlias(path)` names the check on its own. A path the OS maps off the
    root (`nul` on Windows) is now a refusal, never a bare error. The
    contract's `conformance.paths` lists the cases every client must agree
    on, the deny list's case-insensitive matches (`.ENV`, `ID_RSA`) among them.
  - `PROTECTED` also covers what matters when the root is the home folder
    or above it: `.bashrc`, `.bash_profile`, `.profile`, `.zshrc`,
    `.zprofile`, `.ssh/`, `.aws/` and `.config/matterwave` at any depth.
- `toolsOf(models, modelId)` and `localAgentToolsOf(me)`: the
  `supports_tools` and `local_agent_tools` flags as `"yes"`, `"no"` or
  `"unknown"` (`ToolsVerdict`), as `visionOf` reads `supports_vision`.
- `tests/agent-conformance.json`, the conformance cases both SDKs' suites
  run, and `tests/agent-contract.test.ts`, which recomputes the copy's
  SHA-256 and compares it with the source when the Python SDK is beside
  this checkout; CI clones it for that.
- `scripts/refresh-openapi.mjs` (`pnpm openapi:refresh <path-or-url>`)
  refreshes `tests/openapi.json` from the app's export (`--check` exits 1
  when it is behind), and the `ci` workflow takes an `openapi_source` URL
  on a manual run to test against it.

### Changed

- `tests/openapi.json` refreshed from the app's export: the two penalty
  fields on `ChatCompletionRequest` and the `compacting` stream event.
- The agent contract's `list_dir` and `glob` descriptions say what is left
  out (ignored and denied entries; protected ones are listed) and that a
  pattern with no `/` matches names at any depth.

## [0.5.0] - 2026-10-31

### Added

- `client.account` — the person's own account, the writes the Account and
  Preferences panes make (T-207): `rename({ full_name })`
  (`PATCH /api/me`), `acceptTerms({ version })`, `completeOnboarding()`,
  `changePassword({ current_password, new_password })`
  (`POST /api/me/password`; every other session ends with it),
  `sessions()`, `revokeSession(id)`, `revokeOtherSessions()`,
  `preferences()` / `updatePreferences(prefs)` (`GET`/`PUT
  /api/me/preferences`), the email change --
  `emailChangeState()`, `startEmailChange({ new_email, current_password })`,
  `verifyEmailChange({ code })`, `resendEmailChange()`,
  `cancelEmailChange()` -- and `deleteAccount({ confirm })`
  (`DELETE /api/me`, the phrase `"delete my account"`, typed and documented
  as the danger it is). The password and email writes are a signed-in
  session's; the platform answers an API key with 403 there. Client-side
  checks mirror the server's before anything is sent: the 12-character
  password floor, the BCP-47 locale and the deletion phrase.
  `Preferences.billing_receipts` is typed `true` only -- receipts are
  transactional mail the server refuses to switch off, and now so is the
  type.
- `client.exports` and `client.imports` — the account export and history
  import as jobs (T-208): `exports.start()` (`POST /api/me/export`, 202),
  `exports.get(id)` with a fresh signed `download_url` once ready,
  `exports.download(job | url)` for the bytes behind the signed link, and
  `imports.start({ file, filename })` (multipart, at most 100 MiB),
  `imports.list()`, `imports.get(id)`. One job runs at a time per account
  (409 while one does); `ExportJob`, `ExportJobStatus`, `ImportJob` and
  `ImportJobList` spell the rows, progress counts and errors as the worker
  moves them.
- `client.members` — the team management family (T-209): `list()` (every
  member, the caller's own role, the seats), `setRole(subject, { role })`,
  `transferOwnership(subject)` (one step: target becomes owner, caller
  admin), `remove(subject)` (leaving is removing yourself), the mailed
  invites -- `listInvites()`, `createInvite({ email, role })` (the answer
  says whether the mail went; a resend is the recovery),
  `resendInvite(id)`, `revokeInvite(id)` -- the invite links --
  `listInviteLinks()`, `createInviteLink({ role?, max_uses?,
  expires_in_days? })` (the `token` and `url` come back once; never an
  owner link), `revokeInviteLink(id)` -- and the join that redeems either:
  `lookupInvite(token)` and `lookupJoinLink(token)` (anonymous, token in
  the body so it stays out of access logs), `acceptInvite(token)`,
  `join(token)`. Every org route is gated on the membership row and
  refuses an API key, so a signed-in session answers them; scoping per
  method is in the doc comments.
- `OrgMember`, `MemberList`, `OrgInvite`, `InviteLinkRow`,
  `CreatedInviteLink`, `InvitePreview`, `JoinPreview` and `OrgRole` types.
- `client.org` — the org management family (T-226): `get()` and
  `rename({ name })`, `close({ confirm })` (the org's name typed exactly;
  danger documented; owner only and idempotent), the model allow-list --
  `models()` and `setModels({ allowed: string[] | null })` (the house
  model is added back whatever is sent) -- the sharing switch --
  `sharing()` / `setSharing({ enabled })`, `shares()` and
  `revokeShare(id)` -- and the SSO configuration: `sso()` (the policy with
  its preflight blockers), `setSso({ sso_required })` (owner only to
  enable; the answer carries the break-glass `recovery` code, shown
  exactly once), `mintRecoveryCode()`, the domains -- `domains()`,
  `claimDomain({ domain })`, `domainChallenge(domain)` (the DNS TXT record
  to publish), `verifyDomain(domain)` (200 proven, 202 not yet, 503 could
  not run), `releaseDomain(domain)` -- and the identity providers --
  `idps()` (never the secrets), `attachIdp({ kind: "oidc", name, issuer,
  client_id, client_secret, scopes? })`, `detachIdp(provider)`. The audit
  trail beside these stays `client.audit`. **Admin scoping:** every route
  here gates on the membership row and refuses an API key; owner-only
  methods are marked in their doc comments.
- `OrgProfile`, `OrgClosed`, `ModelPolicy`, `SharingPolicy`, `OrgShareRow`,
  `SsoSettings`, `RecoveryCode`, `DnsChallenge`, `DomainVerification`,
  `OrgDomainRow`, `OrgIdpRow` and `AttachIdpParams` types.
- `client.billing` — plans and billing (T-227): `plans()` (`GET /api/plans`,
  the public catalog, cheapest first, with the price table and the house
  model; no key needed), `switchPlan({ plan, reason? })` (`PUT /api/plan`,
  the move to Free -- a paid code is the server's 402 pointing at
  checkout), `planHistory()` (the append-only billing trail),
  `checkout({ plan, annual? })` and `portal()` (the Stripe URLs to
  redirect to), `status()` (entitlements, `billing_enabled`, how the org
  pays, and the open late-payment episode -- readable by any member), and
  `invoices()`. Switching, history, checkout, portal and invoices are
  owner or admin by membership row and refuse an API key.
- `Plan`, `PlanCatalog`, `PlanEvent`, `Invoice`, `BillingStatus`,
  `DunningState` and `Collection` types.
- `client.passkeys` — passkeys, WebAuthn relayed through the identity
  provider (T-228): `list()`, `startRegistration()`,
  `verifyRegistration(id, { credential, name })`, `rename(id, { name })`,
  `remove(id)` for the signed-in, and the sign-in ceremony --
  `startLogin({ email, auth_request })` and
  `finishLogin({ challenge, credential })`, anonymous, whose `options`
  feed `navigator.credentials` and whose sealed `challenge` comes back
  untouched.
- `client.mfa` — the second factor (T-228): `state()`,
  `startTotp()`, `confirmTotp({ code })` (the ten recovery codes come back
  shown-once), `removeTotp({ code? | recovery_code? })` (a proof is
  required; refused outright for a member of an org that requires MFA),
  `reissueRecoveryCodes({ code })`, and the sign-in code step --
  `verify({ challenge, code? | recovery_code? })`, `enrolStart({
  challenge })`, `enrolConfirm({ challenge, code })`, anonymous, the
  sealed challenge the password step handed out being the credential.
  Code shapes are checked before an attempt is spent: six digits (or
  eight), spaces removed.
- `client.accounts` — several accounts signed in on one browser (T-228):
  `list()`, `switch({ slot })`, `logout(slot)`, `logoutAll()`. These ride
  the session cookies (pass the browser's via `defaultHeaders`), answer
  only what the envelopes already told the browser, and are anonymous on
  purpose; slots are 1 to 3.
- `client.speech` — dictation's server route (T-228):
  `transcribe({ file, filename?, contentType?, language? })` (`POST
  /api/speech/transcribe`, multipart, one clip up to 10 MiB, the words
  back, nothing kept). Media types the route does not take are refused
  here before the upload.
- The passkey, MFA, account-roster and transcription wire types
  (`Passkey`, `PasskeyList`, `TotpEnrolment`, `MfaState`,
  `RecoveryCodesReissued`, `SignedInAccount`, `AccountRoster`,
  `Transcription`, and the params interfaces beside them).
- `client.edge` — edge pairing and sync (T-229, the resource side of the
  decision: one namespace, two scoping halves). An admin mints and
  manages: `mint({ name })` (`POST /api/sync/pairings`, a ten-minute
  twelve-character Crockford code), `devices()`, `unpair(keyId)` -- owner
  or admin by membership row, an API key refused. A box redeems:
  `pair({ code, device_id? })` (`POST /api/sync/pair`, anonymous, the
  code the credential, the `conversations:import` key shown once). And
  the device key works: `push({ conversation, device_id?, source?,
  format_version? })` (`POST /api/sync/conversations`, upsert by id, 200
  with per-message `rejected` -- the envelope defaults to format 1,
  source `edge`) and `status()` (counts, times and stop reasons, never
  content). The foreign-message and format-version refusals are checked
  here before the round trip.
- `PairingCode`, `PairingGranted`, `EdgeDevice`, `EdgeSyncStatus`,
  `EdgePushOutcome` and the push payload types (`EdgeConversation`,
  `EdgeMessage`, `EdgeOrigin`).
- `SessionRow`, `SessionList`, `Preferences`, `PasswordChanged`,
  `EmailChangeState`, `AccountDeleted` and the rest of the account family's
  wire types.

- `webhooks.unwrap(payload, headers, secret)` — the receiver's half of
  webhooks: verify a delivered event and decode it. The
  `MatterWave-Signature` header (`t=<unix>,v1=<hex HMAC-SHA256>` over
  `<t>.<body>`) is checked with a constant-time compare, any `v1=` element
  may match so a rotated secret verifies against either value during a
  changeover, and the timestamp must sit within 300 seconds (the platform's
  window) of the receiver's clock. `WebhookVerificationError` for a
  missing, stale or wrong signature, or a body that is not a JSON object;
  `sign` ships beside it, the platform sender's exact function. The MAC is
  WebCrypto, so the module runs in Node and browsers alike, and the two
  entry points are async the way the runtimes' own crypto is (T-201).
- Per-call `timeoutMs` and `maxRetries` on any call's options, overriding
  the client's settings for that one call — a single long call can take
  minutes without holding the whole client at its pace (T-202).
- `client.lastResponse` — the last HTTP response received, success or
  refusal: status, headers, the request id, `Retry-After` and the
  `X-RateLimit-*` window the parsed models leave behind, as a `RawResponse`
  (T-203).
- `client.chat.completions.parse({ schema })` — `create` plus validation:
  the answer's text read as JSON and parsed by the caller's zod schema,
  whose value comes back. A non-JSON answer is a `ParseError`; a schema
  failure throws the schema's own `ZodError` (T-204).
- `stream.accumulate()` on both streams — the whole answer or turn,
  accumulated: iterate for the pieces, call this for the whole (T-205).
- `client.conversations.items()` and the generic `itemsOf(pages)` — every
  item of every page, one at a time, the item-level paginator over any
  cursor-paginated list (T-205).
- `onRequest` / `onResponse` client hooks — the request about to go out
  and the response that came back, once per attempt, for logging (T-205).
- `UnprocessableEntityError` — the 422 validation refusal as its own
  class, the per-field messages joined onto the error (T-206).
- `client.audit.list()` and `client.audit.exportCsv()` — the org's audit
  trail (`GET /api/org/audit`, `GET /api/org/audit.csv`), the reads the org
  pane's audit tab makes: one page of `audit_events` newest first (`data`,
  `next_cursor`, `actions`) narrowed by `event` (an action exactly or as a
  dotted prefix), `actor` (subject or email, case-insensitively),
  `since`/`until`, `cursor` and `limit` (1 to 200, 50 when omitted), and
  every matching row as the CSV the server streams. Owner or admin by
  membership row: the platform refuses an API key on these routes, so they
  answer a signed-in session.
- `AuditPage` and `AuditEvent` types for the rows: `id`, `occurred_at`,
  `actor` (the writer's subject), `actor_email` where one is resolved,
  `action`, `target` and the writer's `detail`.

### Documentation

- "Connect your editor to MatterWave": a README section and a `docs/mcp.md`
  walk-through -- getting a key (Settings > API keys or device login),
  copy-paste MCP config for Claude Desktop, VS Code / Copilot and Cursor,
  the six tools and their scopes, the errors the two refusal shapes arrive
  as, the no-OAuth limitation and the security notes. `examples/mcp-via-sdk.ts`
  drives `client.mcp` end to end (list tools, create, send, search). The old
  `examples/mcp-client.ts`, built on the official `@modelcontextprotocol/sdk`,
  is removed: one example per SDK.

## [0.4.0] - 2026-10-30

### Added

- `client.admin.announcements`: the operator's announcement CRUD
  (`/api/admin/announcements`), the routes the admin console's Announcements
  tab speaks — `list()`, `create({ message, severity?, link?, starts_at?,
  ends_at?, dismissible? })`, `update(id, { message?, severity?, link?,
  starts_at?, ends_at?, dismissible?, end_now? })` and `delete(id)`. These
  are operator routes: they need the platform `admin` role, and an API key
  with user scopes cannot call them. The signed-in read side stays
  `client.announcements.list()`.
- `AdminAnnouncement` and `AdminAnnouncementList` types for the operator's
  view: every column, who wrote and last changed it, and where the window
  stands (`state`: `active`, `scheduled` or `ended`).

## [0.3.0] - 2026-10-30

### Added

- `client.notifications`: `list({ unread?, limit? })`, `read(id)` and
  `readAll()`, the caller's own rows behind the bell
  (`GET/POST /api/me/notifications*`).
- `client.announcements.list()`: the operator's announcements inside their
  window, most severe first (`GET /api/announcements`).
- `client.entitlements.get()`: the org's plan, its limits with the
  null-means-unlimited convention applied, and what a downgrade blocks
  (`GET /api/entitlements`).
- `client.conversations.report(id, kind, { message_id?, note? })`: file a
  report on a conversation or one message in it, `kind` being `unsafe` or
  `unhelpful` (`POST /api/conversations/{id}/report`).
- CI on every push and PR (`.github/workflows/ci.yml`): lint, typecheck and
  test. Publishing remains tag-only in `publish-npm.yml`.
