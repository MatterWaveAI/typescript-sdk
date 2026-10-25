/**
 * The wire types, spelled as the API spells them. Request fields keep their
 * OpenAI names (`max_tokens`, `stream_options`) so a body written for the
 * `openai` package can be passed through unchanged; the response types name
 * the fields the contract names and nothing more. Unknown fields the server
 * adds later are kept on the parsed object but not typed -- the `/v1`
 * promise is that additions ship without notice and clients tolerate them.
 */

export type Role = "system" | "user" | "assistant" | "tool";

export interface ContentPart {
  type: "text";
  text: string;
}

export interface FunctionCall {
  name: string;
  arguments: string;
}

/**
 * A call the model asked the caller to make. Run it, then send the result
 * back as a `tool` message carrying this `id` as `tool_call_id`.
 */
export interface ToolCall {
  id: string;
  type: "function";
  function: FunctionCall;
}

export interface Message {
  role: Role;
  content: string | ContentPart[] | null;
  /** On an assistant message: the calls it made, echoed back on the next turn. */
  tool_calls?: ToolCall[] | null;
  /** On a `tool` message: which call this is the result of. */
  tool_call_id?: string | null;
  name?: string | null;
}

export interface ToolFunction {
  name: string;
  description?: string | null;
  parameters?: Record<string, unknown> | null;
  strict?: boolean | null;
}

export interface Tool {
  type: "function";
  function: ToolFunction;
}

export type ToolChoice = "none" | "auto" | "required" | { type: "function"; function: { name: string } };

export interface JsonSchemaSpec {
  name: string;
  description?: string | null;
  schema?: Record<string, unknown> | null;
  strict?: boolean | null;
}

export type ResponseFormat =
  | { type: "text" }
  | { type: "json_object" }
  | { type: "json_schema"; json_schema: JsonSchemaSpec };

export interface StreamOptions {
  include_usage?: boolean;
}

export interface Metadata {
  /** Record the turn into this conversation of the key owner's. The request is still the whole prompt. */
  conversation_id?: string | null;
}

/** The body of `POST /v1/chat/completions`, field for field. */
export interface ChatCompletionRequest {
  messages: Message[];
  /** Omitted: the deployment's default model. */
  model?: string | null;
  stream?: boolean | null;
  stream_options?: StreamOptions | null;
  max_tokens?: number | null;
  max_completion_tokens?: number | null;
  temperature?: number | null;
  top_p?: number | null;
  stop?: string | string[] | null;
  n?: number | null;
  user?: string | null;
  /** Passed to the model as sent; a call comes back in `message.tool_calls` for the caller to run. */
  tools?: Tool[] | null;
  tool_choice?: ToolChoice | null;
  response_format?: ResponseFormat | null;
  metadata?: Metadata | null;
}

/**
 * Every field of `ChatCompletionRequest`, as a runtime list. The contract
 * test holds it equal to the request schema in docs/developers/openapi.json;
 * the `satisfies` below holds it equal to the interface, so the three cannot
 * drift apart silently.
 */
export const CHAT_COMPLETION_REQUEST_FIELDS = [
  "messages",
  "model",
  "stream",
  "stream_options",
  "max_tokens",
  "max_completion_tokens",
  "temperature",
  "top_p",
  "stop",
  "n",
  "user",
  "tools",
  "tool_choice",
  "response_format",
  "metadata",
] as const satisfies readonly (keyof ChatCompletionRequest)[];

type MissingFromFieldList = Exclude<
  keyof ChatCompletionRequest,
  (typeof CHAT_COMPLETION_REQUEST_FIELDS)[number]
>;
// A compile error here means a field was added to the interface and not the list.
const _everyRequestFieldIsListed: MissingFromFieldList extends never ? true : never = true;
void _everyRequestFieldIsListed;

export type ChatCompletionCreateParams = Omit<ChatCompletionRequest, "stream">;
export type ChatCompletionCreateParamsNonStreaming = ChatCompletionCreateParams & {
  stream?: false | null;
};
export type ChatCompletionCreateParamsStreaming = ChatCompletionCreateParams & { stream: true };

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/** `content` is null on a pure tool-call turn, as OpenAI shapes it. */
export interface AssistantMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: ToolCall[] | null;
}

/** `stop`, `length`, `tool_calls`, or whatever else the gateway reports. */
export type FinishReason = "stop" | "length" | "tool_calls" | (string & {});

export interface Choice {
  index: number;
  message: AssistantMessage;
  finish_reason: FinishReason;
}

export interface ChatCompletion {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Choice[];
  usage: Usage;
}

export interface FunctionCallFragment {
  name?: string;
  arguments?: string;
}

/**
 * One streamed piece of a tool call: the first for an `index` carries `id`,
 * `type` and the name, the rest carry `arguments` to concatenate in order.
 */
export interface ToolCallFragment {
  index: number;
  id?: string;
  type?: "function";
  function: FunctionCallFragment;
}

export interface ChunkDelta {
  role?: "assistant";
  content?: string;
  tool_calls?: ToolCallFragment[];
}

export interface ChunkChoice {
  index: number;
  delta: ChunkDelta;
  finish_reason: FinishReason | null;
}

/**
 * One `data:` frame of a streamed completion. The usage-only frame sent
 * with `stream_options.include_usage` has an empty `choices` and a `usage`.
 */
export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: ChunkChoice[];
  usage?: Usage | null;
}

export interface Model {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
}

export interface ModelList {
  object: "list";
  data: Model[];
}

export type EmbeddingInput = string | string[] | number[] | number[][];

/** The body of `POST /v1/embeddings`, field for field. */
export interface EmbeddingsRequest {
  input: EmbeddingInput;
  /** Omitted: the deployment's one embedding model. Naming a different one is a 404. */
  model?: string | null;
  encoding_format?: "float" | "base64" | null;
  dimensions?: number | null;
  user?: string | null;
}

/** Every field of `EmbeddingsRequest`; the contract test holds it equal to the schema. */
export const EMBEDDINGS_REQUEST_FIELDS = [
  "input",
  "model",
  "encoding_format",
  "dimensions",
  "user",
] as const satisfies readonly (keyof EmbeddingsRequest)[];

type MissingFromEmbeddingFields = Exclude<
  keyof EmbeddingsRequest,
  (typeof EMBEDDINGS_REQUEST_FIELDS)[number]
>;
const _everyEmbeddingFieldIsListed: MissingFromEmbeddingFields extends never ? true : never = true;
void _everyEmbeddingFieldIsListed;

export interface Embedding {
  object: "embedding";
  index: number;
  /** Floats, or a base64 string when the request asked for `encoding_format: "base64"`. */
  embedding: number[] | string;
}

export interface EmbeddingUsage {
  prompt_tokens: number;
  total_tokens: number;
}

/** One embedding per input, in input order. */
export interface EmbeddingList {
  object: "list";
  data: Embedding[];
  model: string;
  usage: EmbeddingUsage;
}

export interface Stability {
  stable: boolean;
  promise: string;
  preview_prefix: string;
}

/** `GET /v1`: what the API is and what it promises. Needs no key. */
export interface ApiIndex {
  object: "api";
  name: string;
  api_version: string;
  release: string;
  compatible_with: string;
  endpoints: string[];
  /** What the deployment can do (`chat_completions`, `embeddings`, ...); the server owns the keys. */
  capabilities: Record<string, unknown>;
  stability: Stability;
  extensions: Record<string, string>;
  docs: string;
}

export interface ErrorBody {
  message: string;
  type: string;
  param: string | null;
  code: string | null;
}

export interface ErrorEnvelope {
  error: ErrorBody;
}

/**
 * The `X-Request-Id` the response carried, attached to each parsed object
 * under a symbol-free name that cannot collide with a wire field.
 */
export type WithRequestId<T> = T & { readonly requestId: string | null };

/**
 * One method on the client, named the way the OpenAPI document names it.
 * The contract test compares this to docs/developers/openapi.json.
 */
export interface Operation {
  method: "GET" | "POST";
  path: string;
  operationId: string;
}

export const OPERATIONS = {
  index: { method: "GET", path: "/v1", operationId: "openai_index" },
  "models.list": { method: "GET", path: "/v1/models", operationId: "openai_list_models" },
  "models.retrieve": {
    method: "GET",
    path: "/v1/models/{model_id}",
    operationId: "openai_retrieve_model",
  },
  "chat.completions.create": {
    method: "POST",
    path: "/v1/chat/completions",
    operationId: "openai_chat_completions",
  },
  "embeddings.create": {
    method: "POST",
    path: "/v1/embeddings",
    operationId: "openai_embeddings",
  },
} as const satisfies Record<string, Operation>;
