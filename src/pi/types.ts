/**
 * TypeScript definitions for the Pi 1.0 (`@earendil-works/pi-coding-agent`)
 * provider configuration, extension API, and JSON-Lines (`--mode rpc`)
 * protocol commands and events.
 */

import type { AgentAvailabilityInput, DenyList } from "../agent/index.js";

/** Per-million-token pricing metadata for a Pi 1.0 model definition. */
export interface PiModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** A model entry inside `PiProviderConfig.models` for `pi.registerProvider(...)`. */
export interface PiModelDefinition {
  id: string;
  name: string;
  api?: "openai-completions" | "openai-responses" | "anthropic-messages" | (string & {});
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: PiModelCost;
  contextWindow: number;
  maxTokens: number;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
}

/** OAuth credentials persisted by Pi's credential store. */
export interface PiOAuthCredentials {
  refresh: string;
  access: string;
  expires: number;
  [key: string]: unknown;
}

/** Callbacks provided by Pi during `/login`. */
export interface PiOAuthLoginCallbacks {
  onAuth: (info: { url: string; instructions?: string }) => void;
  onPrompt: (prompt: { message: string; placeholder?: string }) => Promise<string>;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
}

/** OAuth configuration attached to a Pi provider. */
export interface PiProviderOAuthConfig {
  name: string;
  isSubscription?: boolean;
  login(callbacks: PiOAuthLoginCallbacks): Promise<PiOAuthCredentials>;
  refreshToken(credentials: PiOAuthCredentials, signal?: AbortSignal): Promise<PiOAuthCredentials>;
  getApiKey(credentials: PiOAuthCredentials): string;
}

/** Provider configuration expected by Pi 1.0's `pi.registerProvider("matterwave", config)`. */
export interface PiProviderConfig {
  name?: string;
  baseUrl: string;
  apiKey?: string;
  api: "openai-completions" | "openai-responses" | "anthropic-messages" | (string & {});
  headers?: Record<string, string>;
  authHeader?: boolean;
  models: PiModelDefinition[];
  oauth?: PiProviderOAuthConfig;
}

/** Options for `buildPiProviderConfig` and `createMatterWavePiExtension`. */
export interface MatterWavePiOptions {
  /** Active MatterWave preset ID (`X-MatterWave-Preset-Id`). */
  presetId?: string;
  /** Whether turns run in temporary mode (`X-MatterWave-Temporary`). */
  temporary?: boolean;
  /** Active MatterWave organisation ID (`X-MatterWave-Org-Id`). */
  orgId?: string;
  /** Explicit API key or env reference override (defaults to client's key or `$MATTERWAVE_API_KEY`). */
  apiKey?: string;
  /** Additional headers merged into the provider configuration. */
  headers?: Record<string, string>;
  /** Fallback models used when `client.models.list()` cannot reach the server. */
  fallbackModels?: PiModelDefinition[];
  /** Custom deny-list for the `tool_call` guardrail (defaults to `DEFAULT_DENY_LIST`). */
  deny?: DenyList;
  /** Workspace root path for path guardrails. */
  root?: string;
  /** Agent availability state or getter checked before tool execution. */
  availability?: AgentAvailabilityInput | (() => AgentAvailabilityInput);
}

/** Minimal UI surface available on Pi's `ExtensionContext`. */
export interface PiExtensionUI {
  notify?(message: string, type?: "info" | "warning" | "error"): void;
  setStatus?(key: string, text: string | undefined): void;
}

/** Context passed to Pi extension command and event handlers. */
export interface PiExtensionContext {
  ui?: PiExtensionUI;
  cwd?: string;
  isProjectTrusted?(): boolean;
  model?: { provider?: string; id?: string; [key: string]: unknown };
}

/** Tool call event emitted to `pi.on("tool_call", ...)`. */
export interface PiToolCallEvent {
  type: "tool_call";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  parentToolCallId?: string;
}

/** Result returned from a `tool_call` guardrail handler to block or allow execution. */
export interface PiToolCallResult {
  block?: boolean;
  reason?: string;
  terminate?: boolean;
}

/** Slash command registration options for `pi.registerCommand(name, options)`. */
export interface PiCommandOptions {
  description?: string;
  handler: (args: string, ctx: PiExtensionContext) => Promise<void> | void;
}

/** Minimal structural interface for Pi 1.0's `ExtensionAPI`. */
export interface PiExtensionAPI {
  registerProvider(name: string, config: PiProviderConfig): void;
  registerCommand(name: string, options: PiCommandOptions): void;
  on(
    event: "tool_call",
    handler: (
      event: PiToolCallEvent,
      ctx?: PiExtensionContext,
    ) => Promise<PiToolCallResult | void | undefined> | PiToolCallResult | void | undefined,
  ): (() => void) | void;
}

/** Pi 1.0 extension factory signature. */
export type PiExtensionFactory = (pi: PiExtensionAPI) => Promise<void>;

// --- Pi 1.0 JSON-Lines RPC protocol commands & events ------------------------

/** Commands sent over `stdin` in `pi --mode rpc` (JSON Lines). */
export type PiRpcCommand =
  | {
      id?: string;
      type: "prompt";
      message: string;
      images?: unknown[];
      streamingBehavior?: "steer" | "followUp";
    }
  | {
      id?: string;
      type: "steer";
      message: string;
      images?: unknown[];
    }
  | {
      id?: string;
      type: "follow_up";
      message: string;
      images?: unknown[];
    }
  | {
      id?: string;
      type: "abort";
    }
  | {
      id?: string;
      type: "new_session";
      parentSession?: string;
    }
  | {
      id?: string;
      type: "get_state";
    }
  | {
      id?: string;
      type: "set_model";
      provider: string;
      modelId: string;
    }
  | {
      id?: string;
      type: "get_messages";
    }
  | {
      id?: string;
      type: "compact";
      customInstructions?: string;
    };

/** Command type union for `PiRpcCommand`. */
export type PiRpcCommandType = PiRpcCommand["type"];

/** Session state returned by `get_state` in `pi --mode rpc`. */
export interface PiRpcSessionState {
  model?: { provider: string; id: string; [key: string]: unknown };
  thinkingLevel?: string;
  isStreaming: boolean;
  isCompacting: boolean;
  steeringMode?: "all" | "one-at-a-time";
  followUpMode?: "all" | "one-at-a-time";
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
  autoCompactionEnabled?: boolean;
  messageCount: number;
  pendingMessageCount: number;
  [key: string]: unknown;
}

/** Response frame emitted on `stdout` for a command in `pi --mode rpc`. */
export interface PiRpcResponseEvent<T = Record<string, unknown>> {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: T;
  error?: string;
}

/** Streaming delta payload inside a `message_update` RPC event. */
export interface PiRpcAssistantMessageDelta {
  type: string;
  delta?: string;
  contentIndex?: number;
  id?: string;
  toolName?: string;
  [key: string]: unknown;
}

/** Events emitted over `stdout` in `pi --mode rpc` (JSON Lines). */
export type PiRpcEvent =
  | {
      type: "agent_start";
      [key: string]: unknown;
    }
  | {
      type: "agent_end";
      messages?: unknown[];
      [key: string]: unknown;
    }
  | {
      type: "turn_start";
      turnIndex?: number;
      timestamp?: number;
      [key: string]: unknown;
    }
  | {
      type: "turn_end";
      turnIndex?: number;
      message?: unknown;
      toolResults?: unknown[];
      [key: string]: unknown;
    }
  | {
      type: "message_start";
      message: unknown;
      [key: string]: unknown;
    }
  | {
      type: "message_update";
      message?: unknown;
      assistantMessageEvent?: PiRpcAssistantMessageDelta;
      usage?: unknown;
      [key: string]: unknown;
    }
  | {
      type: "message_end";
      message: unknown;
      [key: string]: unknown;
    }
  | {
      type: "tool_execution_start";
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
      parentToolCallId?: string;
      [key: string]: unknown;
    }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
      partialResult: unknown;
      parentToolCallId?: string;
      [key: string]: unknown;
    }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError: boolean;
      durationMs?: number;
      parentToolCallId?: string;
      [key: string]: unknown;
    }
  | PiRpcResponseEvent;
