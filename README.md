# @matterwave/sdk

The TypeScript client for the MatterWave API: the OpenAI-compatible `/v1`
surface, typed, with a streaming async iterator, retries that honour
`Retry-After`, and the server's `X-Request-Id` on every error. `fetch`-based,
so it runs in Node 18+ and in browsers; ESM and CommonJS builds, one `.d.ts`.

```
npm install @matterwave/sdk
```

## Configure

```ts
import { MatterWave } from "@matterwave/sdk";

const client = new MatterWave({
  apiKey: "mw_...",
  baseUrl: "https://your-matterwave.example",
});
```

Both options fall back to `MATTERWAVE_API_KEY` and `MATTERWAVE_BASE_URL` when a
`process.env` exists (Node, or a bundler that provides one); in a browser pass
them. The base URL is the origin the app is served from; the OpenAI-style form
ending in `/v1` is accepted too. Keys are created under Settings > API keys in
the app and shown once.

## Three examples

### Complete

```ts
const completion = await client.chat.completions.create({
  messages: [{ role: "user", content: "Say hello in five words." }],
});
console.log(completion.choices[0].message.content);
console.log(completion.usage.total_tokens, completion.requestId);
```

`model` may be omitted; the deployment's default is used. `client.models.list()`
says what is served. Request fields keep their OpenAI names, so a body written
for the `openai` package passes through unchanged.

### Stream

```ts
const stream = await client.chat.completions.create({
  messages: [{ role: "user", content: "Tell me a short story." }],
  stream: true,
});
for await (const text of stream.text()) process.stdout.write(text);
```

`for await (const chunk of stream)` yields `ChatCompletionChunk` objects
instead. Add `stream_options: { include_usage: true }` for a final chunk with
the token counts (its `choices` is empty). Breaking out of the loop, or
aborting the request's `signal`, releases the connection.

### Errors and retries

```ts
import { APIError, RateLimitError } from "@matterwave/sdk";

try {
  await client.chat.completions.create({ messages, temperature: 0.2 });
} catch (err) {
  if (err instanceof RateLimitError) {
    // `rate_limit_exceeded` has already been retried with backoff;
    // `insufficient_quota` is the organisation's budget and is not.
    console.error(err.code, err.retryAfter, err.requestId);
  } else if (err instanceof APIError) {
    console.error(err.status, err.type, err.code, err.requestId);
  }
}
```

Every refusal is an `APIError` subclass by status: `BadRequestError` (400),
`AuthenticationError` (401), `PermissionDeniedError` (403), `NotFoundError`
(404), `ConflictError` (409), `RateLimitError` (429), `ServerError` (5xx). Each carries the API's
envelope (`message`, `type`, `code`, `param`) and `requestId`; a
`RateLimitError` also carries `rateLimit` (limit, remaining, reset seconds)
from the `X-RateLimit-*` headers. An error that
arrives inside a stream, after the 200, is an `APIError` with `status: null`.
Connection failures are `APIConnectionError`; a per-attempt timeout
(`timeoutMs`, default 60s, covering the connection and headers, not a stream's
body) is `APITimeoutError`.

A 429 whose code is `rate_limit_exceeded` and any 5xx (and connection errors)
are retried up to `maxRetries` times (default 2) with exponential backoff and
jitter, or for exactly `Retry-After` when the server sends one. A 429 whose
code is `insufficient_quota` is thrown at once. A streamed request is retried
only before its stream starts.

## Tools, structured output and embeddings

`tools`, `tool_choice` and `response_format` are passed to the model as sent
and the answer is relayed: a tool call comes back in `message.tool_calls` (or as
`delta.tool_calls` fragments on a stream) for your code to run, never run on
the server.

```ts
const completion = await client.chat.completions.create({
  messages: [{ role: "user", content: "Weather in Oslo?" }],
  tools: [{ type: "function", function: { name: "weather", parameters: { type: "object" } } }],
});
for (const call of completion.choices[0].message.tool_calls ?? []) {
  console.log(call.id, call.function.name, call.function.arguments);
}
```

To continue the loop, send the assistant message back with one `tool` message
per call; `toolMessage(callId, content)` builds the second:

```ts
import { toolMessage } from "@matterwave/sdk";

const assistant = completion.choices[0].message;
messages.push(assistant);
for (const call of assistant.tool_calls ?? []) messages.push(toolMessage(call.id, await run(call))); // run(): your code
const next = await client.chat.completions.create({ messages, tools });
```

On a stream, `await stream.finalMessage()` drains it and returns the same
message, each tool call put back together from its `delta.tool_calls`
fragments (calls at different indexes may interleave); `await
stream.finalCompletion()` resolves to the whole `ChatCompletion` instead, with
the finish reason and the usage (pass `stream_options: { include_usage: true }`
for the usage). `ChatCompletionAccumulator` does the same one chunk at a time, for a client
that renders the text as it arrives and also wants the finish reason and usage:

```ts
import { ChatCompletionAccumulator } from "@matterwave/sdk";

const acc = new ChatCompletionAccumulator();
for await (const chunk of await client.chat.completions.create({ messages, tools, stream: true })) {
  process.stdout.write(chunk.choices[0]?.delta.content ?? "");
  acc.add(chunk);
}
const message = acc.message(); // and acc.finishReason, acc.usage
```

`frequency_penalty` and `presence_penalty` (-2 to 2) are relayed as OpenAI
defines them. Before offering an agent mode, a client reads two flags: the
model row's `supports_tools` (`client.appModels()`) and the org's
`local_agent_tools` (`client.me()`). Each is absent or null when the server
did not say.

`client.embeddings.create({ input: ["one", "two"] })` returns one embedding per
input from the deployment's embedding model; `(await client.index()).capabilities`
says whether one is configured.

## Recording a turn into a conversation

```ts
await client.chat.completions.create({
  messages,
  metadata: { conversation_id: "<a conversation of the key owner's>" },
});
```

The request is still the whole prompt; the server splices in no history. Without
`metadata.conversation_id` nothing is stored.

## Conversations

`client.conversations` is the app's own conversation API, the one the web app
uses: the server keeps the history, builds the prompt and applies the
instructions, so a conversation made here shows up in the browser and the
other way round. A key acts as its owner.

```ts
const conv = await client.conversations.create({ title: "Plans" });
const stream = await client.conversations.send(conv.id, { content: "Draft a three-line agenda." });
for await (const frame of stream) {
  if (frame.event === "delta" && frame.content) process.stdout.write(frame.content);
  else if (frame.event === "context") meter(frame.prompt_tokens, frame.context_window);
  else if (frame.event === "error" || frame.event === "moderation_block") console.error(frame.detail, frame.code);
}
console.log(stream.result?.id); // the saved assistant message
```

`list({ filter, limit, cursor })` is one page of the sidebar (`next_cursor`
on the result; `pages()` is an async iterator over them all and `items()` over
every conversation of every page), and `search(q)`,
`get(id, { full })`, `tree(id)`, `setActiveLeaf(id, messageId)`, `fork(id,
messageId)`, `edit(id, messageId, { content })` and `regenerate(id, messageId)`
cover the rest of the sidebar and the branch switcher; `update(id, { title,
default_model })` renames the conversation and keeps the model its turns use
(`null` clears the model); `context(id)` says how full the
model's window is, and `compact(id)` folds the earlier messages into a summary
now (a `ConflictError` when there is nothing to fold yet). `client.me()` says
who the key acts as.

The stream is named server-sent events, read into frames discriminated on
`event`: `compacting` (first, when the server is folding earlier turns before
this one, so the first token is later than usual), `compaction`, `context`,
`message` (the user turn as saved), `title`,
`part_start` / `delta` / `part_end` per part (text, reasoning, tool call, tool
result), `notice`, and one terminal frame: `done` (the assistant message),
`error` or `moderation_block`. An event the client does not know arrives as
`{ event: "unknown", name, data }`; the server's heartbeat comments are
skipped. `stream.text()` yields just the answer's words; `sseEvents(body)` is
the parser on its own.

If the connection drops before the terminal frame, the stream reconnects once
with `Last-Event-ID` and the server replays the rest of the same generation;
the prompt is never sent twice. A drop before any resumable frame, or a second
drop, is an `APIConnectionError`.

## Keys, usage, webhooks, attachments, library and shares

The app's own settings routes, one method per route. A key acts as its owner,
within its scopes: managing keys needs `keys:manage`, `webhooks` needs
`webhooks:manage`, and `usage.org` / `usage.exportCsv` need `usage:read` (a
session needs none). None of them is in a key's default scopes; pick them when
minting the key. The scope never widens the owner's role: `webhooks` also needs
the key's owner to be an org owner or admin, and a member's `usage:read` key
reports only their own row. A key missing either rejects with
`PermissionDeniedError` (403).

```ts
// Keys: the secret is on the answer to create and rotate, and nowhere else.
const key = await client.keys.create({ name: "ci", expires_in_days: 90 });
await storeSomewhereSafe(key.key);
await client.keys.update(key.id, { allowed_cidrs: ["203.0.113.0/24"], expires_in_days: null }); // null clears
const rotated = await client.keys.rotate(key.id); // old secret works until rotated.previous_valid_until
await client.keys.revoke(key.id);

// Usage: the balance, the month per member, and the same month as CSV.
const balance = await client.usage.get();
const report = await client.usage.org({ period: "2026-10" });
const csv = await client.usage.exportCsv({ period: "2026-10" });

// Webhooks: the signing secret is on create and rotateSecret only.
const hook = await client.webhooks.create({ url: "https://hooks.example.com/mw", events: ["message.completed"] });
await client.webhooks.test(hook.id);
const failed = await client.webhooks.deliveries(hook.id, { status: "failed" });

// Attachments, then a turn that uses one.
const doc = await client.attachments.upload({ file: fileOrBlob, filename: "notes.pdf" });
const stream = await client.conversations.send(conversationId, { content: "Summarise this.", attachment_ids: [doc.id] });
for await (const text of stream.text()) process.stdout.write(text);
const bytes = await client.attachments.download(await client.attachments.get(doc.id));

// Library: folders, tags and paged search.
const folder = await client.library.createFolder("Work");
await client.library.move(conversationId, folder.id);
const page = await client.library.search("invoice", { limit: 20 });
for await (const hit of client.library.searchItems("invoice")) console.log(hit.title, hit.snippet);

// Shares: the token is on create only; view needs no key.
const link = await client.shares.create(conversationId, { expires_in_s: 7 * 86400 });
await client.shares.revoke(link.share.id);

// Notifications: the bell, the caller's own rows only.
const bell = await client.notifications.list({ unread: true });
await client.notifications.read(bell.data[0]!.id);
await client.notifications.readAll();

// Announcements: what the operator is telling everyone right now.
for (const banner of (await client.announcements.list()).data) console.log(banner.severity, banner.message);

// Entitlements: the org's plan, its limits, and what a downgrade blocks.
const plan = await client.entitlements.get();
if (plan.writes_blocked) console.warn(plan.read_only_reason);
```

`keys`: `list`, `create`, `update`, `rotate`, `revoke`. `usage`: `get`, `org`,
`exportCsv`. `webhooks`: `list`, `create`, `get`, `update`, `delete`,
`rotateSecret`, `test`, `deliveries`, `redeliver`. `attachments`: `upload`,
`get`, `delete`, `download`, `limits`. `library`: `get`, `search`,
`searchPages`, `searchItems`, `createFolder`, `updateFolder`, `deleteFolder`, `move`, `createTag`,
`deleteTag`, `setTags`. `shares`: `create`, `list`, `listMine`, `revoke`,
`view`. `notifications`: `list`, `read`, `readAll`. `announcements`: `list`.
`entitlements`: `get`. `conversations` gains `report(id, kind, { message_id?,
note? })`: `kind` is `unsafe` or `unhelpful`. A delete or revoke resolves to
`undefined`; a missing id is a `NotFoundError`.

Every cursor-paged list has a page iterator and an item iterator beside it:
`conversations.pages` / `items`, `audit.pages` / `items` and
`library.searchPages` / `searchItems`, each fetching the next page only when
the previous one has been consumed. `pagesOf(fetch)` and `itemsOf(pages)` are
the walk they share, for any list that answers `{ data, next_cursor }`:

```ts
import { itemsOf, pagesOf } from "@matterwave/sdk";

for await (const event of itemsOf(pagesOf((cursor) => client.audit.list({ event: "org.sso", cursor })))) {
  console.log(event.occurred_at, event.action);
}
```

## Receiving webhooks

`client.webhooks` manages endpoints; `webhooks` is the receiver's half. Every
delivery is signed twice under the endpoint's secret: `MatterWave-Signature`
(`t=<unix>,v1=<hex>`) and the Standard Webhooks headers (`webhook-id`,
`webhook-timestamp`, `webhook-signature`). `unwrap` accepts the delivery when
either verifies within five minutes of the receiver's clock, and only then
decodes the body; anything else throws `WebhookVerificationError`. It is
WebCrypto, so it runs in Node, Deno, Workers and browsers alike.

```ts
import { WebhookVerificationError, webhooks } from "@matterwave/sdk";

export async function receive(request: Request): Promise<Response> {
  const body = await request.text(); // the raw body, not re-encoded JSON
  try {
    const event = await webhooks.unwrap(body, request.headers, WEBHOOK_SECRET);
    await handle(event.type, event.data); // dedupe on event.id: delivery is at-least-once
  } catch (error) {
    if (error instanceof WebhookVerificationError) return new Response(null, { status: 400 });
    throw error;
  }
  return new Response(null, { status: 204 });
}
```

`verifySignature` and `verifyStandardSignature` check one scheme each; `sign`
and `signStandard` write them, for tests and for replaying a delivery.

## Device login

For an editor or a terminal with no browser of its own (RFC 8628): show the
person a code, they approve it in any browser, and the poll returns an API key
that acts as them.

```ts
const token = await client.auth.device.login({
  onCode: (code) => console.log(`Open ${code.verification_uri} and enter ${code.user_code}`),
  timeoutMs: 300_000,
});
const signedIn = new MatterWave({ apiKey: token.access_token });
```

`login` polls at the server's interval and slows down when told to; it throws
`DeviceAuthError` (`code` is `access_denied` or `expired_token`) or
`APITimeoutError`. `start()` and `poll(deviceCode)` are the two steps on their
own. The SDK never stores the token: keep it in the editor's secret storage or
the OS keyring.

## Connect your editor to MatterWave

`/mcp` on the deployment's origin is an MCP server: the conversation API in a
second wire format, over Streamable HTTP, with the same tenancy, scopes, plan
gates and budget as everything else the key reaches. Claude Desktop, VS Code /
GitHub Copilot and Cursor take the same three facts -- the URL
`https://your-matterwave.example/mcp`, transport `http`, and an API key in an
`Authorization: Bearer` header:

```json
{
  "mcpServers": {
    "matterwave": {
      "type": "http",
      "url": "https://your-matterwave.example/mcp",
      "headers": { "Authorization": "Bearer mw_..." }
    }
  }
}
```

(VS Code reads `servers` from `.vscode/mcp.json`; Cursor reads `mcpServers`
with just `url` and `headers`.) The six tools -- `list_conversations`,
`get_conversation`, `search_conversations`, `list_models`,
`create_conversation`, `send_message` -- are filtered by the key's scopes, so
a `chat:read`-only key is never offered a write. There is no OAuth: an API key
as bearer is the only scheme, a known gap until the identity provider can bind
a token to this resource. Get a key from Settings > API keys or by device login
(above), store it like a secret, and revoke it there when the editor moves on.
The full walk-through -- every client's config, the tool table, errors, the
audit trail -- is in [docs/mcp.md](docs/mcp.md), and `examples/mcp-via-sdk.ts`
drives the same endpoint through the wrapper:

```ts
const answer = await client.mcp.sendMessage("<conversation-id>", "Draft a three-line agenda.");
console.log(answer.text);
```

## The agent tool contract

The agent contract is what the MatterWave coding clients (the VS Code agent, the
TUI's `code` mode) share: the local tools a client offers the model on `/v1`,
the approval modes that gate them, the paths those tools may touch, and the
agent-mode system prompt. It is versioned (`CONTRACT_VERSION`, `1.0.0`; the
prompt carries its own `SYSTEM_PROMPT_VERSION`). Its one source is the Python
SDK's `contract.json`; `src/agent/contract.ts` is generated from it and must
not be edited by hand.

Two entries carry it:

- `import { agent } from "@matterwave/sdk"`: the contract's typed constants
  and the pure helpers (`allowed`, `toolsForMode`, `systemPrompt`, `applyEdit`,
  `unifiedDiff`, `DenyList`), browser-safe like the rest of the main entry.
- `import { ... } from "@matterwave/sdk/agent"`: all of that plus `confine`,
  `loadDenyList` and `resolveLinks`, which read the filesystem and so need Node
  (the VS Code extension host, a CLI).

| Tool | Kind | Arguments |
|---|---|---|
| `read_file` | read | `path`, `start_line`?, `end_line`? |
| `list_dir` | read | `path`? |
| `glob` | read | `pattern`, `path`? |
| `grep` | read | `pattern`, `path`?, `glob`?, `ignore_case`? |
| `edit` | write | `path`, `old_string`, `new_string` (fails when missing or not unique) |
| `write_file` | write | `path`, `content` |
| `run_shell` | shell | `command`, `timeout_s`? |

| Mode | Runs without asking | Asks first |
|---|---|---|
| `plan` | the read tools | nothing; writes and the shell are not offered at all |
| `ask` (default) | the read tools | `edit`, `write_file`, `run_shell` |
| `auto-edit` | the read tools, `edit`, `write_file` | `run_shell` |
| `yolo` | everything | nothing; needs a flag each session and is never saved |

```ts
import { readFileSync } from "node:fs";
import { toolMessage } from "@matterwave/sdk";
import { PathRefusedError, allowed, applyEdit, confine, systemPrompt, toolsForMode, unifiedDiff } from "@matterwave/sdk/agent";

const tools = toolsForMode("ask");               // the `tools` to send
const system = systemPrompt("ask", root);        // names the tools, the mode and the root

for (const call of assistant.tool_calls ?? []) {
  const decision = allowed(call.function.name, "ask"); // "allow", "ask" or "deny"
  const args = JSON.parse(call.function.arguments);
  let target;
  try {
    target = confine(root, args.path, { write: call.function.name !== "read_file" });
  } catch (error) {
    if (error instanceof PathRefusedError) {
      messages.push(toolMessage(call.id, error.message)); // the contract's sentence
      continue;
    }
    throw error;
  }
  // an edit: apply it to the text, show the diff, write only once approved
  const before = readFileSync(target.absolute, "utf-8");
  const after = applyEdit(before, args.old_string, args.new_string, { path: target.relative });
  console.log(unifiedDiff(before, after, target.relative));
}
```

`confine(root, path)` resolves a tool's path and returns where it really leads,
or throws `PathRefusedError` (with a `reason` and the sentence to hand back to
the model) before anything is read or written: for a `..` segment, an absolute
path outside the root, a link that leads out of the root (symbolic links, and
junctions on Windows), a path on the deny list, by its own name or its
target's, or a write to a protected path. The deny list is `.env*`, `*.pem`,
`id_*` and `.git/` plus the lines of the workspace's `.matterwaveignore`, and it
applies to reads too, so those files are never sent to the model;
`.matterwaveignore` itself can be read but not written. Confinement is not a
sandbox: `run_shell` reaches whatever the user can, which is why it asks.

`applyEdit` is `edit`'s exact replace on text (`EditError` when the string is
missing, not unique, empty or unchanged; a model's LF strings still match a
CRLF file), and `unifiedDiff` prints the diff an approval shows. Both are line
for line ports of the Python SDK's, and the two suites run the same conformance
cases (`tests/agent-conformance.json`, generated from the Python SDK's), so the
two clients refuse, edit and print alike.

The contract changes in the Python SDK: edit its `contract.json`, bump
`contract_version`, and run its `scripts/gen_agent_contract.py` with this repo
checked out beside it, which rewrites `src/agent/contract.ts` and
`tests/agent-conformance.json`. `tests/agent-contract.test.ts` recomputes the
copy's SHA-256 so a hand edit fails, and compares it with the source whenever
the Python SDK sits beside this checkout (or `MATTERWAVE_AGENT_CONTRACT` names
its `contract.json`, as CI does after cloning it).

## Development

```
npm install
npm run typecheck && npm run lint && npm test && npm run build
```

`tests/openapi-contract.test.ts` checks this client against the app's
exported OpenAPI document, `docs/developers/openapi.json` in the app repo,
through the snapshot in `tests/openapi.json`, so a new operation on the API
and a new method here have to land together. That document is the `/v1`
contract; the conversation, device-login and native routes are listed apart in
`APP_OPERATIONS`. The conversation stream's frames are the exception: the
document lists them under `x-sse-events`, and `CONVERSATION_EVENTS` is held to
that list, event by event and field by field.

`tests/route-drift.test.ts` holds every route the SDK calls to the platform's
whole route document, `docs/developers/openapi-full.json`, vendored as
`tests/openapi-full.json` at the platform commit `tests/openapi-full.pin.json`
names. It fails when a route the SDK calls moves or goes, and when the document
gains a route that is neither wrapped here nor listed, with the reason, in
`tests/routes-not-covered.json`.

### Refreshing the OpenAPI snapshot

`scripts/refresh-openapi.mjs` (`pnpm openapi:refresh`) copies the app's export
over `tests/openapi.json`, from a path or an http(s) URL, after checking it is
the export (an OpenAPI document with `paths` and `x-sse-events`). `--check`
writes nothing and exits 1 when the snapshot is behind:

```
pnpm openapi:refresh ../matterwave-app/docs/developers/openapi.json
pnpm openapi:refresh --check https://<host>/<path>/openapi.json
```

In CI, run the `ci` workflow by hand (`workflow_dispatch`) with an
`openapi_source` URL: it refreshes the snapshot from it before the checks, so
the run says whether this client still matches that API.

### Refreshing the route document

`scripts/refresh-openapi-full.mjs` (`pnpm openapi:refresh-full`) vendors the
whole route document from a checkout of the platform repo, at a branch or
commit (`--ref`, `HEAD` by default), with the routes the platform serves but
leaves out of it (the operator console, the edge mirror, the sign-in forms) and
the commit, in `tests/openapi-full.pin.json`. `--check` writes nothing and
exits 1 when the vendored pair is behind that ref. The Python SDK's
`scripts/refresh_openapi_full.py` writes the same bytes.

```
pnpm openapi:refresh-full ../matterwave-app --ref develop
pnpm openapi:refresh-full ../matterwave-app --ref develop --check
```

`scripts/check-live-routes.mjs <deployment>/openapi.json` (after `pnpm build`)
holds a running deployment to the same pair: every route the SDK calls is
served, every pinned route is still served, and every served route is pinned or
internal. The `route-drift` workflow runs it daily against the repository
variable `MATTERWAVE_LIVE_OPENAPI_URL` and opens an issue with the report on
drift.
