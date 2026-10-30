/**
 * @matterwave/sdk: the MatterWave API's OpenAI-compatible `/v1` surface,
 * typed, for Node 18+ and browsers.
 *
 *     import { MatterWave } from "@matterwave/sdk";
 *     const client = new MatterWave({ apiKey: "mw_...", baseUrl: "https://your-matterwave.example" });
 *
 * Both options default to `MATTERWAVE_API_KEY` and `MATTERWAVE_BASE_URL`.
 *
 * `client.conversations` is the app's own conversation API, streaming typed
 * frames; `client.auth.device` signs a person in by device code and returns
 * the key to use. `client.keys`, `client.usage`, `client.webhooks`,
 * `client.attachments`, `client.library`, `client.shares`, `client.budget`,
 * `client.notifications`, `client.announcements` and `client.entitlements`
 * are the app's native routes for the same, `client.admin` is the operator
 * surface (the platform `admin` role, not an API key's), and `client.mcp`
 * speaks the `/mcp` JSON-RPC endpoint (list tools, call one, send a
 * message).
 */

export {
  MatterWave,
  Chat,
  Completions,
  Embeddings,
  Models,
  Stream,
  MatterWaveConfigError,
  VERSION,
  API_KEY_ENV,
  BASE_URL_ENV,
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS,
  setSleep,
} from "./client.js";
export type { ClientOptions, Fetch, RequestOptions } from "./client.js";
export { Auth, Conversations, ConversationStream, DeviceAuth, Instructions, Messages, RESUME_PLACEHOLDER } from "./conversations.js";
export type { DeviceLoginOptions } from "./conversations.js";
export { APP_OPERATIONS, FEEDBACK_REASONS, REPORT_KINDS, summaryOf, visionOf } from "./conversation-types.js";
export { Mcp, B64_PREFIX, B64_SUFFIX, DEFAULT_HANDSHAKE_VERSION, HANDSHAKE_VERSIONS, META_CLIENT_CAPABILITIES, META_PROTOCOL_VERSION, MODERN_VERSIONS, SEND_MESSAGE_TIMEOUT_MS, nameHeader } from "./mcp.js";
export type { McpTool, McpToolResult, SendMessageResult, CallToolParams, McpSendMessageParams } from "./mcp.js";
export { Admin, AdminAnnouncements, Announcements, Attachments, BudgetClient, EntitlementsClient, Keys, LibraryClient, Notifications, Shares, UsageClient, Webhooks } from "./native.js";
export type {
  AdminAnnouncement,
  AdminAnnouncementList,
  Announcement,
  AnnouncementList,
  AnnouncementSeverity,
  ApiKey,
  ApiKeyList,
  ApiKeyWithSecret,
  Attachment,
  AttachmentLimits,
  Budget,
  ConversationTags,
  CreateAnnouncementParams,
  CreateKeyParams,
  CreateShareParams,
  CreateWebhookParams,
  CreatedShare,
  DailyUsage,
  DeliveryStatus,
  Entitlements,
  Folder,
  KeySettings,
  Library,
  LibrarySearchParams,
  MemberBudget,
  MemberBudgetList,
  MemberUsage,
  ModelUsage,
  Notification,
  NotificationList,
  NotificationListParams,
  OrgUsage,
  ReadAllNotifications,
  ReadNotification,
  SetMemberCapParams,
  SetMemberDefaultCapParams,
  SetOverageCapParams,
  Share,
  ShareList,
  SharedConversation,
  Tag,
  UpdateAnnouncementParams,
  UpdateFolderParams,
  UpdateKeyParams,
  UpdateWebhookParams,
  UploadAttachmentParams,
  UsageBalance,
  UsagePeriodParams,
  WebhookDelivery,
  WebhookDeliveryList,
  WebhookEndpoint,
  WebhookEndpointList,
  WebhookEndpointWithSecret,
} from "./native-types.js";
export type {
  AppModel,
  AppModelList,
  Conversation,
  ConversationContext,
  ConversationFilter,
  ConversationInstructions,
  ConversationList,
  ConversationMessage,
  ConversationWithMessages,
  CreateConversationParams,
  DeletedConversation,
  DeviceCode,
  DeviceToken,
  EditMessageParams,
  FeedbackReason,
  FeedbackRating,
  Me,
  MessageFeedback,
  MessageFeedbackList,
  MessagePart,
  OrgInstructions,
  RegenerateMessageParams,
  RemovedFeedback,
  ReportFiled,
  ReportKind,
  SearchHit,
  SearchResults,
  SendMessageParams,
  SetFeedbackParams,
  SummaryPart,
  UpdateConversationParams,
  UserInstructions,
  VisionVerdict,
} from "./conversation-types.js";
export { CONVERSATION_EVENTS, frameFromEvent, isTerminal } from "./frames.js";
export type {
  CompactionFrame,
  ContextFrame,
  ConversationFrame,
  DeltaFrame,
  DoneFrame,
  ErrorFrame,
  MessageFrame,
  ModerationBlockFrame,
  NoticeFrame,
  PartEndFrame,
  PartStartFrame,
  TitleFrame,
  UnknownFrame,
} from "./frames.js";
export { sseDataFrames, sseEvents } from "./sse.js";
export type { SSEEvent } from "./sse.js";
export {
  APIConnectionError,
  APIError,
  APITimeoutError,
  AuthenticationError,
  BadRequestError,
  ConflictError,
  DeviceAuthError,
  MatterWaveError,
  McpError,
  McpToolError,
  MissingAPIKeyError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  ServerError,
} from "./errors.js";
export type { APIErrorInit, RateLimit } from "./errors.js";
export {
  CHAT_COMPLETION_REQUEST_FIELDS,
  EMBEDDINGS_REQUEST_FIELDS,
  OPERATIONS,
} from "./types.js";
export type {
  ApiIndex,
  AssistantMessage,
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParams,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionRequest,
  Choice,
  ChunkChoice,
  ChunkDelta,
  ContentPart,
  Embedding,
  EmbeddingInput,
  EmbeddingList,
  EmbeddingUsage,
  EmbeddingsRequest,
  ErrorBody,
  ErrorEnvelope,
  FinishReason,
  FunctionCall,
  FunctionCallFragment,
  JsonSchemaSpec,
  Message,
  Metadata,
  Model,
  ModelList,
  Operation,
  ResponseFormat,
  Role,
  Stability,
  StreamOptions,
  Tool,
  ToolCall,
  ToolCallFragment,
  ToolChoice,
  ToolFunction,
  Usage,
  WithRequestId,
} from "./types.js";
