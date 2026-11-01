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
- `tests/agent-conformance.json`, the conformance cases both SDKs' suites
  run, and `tests/agent-contract.test.ts`, which recomputes the copy's
  SHA-256 and compares it with the source when the Python SDK is beside
  this checkout; CI clones it for that.
- `scripts/refresh-openapi.mjs` (`pnpm openapi:refresh <path-or-url>`)
  refreshes `tests/openapi.json` from the app's export (`--check` exits 1
  when it is behind), and the `ci` workflow takes an `openapi_source` URL
  on a manual run to test against it.

- `client.withOptions({ timeoutMs, maxRetries, maxRetryWaitMs,
  defaultHeaders, idempotencyKey })`: the client with those settings
  replaced, sharing its `fetch` and hooks, as Python's `with_options`.
- An `Idempotency-Key` header on every write (any method but GET): a fresh
  UUID per call, the same on each of its retries; `idempotencyKey` in a
  call's options (or `withOptions`) supplies the caller's own.
- `maxRetryWaitMs` (default 60 seconds), on the client and per call: a
  `Retry-After` longer than it throws the error at once, with `retryAfter`
  set, rather than waiting.
- `extraHeaders`, `extraQuery` and `extraBody` in every call's options;
  `headers` stays as `extraHeaders`' older name.
- `stream.finalText()` on both streams; `accumulate()` stays as its alias.
- `logLevel` (default `MATTERWAVE_LOG`) and `logger`: a line per response or
  failure (method, path, status, request id, time), and with `debug` each
  attempt and each retry's wait. Bodies and headers are never logged.
- A warning through `logger.warn`, once per route, when a response carries
  `Deprecation` or `Sunset`, naming the route and the dates.
- `dangerouslyAllowBrowser`: in a browser the client refuses an API key
  without it.
- `VERSIONING.md`: the 0.x policy and the API namespace each release speaks;
  the package ships it and the CHANGELOG.
- `tests/surface.json` and `tests/parity.json`: the public surface, read off
  the declarations, and each difference from the Python SDK with its
  reason, held by a test against that SDK's copy. The README has the table.
- Releases: a tag must name the package version, a CycloneDX SBOM is built,
  and each tag gets a GitHub release with its CHANGELOG section, the packed
  tarball and the SBOM (`scripts/release.mjs`).
- CI on Node 20, 22 and 24, with `attw` on the built package and
  `scripts/smoke.mjs` running it in Bun, Deno and headless Chrome; a
  gitleaks scan of the whole history and a check that no tracked file names
  a private ticket; `.pre-commit-config.yaml` runs gitleaks on each commit;
  `CODEOWNERS`.

### Changed

- A POST or PATCH is retried only after a 429 or a connection that was
  never made. After a 5xx, a timeout or a reply cut short the first copy may
  have taken effect -- a message stored and billed, a key minted -- so the
  error is thrown instead. GET, PUT, DELETE and the read-only MCP calls
  retry as before.
- Node 20 or later (`engines`): Node 18 is out of support and lacks the
  global Web Crypto the webhooks and the idempotency keys use.
- No runtime dependency: `parse` takes any schema with a `parse` method, so
  zod is an optional peer rather than a dependency.
- `MatterWaveConfigError` extends `MatterWaveError`.
- An environment that cannot be read (Deno without `--allow-env`) counts as
  unset rather than throwing.
- Every action in the workflows is pinned to a commit, and the workflow
  token is read-only unless a job needs more.
- `tests/openapi.json` refreshed from the app's export: the two penalty
  fields on `ChatCompletionRequest` and the `compacting` stream event.

### Fixed

- A retried write could send a message, or mint a key, twice.
- A `Retry-After: 3600` held a call for an hour, and aborting the call's
  signal did not end a wait between retries; now it ends at once.
- A CommonJS consumer got the ESM type declarations: each condition of the
  exports map now names its own (`.d.cts` for `require`).

## [0.5.0] - 2026-10-31

### Added

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
  entry points are async the way the runtimes' own crypto is.
- Per-call `timeoutMs` and `maxRetries` on any call's options, overriding
  the client's settings for that one call — a single long call can take
  minutes without holding the whole client at its pace.
- `client.lastResponse` — the last HTTP response received, success or
  refusal: status, headers, the request id, `Retry-After` and the
  `X-RateLimit-*` window the parsed models leave behind, as a `RawResponse`.
- `client.chat.completions.parse({ schema })` — `create` plus validation:
  the answer's text read as JSON and parsed by the caller's zod schema,
  whose value comes back. A non-JSON answer is a `ParseError`; a schema
  failure throws the schema's own `ZodError`.
- `stream.accumulate()` on both streams — the whole answer or turn,
  accumulated: iterate for the pieces, call this for the whole.
- `client.conversations.items()` and the generic `itemsOf(pages)` — every
  item of every page, one at a time, the item-level paginator over any
  cursor-paginated list.
- `onRequest` / `onResponse` client hooks — the request about to go out
  and the response that came back, once per attempt, for logging.
- `UnprocessableEntityError` — the 422 validation refusal as its own
  class, the per-field messages joined onto the error.
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
