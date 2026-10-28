/**
 * The MCP client: MatterWave's `/mcp` endpoint, Streamable-HTTP JSON-RPC,
 * as `client.mcp`. It is the conversation API in a second wire format --
 * every tool is the same route the web app and the SDK reach -- so a script
 * or an agent can list and continue a person's conversations without
 * speaking the protocol itself.
 *
 *     const tools = await client.mcp.listTools();
 *     const answer = await client.mcp.sendMessage(id, "Draft an agenda.");
 *     console.log(answer.text);
 *
 * Two protocol eras share the endpoint, and `protocol_version` picks one.
 *
 * - The handshake revisions (`2025-03-26`, `2025-06-18`, `2025-11-25`; the
 *   default is `2025-06-18`): the wrapper opens with `initialize` once per
 *   version and answers with whatever the server echoes -- a version it has
 *   never heard of is answered with `2025-06-18`.
 * - The modern revision (`2026-07-28`): no handshake, no session; each
 *   request carries `params._meta` naming the protocol version and the
 *   client's capabilities, mirrored into `MCP-Protocol-Version`,
 *   `Mcp-Method` and `Mcp-Name` headers that must agree with the body.
 *
 * One POST per message, one JSON object back. Authentication is the
 * client's own API key as a bearer, and the per-key rate limit is the one
 * `/v1` has, so its 429 throws the ordinary `RateLimitError`. A refusal
 * before any method runs is likewise an `APIError` family member by HTTP
 * status. A tool that ran and refused is different: it arrives as a
 * *result* with `isError: true` and a `structuredContent.error`, and the
 * wrapper throws `McpToolError` so the reason (`budget`, `not_found`,
 * `upgrade_required`, `moderation`) is `errorCode` and the prose is
 * `detail`.
 */

import { MatterWaveConfigError, VERSION } from "./client.js";
import type { MatterWave, Prepared, RequestOptions } from "./client.js";
import { McpError, McpToolError } from "./errors.js";

/** The protocol's own `_meta` keys, as the server spells them. */
export const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
export const META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";

/** The handshake revisions, and the newest of them a client asking for something unknown is answered with. */
export const HANDSHAKE_VERSIONS: readonly string[] = ["2025-03-26", "2025-06-18", "2025-11-25"];
export const DEFAULT_HANDSHAKE_VERSION = "2025-06-18";
/** The per-request-envelope revisions: no handshake, `_meta` on every call. */
export const MODERN_VERSIONS: readonly string[] = ["2026-07-28"];

/** `Mcp-Name` values that are not header-safe travel base64-encoded between these markers, the same sentinels the server decodes. */
export const B64_PREFIX = "=?base64?";
export const B64_SUFFIX = "?=";

/** Methods whose named parameter is mirrored into `Mcp-Name`. */
const NAME_BEARING_METHODS: Record<string, string> = {
  "tools/call": "name",
  "resources/read": "uri",
};

/** `send_message` runs a whole model turn; the client's 60s default is not the right bound for it. */
export const SEND_MESSAGE_TIMEOUT_MS = 600_000;

/** `Mcp-Name` as the wire wants it: as-is when every byte is printable ASCII, base64 between the server's sentinels otherwise. */
export function nameHeader(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `${B64_PREFIX}${btoa(String.fromCharCode(...new TextEncoder().encode(value)))}${B64_SUFFIX}`;
}

/** One tool `tools/list` offers: the server only names the ones the key's scopes allow, so a read-only key is never shown a write. */
export interface McpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, unknown>;
}

/** A tool's answer: the text blocks joined, the structured content (`{}` when the tool sent none), and the raw result as it arrived. */
export interface McpToolResult {
  text: string;
  structured: Record<string, unknown>;
  raw: Record<string, unknown>;
}

/** `sendMessage` read the model's stream to its end. `text` is the whole answer; `message` is the saved assistant message; `notices` are the turn's asides; `truncated` says the token limit cut the answer. */
export interface SendMessageResult {
  conversation_id: string;
  text: string;
  message: Record<string, unknown> | null;
  title: string | null;
  notices: string[];
  truncated: boolean;
}

export interface CallToolParams {
  protocol_version?: string;
  /** The bound on this call alone; `send_message` needs the long one. */
  timeoutMs?: number;
}

export interface McpSendMessageParams {
  model?: string | null;
  protocol_version?: string;
  timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The JSON-RPC error object a response carried, as an exception. */
function rpcError(error: unknown): McpError {
  if (!isRecord(error)) return new McpError("The MCP endpoint answered with a malformed error.");
  return new McpError(String(error.message ?? "The MCP request failed."), {
    code: typeof error.code === "number" ? error.code : null,
    data: error.data,
  });
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter(isRecord)
    .filter((block) => block.type === "text")
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .join("");
}

function toolResult(name: string, result: Record<string, unknown>): McpToolResult {
  const structured = isRecord(result.structuredContent) ? result.structuredContent : {};
  const text = textOf(result.content);
  if (result.isError === true) {
    const error = isRecord(structured.error) ? structured.error : {};
    const detail =
      typeof error.detail === "string" && error.detail !== ""
        ? error.detail
        : text !== ""
          ? text
          : "The tool refused.";
    const code = error.code;
    throw new McpToolError(detail, {
      tool: name,
      errorCode: code === undefined || code === null ? "tool_error" : String(code),
      detail,
      requestId: typeof error.request_id === "string" ? error.request_id : null,
      status: typeof error.status === "number" ? error.status : null,
      error: Object.keys(error).length > 0 ? error : null,
    });
  }
  return { text, structured, raw: result };
}

export class Mcp {
  private readonly initialized = new Set<string>();
  private nextId = 1;

  constructor(private readonly client: MatterWave) {}

  /**
   * The handshake revision's opener: propose `protocolVersion`, get the
   * server's answer back -- its info, capabilities and instructions. The
   * server issues no session id and keeps no state, so there is nothing
   * here to hold either. A version the server has never heard of is
   * answered with `2025-06-18`.
   */
  async initialize(
    params: { protocol_version?: string } = {},
    options: RequestOptions = {},
  ): Promise<Record<string, unknown>> {
    const protocolVersion = params.protocol_version ?? DEFAULT_HANDSHAKE_VERSION;
    if (!HANDSHAKE_VERSIONS.includes(protocolVersion)) {
      throw new MatterWaveConfigError(
        `initialize speaks the handshake revisions ${HANDSHAKE_VERSIONS.join(", ")}, got ${protocolVersion}`,
      );
    }
    const result = await this.rpc(
      "initialize",
      { protocolVersion, capabilities: {}, clientInfo: { name: "matterwave-sdk", version: VERSION } },
      { protocolVersion },
      options,
    );
    this.initialized.add(protocolVersion);
    return result;
  }

  /** The tools this key may call: the server hides one whose scope the key lacks, so a `chat:read` key is shown no write and the model on the other side never plans on it. */
  async listTools(
    params: { protocol_version?: string } = {},
    options: RequestOptions = {},
  ): Promise<McpTool[]> {
    const result = await this.rpc("tools/list", {}, { protocolVersion: params.protocol_version ?? DEFAULT_HANDSHAKE_VERSION }, options);
    const tools = result.tools;
    if (!Array.isArray(tools)) return [];
    return tools.filter(isRecord).map((tool) => ({
      name: typeof tool.name === "string" ? tool.name : "",
      title: typeof tool.title === "string" ? tool.title : "",
      description: typeof tool.description === "string" ? tool.description : "",
      inputSchema: isRecord(tool.inputSchema) ? tool.inputSchema : {},
      annotations: isRecord(tool.annotations) ? tool.annotations : {},
    }));
  }

  /**
   * Run one tool. A refusal the *tool* decided on -- the budget, the plan,
   * a conversation that is not this tenant's -- throws `McpToolError`; a
   * refusal before the method ran (auth, the key's rate limit) throws the
   * ordinary `APIError` family by status.
   */
  async callTool(
    name: string,
    args: Record<string, unknown> = {},
    params: CallToolParams = {},
    options: RequestOptions = {},
  ): Promise<McpToolResult> {
    const protocolVersion = params.protocol_version ?? DEFAULT_HANDSHAKE_VERSION;
    const result = await this.rpc(
      "tools/call",
      { name, arguments: { ...args } },
      { protocolVersion, timeoutMs: params.timeoutMs, named: name },
      options,
    );
    return toolResult(name, result);
  }

  /** The one long tool: append the message and get the whole answer back, the model's stream read to its end. `timeoutMs` bounds that wait (ten minutes by default, not the client's 60s). */
  async sendMessage(
    conversationId: string,
    content: string,
    params: McpSendMessageParams = {},
    options: RequestOptions = {},
  ): Promise<SendMessageResult> {
    const args: Record<string, unknown> = { conversation_id: conversationId, content };
    if (params.model != null) args.model = params.model;
    const result = await this.callTool(
      "send_message",
      args,
      {
        protocol_version: params.protocol_version,
        timeoutMs: params.timeoutMs ?? SEND_MESSAGE_TIMEOUT_MS,
      },
      options,
    );
    const s = result.structured;
    return {
      conversation_id:
        typeof s.conversation_id === "string" && s.conversation_id !== "" ? s.conversation_id : conversationId,
      text: result.text,
      message: isRecord(s.message) ? s.message : null,
      title: typeof s.title === "string" ? s.title : null,
      notices: Array.isArray(s.notices)
        ? s.notices.filter((n): n is string => typeof n === "string")
        : [],
      truncated: s.truncated === true,
    };
  }

  /** One JSON-RPC request in, its `result` out. */
  private async rpc(
    method: string,
    params: Record<string, unknown>,
    opts: { protocolVersion: string; timeoutMs?: number; named?: string },
    options: RequestOptions,
  ): Promise<Record<string, unknown>> {
    const protocolVersion = opts.protocolVersion;
    if (!protocolVersion) {
      throw new MatterWaveConfigError("protocol_version must be a non-empty revision string");
    }
    if (method !== "initialize" && HANDSHAKE_VERSIONS.includes(protocolVersion) && !this.initialized.has(protocolVersion)) {
      // Handshake era: the opener goes first, once per version, and its
      // answer is the server's business, not ours to keep.
      await this.initialize({ protocol_version: protocolVersion }, options);
    }
    const body = {
      jsonrpc: "2.0" as const,
      id: this.nextId++,
      method,
      params: this.withMeta(params, protocolVersion),
    };
    const prepared: Prepared = {
      method: "POST",
      path: "/mcp",
      body,
      keyed: true,
      stream: false,
      headers: this.headers(method, opts.named, protocolVersion),
      timeoutMs: opts.timeoutMs,
    };
    const payload = await this.client.json<Record<string, unknown>>(prepared, options);
    if ("error" in payload) {
      // The handshake era puts every JSON-RPC error in a 200; the modern
      // one gives them HTTP statuses the retry loop has already turned
      // into the APIError family.
      throw rpcError(payload.error);
    }
    return isRecord(payload.result) ? payload.result : {};
  }

  /** Modern era: every request is self-contained -- the protocol version and the client's capabilities ride in `_meta`, mirrored into the headers `headers` sets beside them. */
  private withMeta(params: Record<string, unknown>, protocolVersion: string): Record<string, unknown> {
    if (!MODERN_VERSIONS.includes(protocolVersion)) return params;
    const meta = { ...(isRecord(params._meta) ? params._meta : {}) };
    meta[META_PROTOCOL_VERSION] = protocolVersion;
    meta[META_CLIENT_CAPABILITIES] = {};
    return { ...params, _meta: meta };
  }

  private headers(
    method: string,
    named: string | undefined,
    protocolVersion: string,
  ): Record<string, string> | undefined {
    if (!MODERN_VERSIONS.includes(protocolVersion)) return undefined;
    const headers: Record<string, string> = {
      "MCP-Protocol-Version": protocolVersion,
      "Mcp-Method": method,
    };
    const key = NAME_BEARING_METHODS[method];
    if (key !== undefined && named !== undefined) headers["Mcp-Name"] = nameHeader(named);
    return headers;
  }
}
