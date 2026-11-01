# @matterwave/sdk

The TypeScript client for the MatterWave API: the OpenAI-compatible `/v1`
surface, typed, with a streaming async iterator, retries that honour
`Retry-After`, and the server's `X-Request-Id` on every error. `fetch`-based
with no dependencies, so it runs in Node 20+, Bun, Deno and browsers -- CI runs
it in each; ESM and CommonJS builds, each with its own declarations.

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
`process.env` exists (Node, Bun, Deno with `--allow-env`, or a bundler that
provides one); in a browser pass them. A key in a page's JavaScript is readable
by anyone who loads the page, so in a browser the client refuses one unless
`dangerouslyAllowBrowser: true` says that exposure is understood (a key scoped
and rate-limited for exactly that page); call the API from a server otherwise. The base URL is the origin the app is served from; the OpenAI-style form
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
from the `X-RateLimit-*` headers. A send, edit or regenerate in a
conversation a connector opened (one started from Slack) is a
`ConnectorConversationError`, the `ConflictError` whose `code` is
`connector_conversation` and whose `source` names the connector, the
channel and the thread's link; fork it to continue it here. An error that
arrives inside a stream, after the 200, is an `APIError` with `status: null`.
Connection failures are `APIConnectionError`; a per-attempt timeout
(`timeoutMs`, default 60s, covering the connection and headers, not a stream's
body) is `APITimeoutError`.

A 429 whose code is `rate_limit_exceeded` is retried up to `maxRetries` times
(default 2) with exponential backoff and jitter, or for exactly `Retry-After`
when the server sends one. A 429 whose code is `insufficient_quota` is thrown
at once, and so is a 429 or 5xx whose `Retry-After` is longer than
`maxRetryWaitMs` (default 60 seconds), with the delay in `err.retryAfter`; an
abort on the call's `signal` ends a wait at once. A 5xx or a dropped
connection is retried the same way for a request
that is safe to send twice (GET, PUT, DELETE, and the read-only MCP calls). A
POST or PATCH -- a message, a key, an upload -- is sent again only when the
connection was never made: after a 5xx, a timeout or a reply cut short, the
first copy may already have taken effect, so the error is thrown instead. A
streamed request is retried only before its stream starts.

Every write (any method but GET) carries an `Idempotency-Key` header: a fresh
UUID per call, the same on each of its retries, so the server can recognise a
repeat. `{ idempotencyKey }` in a call's options supplies your own, for a write
whose retries may come from another process. The API does not yet answer a
repeated key with the first result, so the narrower retry rule for writes
above still applies.

### Logging and deprecations

`logLevel: "info"` (or `MATTERWAVE_LOG=info` where there is an environment)
logs one line per response or failure -- method, path, status, request id and
time taken; `"debug"` adds each attempt as it goes out and each wait before a
retry. Bodies and headers are never logged. Lines go to `console` unless a
`logger` is passed.

When the API marks a route for retirement (`Deprecation` and `Sunset`
headers), the first call to it warns through `logger.warn`, naming the route
and its dates, once per route per process. See [VERSIONING.md](VERSIONING.md)
for what each release supports.

### Per-call settings

`timeoutMs`, `maxRetries` and `maxRetryWaitMs` are set on the client and apply
to every call. Every method takes a last `RequestOptions` argument that gives
the call its own -- with `signal` and `headers` besides:

```ts
await client.conversations.compact(conversationId, { timeoutMs: 600_000, maxRetries: 0 });
```

`client.withOptions({ timeoutMs, maxRetries, maxRetryWaitMs, defaultHeaders })`
returns the client with those settings replaced, sharing its `fetch` and hooks,
for code that makes several calls under the same bounds.

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

## Your account and your data

The caller's own account, with a key (as its owner) or a person's token:

```ts
await client.account.update({ full_name: "Ada Lovelace" });
await client.account.acceptTerms("2026-10");          // a version other than the current one is a 422
const held = await client.account.enforcement();      // state "none", or the warning or limit and why
await client.preferences.update({ product_updates: true }); // reads, changes what was given, writes back
for (const session of (await client.sessions.list()).sessions) console.log(session.user_agent, session.last_seen_at);
await client.sessions.revokeOthers();

// Everything the account holds, as one JSON document (needs chat:read).
const document = await client.exports.createAndDownload({ timeoutMs: 600_000 });

// Conversations from ChatGPT's or Claude's data export (needs chat:write).
const job = await client.imports.create({ file: exportFile, filename: "conversations.json" });
console.log((await client.imports.wait(job.id)).conversations_created);

const said = await client.speech.transcribe({ file: clip, filename: "note.ogg", language: "en" });
await client.attachments.scan(attachmentId);          // poll until scan_status is "clean"
const data = await client.attachments.view(attachmentId); // the bytes, through the signed link the route mints

const status = await client.billing.status();         // the plan, its limits, and dunning when late
const catalog = await new MatterWave({ apiKey: null }).plans.list(); // public: the price list and model prices
```

`account`: `update`, `acceptTerms`, `enforcement`. `preferences`: `get`,
`update` (the route replaces the whole object, so `update` reads it first; a
key not given keeps its value, `locale: null` clears the locale, and billing
receipts cannot be turned off). `sessions`: `list` (a session's `id` is the
cookie's own value, a secret to keep out of logs), `revoke`, `revokeOthers`.
`exports`: `create`, `get`, `wait`, `download`, `createAndDownload`, and
`document`, which builds the export inside the request; a ready export's
`download_url` is a secret too. `imports`: `create`, `list`, `get`, `wait`.
`speech.transcribe`, `attachments.scan` / `view`, `billing.status`,
`plans.list` and `policy.stats` (the last two public, sent with no
credential). `wait` throws `MatterWaveError` when the job failed or expired
and `APITimeoutError` when `timeoutMs` passes first.

The same routes answer to a second spelling, one call per route:
`account.rename` (as `update`, the body sent whole), `account.sessions` /
`revokeSession` / `revokeOtherSessions`, `account.preferences` /
`updatePreferences` (the whole shape, as `preferences()` returned it),
`exports.start` (as `create`), `imports.start` (the file sent as given) and
`billing.plans` (as `plans.list`). `account` also has
`completeOnboarding`, and the routes a person's token takes and a key never
does: `changePassword`, the email change (`emailChangeState`,
`startEmailChange`, `verifyEmailChange`, `resendEmailChange`,
`cancelEmailChange`) and `deleteAccount` (`confirm` is `"delete my
account"`). `passkeys`, `mfa` and `accounts` are the web app's sign-in
ceremonies (registering a passkey or a second factor is a signed-in
person's; the sign-in steps and the account switcher are anonymous), and
`edge` pairs an edge box (`mint`, `devices`, `unpair` for an owner or
admin; `pair` with the code; `push` and `status` with the device key).

## Administering the organisation

Members, invites, the org's settings and its billing are a person's to manage,
not a key's: sign in as an owner or admin (see [Signing a person in](#signing-a-person-in))
and pass the token as `accessToken`.

```ts
const admin = new MatterWave({ accessToken: signin.session(token).accessToken });

for (const member of (await admin.members.list()).data) console.log(member.email, member.role, member.state);
await admin.members.setRole(subject, "admin");
const invite = await admin.invites.create("new.hire@example.com", { role: "member" }); // mailed; `mail` says if it went
const link = await admin.inviteLinks.create({ role: "viewer", max_uses: 5 });          // link.url is shown this once

await admin.org.setModels(["grt-nano", "grt-pro"]); // the allow-list; null allows the whole plan
await admin.org.setSharing(false);                  // silences every share link without revoking it
await admin.org.domains.claim("example.com");
console.log((await admin.org.domains.challenge("example.com")).record.value); // publish, then verify()
await admin.org.idps.attach({ name: "Okta", issuer: "https://acme.okta.com", client_id, client_secret });
const enforced = await admin.org.setSso(true);      // owner only; store enforced.recovery.code offline

console.log((await admin.billing.invoices()).data[0]?.hosted_invoice_url);
const checkout = await admin.billing.checkout("team", { annual: true }); // send the person to checkout.url
```

`org`: `get`, `rename`, `close` (owner only, irreversible; `confirm` is the
org's name), `models` / `setModels`, `sharing` / `setSharing`, `shares` /
`revokeShare`, `sso` / `setSso` / `mintRecoveryCode`, `mfa` / `setMfa`, and
`org.domains` (`list`, `claim`, `challenge`, `verify`, `release`) and
`org.idps` (`list`, `attach`, `detach`). `members`: `list`, `setRole`,
`transferOwnership`, `remove`. `invites`: `list`, `create`, `resend`,
`revoke`, `lookup`, `accept`. `inviteLinks`: `list`, `create`, `revoke`,
`lookup`, `join`. `billing`: `checkout`, `portal`, `invoices`, `changePlan`,
`planHistory` beside `status`. `auth.device`: `lookup`, `approve`, `deny`, the
person's side of device login. `members` carries the invites and links as
well (`listInvites`, `createInvite({ email, role })`, `resendInvite`,
`revokeInvite`, `lookupInvite`, `acceptInvite`, `listInviteLinks`,
`createInviteLink`, `revokeInviteLink`, `lookupJoinLink`, `join`), `org` the
domains and providers flat (`claimDomain({ domain })`, `domainChallenge`,
`verifyDomain`, `releaseDomain`, `attachIdp`, `detachIdp`), and `billing`
`switchPlan({ plan, reason })` beside `changePlan`; `org.rename`,
`setModels`, `setSharing`, `setSso`, `members.setRole` and
`billing.checkout` take the object (`{ name }`, `{ allowed }`, ...) as well
as the bare value. `invites.lookup` and `inviteLinks.lookup` are
anonymous: the token is the credential. Reading the org, its members and its
invites is any member's; the rest is an owner's or admin's, and closing the
org, transferring ownership and requiring SSO or two-factor an owner's alone.
`domains.verify` resolves the route's 202 (the record is not there yet) like
its 200, with `verified` false. One-time secrets -- an invite link's `token`
and `url`, an SSO recovery `code` -- are on the one answer that carries them;
keep them out of logs.

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

The key device login mints carries `chat:read` and `chat:write`, so it acts as
the person in their conversations but not on the routes that manage the
organisation; for those, sign the person in at the identity provider instead.

## Signing a person in

The routes that manage the organisation -- members and invites, the org's
settings, its billing, the audit trail, the org's instructions, budget caps, and
the operator console -- gate on the caller's membership, not a key scope, and answer every API key 403 "Membership is managed
by a person, not an API key." A person's access token from the deployment's
identity provider is what they take. Pass one as `accessToken`, the token itself
or a function that returns it (or a promise of it); the client sends it where a
key would go, and every other route takes it too.

```ts
import { MatterWave } from "@matterwave/sdk";

const signin = new MatterWave({ baseUrl: "https://your-matterwave.example" }).auth.person;
const token = await signin.login({
  onCode: (code) => console.log(`Open ${code.verification_uri_complete}`),
  timeoutMs: 300_000,
});
const session = signin.session(token, { onRefresh: storeInSecretStorage });
const admin = new MatterWave({ baseUrl: "https://your-matterwave.example", accessToken: session.accessToken });
console.log((await admin.audit.list({ event: "org.sso" })).data);
```

`auth.person.login` is the device authorization grant (RFC 8628) against the
identity provider's native client, which `/api/auth-config` names; a deployment
without one throws `MatterWaveError`. It asks for `offline_access` beside the
deployment's scopes, so the `PersonToken` carries a refresh token, and
`session(token).accessToken` hands over the access token and refreshes it a
minute before it expires -- once, however many calls ask at that moment --
passing each new set to `onRefresh` so the caller can store the rotated refresh
token. `start()`, `poll(deviceCode)` and `refresh(token)` are the steps on
their own. A token from anywhere else -- an agent's or a service account's,
issued by the same identity provider for the deployment's project -- works the
same way: `accessToken: "eyJ..."`.

### Which credential each method needs

`CREDENTIALS` maps every operation to what its route accepts, from the
platform's route document (the drift test holds the two together):

| `CREDENTIALS` | Accepts | Methods |
| --- | --- | --- |
| `public` | nothing | `index`, `auth.device.start` / `poll`, `shares.view`, `plans.list`, `billing.plans`, `policy.stats`, `invites.lookup`, `inviteLinks.lookup`, `members.lookupInvite` / `lookupJoinLink`, `passkeys.startLogin` / `finishLogin`, `mfa.verify` / `enrolStart` / `enrolConfirm`, `accounts`, `edge.pair` |
| `key` | any API key, or a person's token | `me`, `account` (but its password, email and deletion methods), `preferences`, `sessions`, `speech`, `billing.status`, `appModels`, `instructions.user` / `updateUser`, `notifications`, `announcements.list`, `entitlements.get`, `messages.setFeedback` / `deleteFeedback`, `keys.list`, `usage.get`, `attachments`, `library`, `shares.listMine` / `revoke`, `budget.get`, `edge.status` |
| `key:chat:read` | a key with `chat:read`, or a person's token | `models`, `exports`, the conversation reads, `messages.listFeedback`, `shares.list` |
| `key:chat:write` | a key with `chat:write`, or a person's token | `imports`, `chat.completions.create`, `embeddings.create`, the conversation writes and turns, `shares.create` |
| `key:keys:manage` | a key with `keys:manage`, or a person's token | `keys.create` / `update` / `rotate` / `revoke` |
| `key:usage:read` | a key with `usage:read`, or a person's token | `usage.org`, `usage.exportCsv` |
| `key:webhooks:manage` | a key with `webhooks:manage`, or a person's token | `webhooks` |
| `key:conversations:import` | a key with `conversations:import` (an edge box's device key), or a person's token | `edge.push` |
| `person` | a person's token only | `audit`, `instructions.org` / `updateOrg`, `budget.members` / `setOverageCap` / `setMemberDefaultCap` / `setMemberCap`, `account.changePassword`, the email change and `deleteAccount`, `org`, `members`, `invites` and `inviteLinks` (but their `lookup`s), `billing` (but `status` and `plans`), `passkeys` and `mfa` (but the sign-in steps), `edge.mint` / `devices` / `unpair`, `auth.device.lookup` / `approve` / `deny`, `admin` |

A scope never widens a role: the org routes still need the org role they ask of a
person, whichever credential carries it.

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

## Python and TypeScript

The two SDKs are one client in two languages: a name here in snake_case is the
same name there in camelCase, and `tests/parity.test` (`test_parity.py`,
`parity.test.ts`) holds each to the other's public surface. Where they differ
on purpose, `tests/parity.json` says why; the differences a caller meets are:

| Python | TypeScript | Why |
| --- | --- | --- |
| `timeout=`, `max_retry_wait=` (seconds) | `timeoutMs`, `maxRetryWaitMs` | each language's unit for time |
| `client.with_options(...)` for any call | the same per call in `RequestOptions`, or `client.withOptions(...)` | a TypeScript call takes an options argument; a Python one would need a keyword on every method |
| `with_options(idempotency_key=...)` | `{ idempotencyKey }` in a call's options or `withOptions` | as above |
| `extra_headers=`, `extra_query=`, `extra_body=` on chat and embeddings | `extraHeaders`, `extraQuery`, `extraBody` in any call's options (`headers` is `extraHeaders`' older name) | the OpenAI-compatible calls are where the API adds fields first |
| `stream.final_text()` | `stream.finalText()` (`accumulate()` is its older name) | |
| `stream.close()`, `client.close()` | `stream.abort()`; the client has no pool to close | httpx holds connections; fetch cancels by signal |
| `http_client=` | `fetch` | the transport each language sends with |
| `on_request` receives the `Request` | `onRequest` receives `{ method, path }` | a TypeScript body may be a form or a stream, not something to hand a logger |
| `MATTERWAVE_LOG` or the `matterwave_sdk` logger | `logLevel` and `logger` (`MATTERWAVE_LOG` where there is an environment) | Python has a logging module; JavaScript does not |
| `APIDeprecationWarning`, a warning | `logger.warn` | each language's way to warn |
| | `dangerouslyAllowBrowser` | only a browser puts a key in reach of a page's visitors |

A configuration mistake (no base URL, a negative retry count) is a
`MatterWaveConfigError` in both, under `MatterWaveError`; in Python it is a
`ValueError` as well. Python checks other arguments with `ValueError`, as
Python does; TypeScript throws `MatterWaveConfigError` for those too.

## Examples and reference

Each file in `examples/` runs as a script (`npx tsx examples/<name>.ts`) and
reads `MATTERWAVE_BASE_URL` and `MATTERWAVE_API_KEY`; each exports its `run`,
which `tests/examples.test.ts` calls against a stubbed `fetch`.

| File | Shows |
| --- | --- |
| `chat.ts` | one completion and its token count |
| `streaming.ts` | text as it arrives, then the finish reason and usage |
| `structured-output.ts` | `chat.completions.parse` with a zod schema |
| `webhook-receiver.ts` | a fetch-style handler that verifies each delivery with `webhooks.unwrap` |
| `device-sign-in.ts` | device sign-in, for an API key or for a person's own token |
| `pagination.ts` | `items()`, `searchItems()` and `pagesOf` / `itemsOf` |
| `mcp-via-sdk.ts` | the `/mcp` endpoint through `client.mcp` |

The API reference is generated with typedoc over the two entry points; the
`docs` workflow builds it on every push, fails on any typedoc warning, and
uploads it as the `api-reference` artifact. To build and check it locally:

```
pnpm build
pnpm dlx typedoc@0.28.14 --entryPoints src/index.ts src/agent/node.ts   --excludeInternal --treatWarningsAsErrors --out reference --json reference.json
node scripts/check-reference.mjs reference.json
```

## Development

```
npm install
npm run typecheck && npm run lint && npm test && npm run build
```

`pre-commit install` once per clone runs gitleaks on every commit, the same
secret scan CI runs over the whole history.

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
