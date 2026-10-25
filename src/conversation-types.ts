/**
 * The conversation API's wire types (`/api`), spelled as the API spells them.
 *
 * These are the routes the web app itself uses, open to an API key as its
 * owner. Their bodies are richer than these types and grow with the app; the
 * fields below are the ones a client renders. They are not in
 * docs/developers/openapi.json (that document is the `/v1` contract), so
 * `APP_OPERATIONS` lists them apart from `OPERATIONS`.
 */

export const APP_OPERATIONS = {
  me: ["GET", "/api/me"],
  "conversations.list": ["GET", "/api/conversations"],
  "conversations.search": ["GET", "/api/conversations/search"],
  "conversations.create": ["POST", "/api/conversations"],
  "conversations.get": ["GET", "/api/conversations/{conversation_id}"],
  "conversations.update": ["PATCH", "/api/conversations/{conversation_id}"],
  "conversations.tree": ["GET", "/api/conversations/{conversation_id}/tree"],
  "conversations.setActiveLeaf": ["PUT", "/api/conversations/{conversation_id}/active-leaf"],
  "conversations.send": ["POST", "/api/conversations/{conversation_id}/messages"],
  "conversations.edit": ["POST", "/api/conversations/{conversation_id}/messages/{message_id}/edit"],
  "conversations.regenerate": [
    "POST",
    "/api/conversations/{conversation_id}/messages/{message_id}/regenerate",
  ],
  "conversations.fork": ["POST", "/api/conversations/{conversation_id}/fork"],
  "conversations.context": ["GET", "/api/conversations/{conversation_id}/context"],
  "conversations.compact": ["POST", "/api/conversations/{conversation_id}/compact"],
  "auth.device.start": ["POST", "/api/auth/device"],
  "auth.device.poll": ["POST", "/api/auth/device/token"],
  "keys.list": ["GET", "/api/keys"],
  "keys.create": ["POST", "/api/keys"],
  "keys.update": ["PATCH", "/api/keys/{key_id}"],
  "keys.rotate": ["POST", "/api/keys/{key_id}/rotate"],
  "keys.revoke": ["DELETE", "/api/keys/{key_id}"],
  "usage.get": ["GET", "/api/me/usage"],
  "usage.org": ["GET", "/api/org/usage"],
  "usage.exportCsv": ["GET", "/api/org/usage.csv"],
  "webhooks.list": ["GET", "/api/org/webhooks"],
  "webhooks.create": ["POST", "/api/org/webhooks"],
  "webhooks.get": ["GET", "/api/org/webhooks/{endpoint_id}"],
  "webhooks.update": ["PATCH", "/api/org/webhooks/{endpoint_id}"],
  "webhooks.delete": ["DELETE", "/api/org/webhooks/{endpoint_id}"],
  "webhooks.rotateSecret": ["POST", "/api/org/webhooks/{endpoint_id}/rotate"],
  "webhooks.test": ["POST", "/api/org/webhooks/{endpoint_id}/test"],
  "webhooks.deliveries": ["GET", "/api/org/webhooks/{endpoint_id}/deliveries"],
  "webhooks.redeliver": ["POST", "/api/org/webhooks/{endpoint_id}/deliveries/{delivery_id}/redeliver"],
  "attachments.upload": ["POST", "/api/attachments"],
  "attachments.get": ["GET", "/api/attachments/{attachment_id}"],
  "attachments.delete": ["DELETE", "/api/attachments/{attachment_id}"],
  "attachments.download": ["GET", "/api/attachments/{attachment_id}/content"],
  "attachments.limits": ["GET", "/api/attachments/limits/me"],
  "library.get": ["GET", "/api/library"],
  "library.search": ["GET", "/api/search"],
  "library.createFolder": ["POST", "/api/library/folders"],
  "library.updateFolder": ["PATCH", "/api/library/folders/{folder_id}"],
  "library.deleteFolder": ["DELETE", "/api/library/folders/{folder_id}"],
  "library.move": ["PUT", "/api/library/conversations/{conversation_id}/folder"],
  "library.createTag": ["POST", "/api/library/tags"],
  "library.deleteTag": ["DELETE", "/api/library/tags/{tag_id}"],
  "library.setTags": ["PUT", "/api/library/conversations/{conversation_id}/tags"],
  "shares.create": ["POST", "/api/conversations/{conversation_id}/share"],
  "shares.list": ["GET", "/api/conversations/{conversation_id}/shares"],
  "shares.listMine": ["GET", "/api/me/shares"],
  "shares.revoke": ["DELETE", "/api/shares/{share_id}"],
  "shares.view": ["GET", "/api/share/{token}"],
} as const satisfies Record<string, readonly ["GET" | "POST" | "PUT" | "PATCH" | "DELETE", string]>;

/** One part of a message: `text`, `reasoning`, `tool_call`, `tool_result`, `image`, `document` or `summary`. */
export interface MessagePart {
  type: string;
  text?: string;
  [field: string]: unknown;
}

/** The part a compaction's summary message carries. */
export interface SummaryPart extends MessagePart {
  type: "summary";
  text: string;
  covers_from: string;
  covers_to: string;
  tokens_before: number;
  tokens_after: number;
}

/**
 * One message of a conversation's tree. `parts` is the ordered list the
 * renderer maps to components; `content` is the same message flattened to
 * text. `parent_id` links the tree; siblings are branches.
 */
export interface ConversationMessage {
  id: string;
  conversation_id: string;
  role: "user" | "assistant" | "system" | (string & {});
  parts: MessagePart[];
  content: string;
  created_at: string;
  parent_id: string | null;
  model: string | null;
  truncated: boolean;
  /** Why the model stopped, on an assistant message: `length` when the token limit cut it. */
  finish_reason: string | null;
}

export interface Conversation {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  org_id: string | null;
  last_message_at: string | null;
  preview: string | null;
  message_count: number | null;
  default_model: string | null;
  current_leaf_message_id: string | null;
  pinned_at: string | null;
  archived_at: string | null;
  folder_id: string | null;
}

/**
 * A conversation with messages: the active path from `get`,
 * `setActiveLeaf` and `fork`, every message from `tree`. `tree` is added by
 * `get(id, { full: true })`; `instructions` by `get`.
 */
export interface ConversationWithMessages extends Conversation {
  messages: ConversationMessage[];
  tree?: ConversationMessage[];
  instructions?: Record<string, unknown>;
}

export type ConversationFilter = "default" | "all" | "pinned" | "archived";

export interface ConversationList {
  data: Conversation[];
  filter: ConversationFilter;
  /** Resumes the list after this page; null on the last one. */
  next_cursor: string | null;
}

export interface ListConversationsParams {
  /** `default` (unarchived, pinned first), `all`, `pinned` or `archived`. */
  filter?: ConversationFilter;
  /** Rows per page: 1 to 200, 50 when omitted. */
  limit?: number;
  /** A previous page's `next_cursor`. */
  cursor?: string;
}

/** A conversation a search matched, the headline around the match, and the message (null for a title match). */
export interface SearchHit extends Conversation {
  snippet: string;
  message_id: string | null;
}

/**
 * `GET /api/conversations/search`, and `GET /api/search` (`library.search`),
 * which pages: `next_cursor` fetches the page after this one and is null on
 * the last. The conversation search does not page and sends none.
 */
export interface SearchResults {
  data: SearchHit[];
  query: string;
  next_cursor?: string | null;
}

/**
 * How full the model's window is. `context_window` is null when the model's
 * size is unknown, `used_tokens` until a turn has been counted; `estimated`
 * is true when `used_tokens` is the latest summary's estimate rather than a
 * real count; `compactable` says whether a compaction has anything to fold.
 */
export interface ConversationContext {
  model: string;
  context_window: number | null;
  used_tokens: number | null;
  estimated: boolean;
  compactable: boolean;
}

export interface CreateConversationParams {
  title?: string | null;
  model?: string | null;
}

/**
 * What `conversations.update` changes. At least one field; a key left out
 * is left alone on the server.
 */
export interface UpdateConversationParams {
  /** The conversation's default model; `null` clears it back to the deployment's. */
  default_model?: string | null;
  /** The person's name for the conversation, 1-200 characters once trimmed. */
  title?: string;
}

export interface SendMessageParams {
  content: string;
  model?: string | null;
  temperature?: number | null;
  /** Attachments uploaded before the send, bound to this message. */
  attachment_ids?: string[];
  /** Send onto this branch instead of the current leaf. */
  parent_id?: string | null;
}

export interface EditMessageParams {
  content: string;
  model?: string | null;
  temperature?: number | null;
}

export interface RegenerateMessageParams {
  model?: string | null;
  temperature?: number | null;
}

/** `GET /api/me`: who the bearer acts as. A key acts as its owner. */
export interface Me {
  subject: string;
  kind: string;
  email: string | null;
  name: string | null;
  roles: string[];
  org_id: string | null;
  org_name: string | null;
  org_role: string | null;
  state?: string | null;
}

/**
 * What to show the person: open `verification_uri` and type `user_code`, or
 * open `verification_uri_complete`, which carries the code. `device_code` is
 * the client's half and is never shown.
 */
export interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

/** An approved device login. `access_token` is an ordinary API key: pass it as `apiKey` to a new client. */
export interface DeviceToken {
  token_type: "Bearer" | (string & {});
  access_token: string;
  scopes: string[];
}

/** The summary part when `message` is a compaction's summary message, else null. */
export function summaryOf(message: ConversationMessage): SummaryPart | null {
  const part = message.parts?.find((p) => p.type === "summary");
  return (part as SummaryPart | undefined) ?? null;
}
