# Changelog

All notable changes to `@matterwave/sdk` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Route drift tests that run in every checkout: `tests/openapi-full.json`
  (the platform's whole route document, vendored at the commit
  `tests/openapi-full.pin.json` names, by `pnpm openapi:refresh-full`) holds
  every route the SDK calls, and every route the platform documents is
  wrapped or listed with its reason in `tests/routes-not-covered.json`.
  `scripts/check-live-routes.mjs` and the daily `route-drift` workflow hold a
  running deployment's `/openapi.json` to the same pair and open an issue on
  drift. The two checks that needed the platform checkout beside the SDK, and
  skipped without it, are gone.
- `stream.finalCompletion()` and `ChatCompletionAccumulator.completion()`:
  the whole streamed answer as a `ChatCompletion` -- the message with its
  tool calls, the finish reason, the usage, the id and model. A stream that
  ended without a finish reason throws `MatterWaveError` rather than pass for
  a whole answer.
- Standard Webhooks verification: `webhooks.verifyStandardSignature`
  (exported as `verifyStandardWebhookSignature`) checks `webhook-id`,
  `webhook-timestamp` and `webhook-signature` (`v1,` and base64, keyed by the
  base64 after `whsec_`), and `webhooks.unwrap` accepts a delivery whose
  MatterWave or Standard Webhooks signature verifies. `webhooks.signStandard`
  and `webhooks.secretKeyBytes` write and key them.
- Page and item iterators for every cursor-paged list: `audit.pages()` /
  `audit.items()` (the same filters as `audit.list`) and
  `library.searchPages(q)` / `library.searchItems(q)`. `pagesOf(fetch)` is
  the page walk they share, exported beside `itemsOf` for any list
  answering `{ data, next_cursor }`; `conversations.pages()` uses it too.
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

### Changed

- `tests/openapi.json` refreshed from the app's export: the two penalty
  fields on `ChatCompletionRequest` and the `compacting` stream event.

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
