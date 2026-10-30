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
  "conversations.delete": ["DELETE", "/api/conversations/{conversation_id}"],
  "conversations.pin": ["PUT", "/api/conversations/{conversation_id}/pin"],
  "conversations.unpin": ["DELETE", "/api/conversations/{conversation_id}/pin"],
  "conversations.archive": ["PUT", "/api/conversations/{conversation_id}/archive"],
  "conversations.unarchive": ["DELETE", "/api/conversations/{conversation_id}/archive"],
  "conversations.report": ["POST", "/api/conversations/{conversation_id}/report"],
  "conversations.updateInstructions": ["PUT", "/api/conversations/{conversation_id}/instructions"],
  "instructions.user": ["GET", "/api/me/instructions"],
  "instructions.updateUser": ["PUT", "/api/me/instructions"],
  "instructions.org": ["GET", "/api/org/instructions"],
  "instructions.updateOrg": ["PUT", "/api/org/instructions"],
  "messages.setFeedback": ["PUT", "/api/messages/{message_id}/feedback"],
  "messages.deleteFeedback": ["DELETE", "/api/messages/{message_id}/feedback"],
  "messages.listFeedback": ["GET", "/api/conversations/{conversation_id}/feedback"],
  "appModels": ["GET", "/api/models"],
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
  "budget.get": ["GET", "/api/budget"],
  "budget.setOverageCap": ["PUT", "/api/budget"],
  "budget.members": ["GET", "/api/budget/members"],
  "budget.setMemberDefaultCap": ["PUT", "/api/budget/members"],
  "budget.setMemberCap": ["PUT", "/api/budget/members/{subject}"],
  "notifications.list": ["GET", "/api/me/notifications"],
  "notifications.read": ["POST", "/api/me/notifications/{notification_id}/read"],
  "notifications.readAll": ["POST", "/api/me/notifications/read-all"],
  "announcements.list": ["GET", "/api/announcements"],
  "admin.announcements.list": ["GET", "/api/admin/announcements"],
  "admin.announcements.create": ["POST", "/api/admin/announcements"],
  "admin.announcements.update": ["PATCH", "/api/admin/announcements/{announcement_id}"],
  "admin.announcements.delete": ["DELETE", "/api/admin/announcements/{announcement_id}"],
  "entitlements.get": ["GET", "/api/entitlements"],
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
  /**
   * A temporary conversation is in no list or search, cannot be pinned,
   * shared, forked, filed or tagged (each a 409), and is hard-deleted a day
   * after its last message. Fixed at creation.
   */
  temporary?: boolean | null;
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
  /**
   * Ask the server not to keep the conversation: absent from every list
   * filter and both searches, refused by share/pin/fork/library with a 409
   * ("A temporary conversation is not kept, so it cannot be …"), and
   * hard-deleted 24 hours after its last message. Fixed at creation.
   */
  temporary?: boolean | null;
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

// --- what 0.2 added: lifecycle answers, instructions, feedback, the picker -----

/** The answer to `conversations.delete`. The row is purged after a 30-day delay; `attachments_deleted` counts the uploads it took with it, absent when there were none. */
export interface DeletedConversation {
  status: string;
  attachments_deleted?: number | null;
}

/** What the assistant should know about the person, and how they want answers shaped. `updateUser` replaces the pair, so a field left out is sent as empty. */
export interface UserInstructions {
  about: string;
  style: string;
}

/** The org's policy text, set by an owner or admin and prefixed to every member's turns. Reading it is admin-only as well as writing it. */
export interface OrgInstructions {
  text: string;
}

/**
 * The answer to `conversations.updateInstructions`: the conversation's id
 * and the levels now in force for it (`org`, `user`, `conversation`,
 * `user_overridden`, `effective`), as `get` reports them.
 */
export interface ConversationInstructions {
  conversation_id: string;
  instructions: Record<string, unknown>;
}

/** A thumbs up (`1`) or down (`-1`). */
export type FeedbackRating = 1 | -1;

/** The fixed vocabulary a rating's `reasons` may draw on; the free text is `comment`. The server refuses the rest. */
export const FEEDBACK_REASONS = [
  "wrong",
  "unhelpful",
  "incomplete",
  "too_long",
  "off_topic",
  "unsafe",
] as const;

export type FeedbackReason = (typeof FEEDBACK_REASONS)[number];

export interface SetFeedbackParams {
  rating: FeedbackRating;
  reasons?: FeedbackReason[];
  /** Enough to say what was wrong, not an essay: the server caps it. */
  comment?: string | null;
}

/** The caller's current opinion of one reply; a second rating replaces the first rather than piling up. */
export interface MessageFeedback {
  message_id: string;
  rating: number;
  reasons: string[];
  comment: string | null;
  created_at: string;
  updated_at: string;
}

/** The answer to `deleteFeedback`: `removed`, or `none` when there was already nothing there. */
export interface RemovedFeedback {
  status: string;
}

/** `GET /api/conversations/{id}/feedback`: the caller's own ratings in one conversation, in creation order, so the thumbs can be redrawn on reload. */
export interface MessageFeedbackList {
  data: MessageFeedback[];
}

// --- reports ------------------------------------------------------------------

/** What a report is about: `unsafe` routes to review, `unhelpful` to the product backlog. Most reports are the second kind, refusal complaints included. */
export const REPORT_KINDS = ["unsafe", "unhelpful"] as const;

export type ReportKind = (typeof REPORT_KINDS)[number];

/** The answer to `conversations.report` (201): the report's id, to quote to support. */
export interface ReportFiled {
  id: string;
  kind: ReportKind;
}

/** One row of the model picker: the model, what it costs, and the caller's plan's relationship to it. `supports_vision` is the one field the gateway may leave out. */
export interface AppModel {
  id: string;
  label: string;
  /** False for a model the plan does not cover: it stays listed, with `upgrade_to` naming the plan that has it, and a turn on it is refused server-side. */
  included: boolean;
  upgrade_to: string | null;
  partner: boolean;
  research_preview: boolean;
  supports_vision?: boolean | null;
  /** Null when the gateway did not say, rather than a guess. */
  context_window: number | null;
  multiplier: number;
  input_usd_per_m: number;
  output_usd_per_m: number;
}

/** `GET /api/models`: the picker's rows, narrowed to what the caller's org switched on, with `default_model` to preselect. */
export interface AppModelList {
  object: string;
  data: AppModel[];
  default_model: string | null;
}

// --- vision -------------------------------------------------------------------
//
// Whether the selected model can see an image, mirrored from the web app's
// vision.ts, which reads the same `GET /api/models` rows.

export type VisionVerdict = "yes" | "no" | "unknown";

/**
 * What the model list says about `modelId`.
 *
 * Gate BEFORE the upload: the point of the check is that the person learns
 * their screenshot will not be sent while they are still choosing the file,
 * not after they have waited out a 5 MB upload and a spinner. The server's
 * own 422 ("The model … does not accept image input") is the authority and
 * is not replaced by this -- it simply arrives too late to be good UX.
 *
 * `"no"` is the only refusing verdict. `modelId: null` (the picker's
 * "Default") is `"unknown"`, because which model that resolves to is the
 * server's business; a model absent from the list is `"unknown"`, not
 * `"no"`, because the picker and the gateway can disagree transiently and
 * that must not become a refusal; and `supports_vision: null` is
 * `"unknown"`, because a bare llama.cpp or vLLM build serves a model list
 * with nothing but `id` and treating silence as "no" would make attachments
 * dead there. The cost of a wrong "yes" is the upstream error the caller
 * would have got anyway; the cost of a wrong "no" is a capable model nobody
 * can use. Mirrors `vision.support_for` in the API.
 */
export function visionOf(models: readonly AppModel[] | null, modelId: string | null): VisionVerdict {
  if (modelId === null || models === null) return "unknown";
  const entry = models.find((model) => model.id === modelId);
  if (entry === undefined) return "unknown";
  if (entry.supports_vision === true) return "yes";
  if (entry.supports_vision === false) return "no";
  return "unknown";
}
