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
on the result; `pages()` is an async iterator over them all), and `search(q)`,
`get(id, { full })`, `tree(id)`, `setActiveLeaf(id, messageId)`, `fork(id,
messageId)`, `edit(id, messageId, { content })` and `regenerate(id, messageId)`
cover the rest of the sidebar and the branch switcher; `update(id, { title,
default_model })` renames the conversation and keeps the model its turns use
(`null` clears the model); `context(id)` says how full the
model's window is, and `compact(id)` folds the earlier messages into a summary
now (a `ConflictError` when there is nothing to fold yet). `client.me()` says
who the key acts as.

The stream is named server-sent events, read into frames discriminated on
`event`: `compaction`, `context`, `message` (the user turn as saved), `title`,
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
`createFolder`, `updateFolder`, `deleteFolder`, `move`, `createTag`,
`deleteTag`, `setTags`. `shares`: `create`, `list`, `listMine`, `revoke`,
`view`. `notifications`: `list`, `read`, `readAll`. `announcements`: `list`.
`entitlements`: `get`. `conversations` gains `report(id, kind, { message_id?,
note? })`: `kind` is `unsafe` or `unhelpful`. A delete or revoke resolves to
`undefined`; a missing id is a `NotFoundError`.

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

## Development

```
npm install
npm run typecheck && npm run lint && npm test && npm run build
```

`tests/openapi-contract.test.ts` checks this client against
`docs/developers/openapi.json` at the repo root, so a new operation on the API
and a new method here have to land together. That document is the `/v1`
contract; the conversation, device-login and native routes are listed apart in
`APP_OPERATIONS` and checked against it only where it names their paths.
`tests/native.test.ts` also holds each native route in `APP_OPERATIONS` to the
routers in `api/matterwave`, when they are beside the SDK. The
conversation stream's frames are the exception: the document lists them under
`x-sse-events`, and `CONVERSATION_EVENTS` is held to that list, event by event
and field by field.
