/**
 * The conversation stream's frames, typed.
 *
 * `POST /api/conversations/{id}/messages` (and `edit`, `regenerate`) answer
 * with named server-sent events, unlike `/v1`'s data-only chunks: each frame
 * is `event: <name>` and one `data:` line of JSON, with `id:` on the frames a
 * reconnect can resume after. A turn reads, in order:
 *
 *     (compaction | notice)?  message  title?  (part_start delta* part_end)*  context?  done
 *
 * `done` carries the saved assistant message; `error` and `moderation_block`
 * end a turn instead. An event this client does not know arrives as an
 * `UnknownFrame` rather than being dropped. Each frame is discriminated on
 * `event` and carries the SSE `id` it arrived with (null for most).
 */

import type { ConversationMessage } from "./conversation-types.js";

interface FrameBase {
  id: string | null;
}

/** The user message this turn appended (or the edited one), as saved. */
export interface MessageFrame extends FrameBase {
  event: "message";
  message: ConversationMessage;
}

/**
 * A part of the assistant message opens at `index`. `type` is `text`,
 * `reasoning`, `tool_call` or `tool_result`; a tool call carries `call_id`,
 * `name` and `arguments`, a result its `output` and `is_error`.
 */
export interface PartStartFrame extends FrameBase {
  event: "part_start";
  index: number;
  type: string;
  call_id: string | null;
  name: string | null;
  arguments: string | null;
  output: string | null;
  is_error: boolean;
}

/** Text for the open part at `index`: `content` for an answer, `reasoning` for a reasoning part. */
export interface DeltaFrame extends FrameBase {
  event: "delta";
  index: number;
  content: string | null;
  reasoning: string | null;
}

export interface PartEndFrame extends FrameBase {
  event: "part_end";
  index: number;
}

/** The conversation was named from this turn's first line. */
export interface TitleFrame extends FrameBase {
  event: "title";
  title: string;
}

/** The turn ended; `message` is the saved assistant message, `truncated` when cut short. */
export interface DoneFrame extends FrameBase {
  event: "done";
  message: ConversationMessage;
}

/** The turn failed after the 200: the upstream died, the budget is spent (`code` "budget"), or a resume found nothing. */
export interface ErrorFrame extends FrameBase {
  event: "error";
  detail: string;
  code: string | null;
}

/** MatterWave would not send this message to a model; a different fact from the model declining. */
export interface ModerationBlockFrame extends FrameBase {
  event: "moderation_block";
  detail: string;
  code: string | null;
  request_id: string | null;
}

/** Earlier messages were folded into `message`, a `system` message with one `summary` part. */
export interface CompactionFrame extends FrameBase {
  event: "compaction";
  message: ConversationMessage;
  covers_from: string | null;
  covers_to: string | null;
  tokens_before: number;
  tokens_after: number;
}

/**
 * The turn's real token counts, for a context meter. Each is null when the
 * server does not know it: `context_window` when the model's size is unknown,
 * the counts when the upstream reported no usage.
 */
export interface ContextFrame extends FrameBase {
  event: "context";
  prompt_tokens: number | null;
  completion_tokens: number | null;
  context_window: number | null;
}

/**
 * Something the person should be told that is not part of the answer:
 * `detail` is the sentence to show, `code` the machine reason (`compaction`
 * when the history could not be summarised).
 */
export interface NoticeFrame extends FrameBase {
  event: "notice";
  detail: string;
  code: string | null;
}

/** An event this client predates, kept as sent under its own `name`. */
export interface UnknownFrame extends FrameBase {
  event: "unknown";
  name: string;
  data: unknown;
}

export type ConversationFrame =
  | MessageFrame
  | PartStartFrame
  | DeltaFrame
  | PartEndFrame
  | TitleFrame
  | DoneFrame
  | ErrorFrame
  | ModerationBlockFrame
  | CompactionFrame
  | ContextFrame
  | NoticeFrame
  | UnknownFrame;

/**
 * Every event this client types, by its wire name. The contract test holds
 * this to the `x-sse-events` of docs/developers/openapi.json, so a frame the
 * server adds and a frame typed here have to land together.
 */
export const CONVERSATION_EVENTS = [
  "message",
  "part_start",
  "delta",
  "part_end",
  "title",
  "done",
  "error",
  "moderation_block",
  "compaction",
  "context",
  "notice",
] as const;

/** The frames after which the server sends nothing more for this turn. */
export function isTerminal(frame: ConversationFrame): boolean {
  return frame.event === "done" || frame.event === "error" || frame.event === "moderation_block";
}

function int(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) ? value : 0;
}

function optInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function optStr(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function message(value: unknown): ConversationMessage {
  return (typeof value === "object" && value !== null ? value : {}) as ConversationMessage;
}

/**
 * The typed frame for one event. `data` is the decoded JSON; a known event
 * whose data is not an object reads as an empty one.
 */
export function frameFromEvent(event: string, data: unknown, id: string | null = null): ConversationFrame {
  const d = (typeof data === "object" && data !== null && !Array.isArray(data) ? data : {}) as Record<
    string,
    unknown
  >;
  switch (event) {
    case "message":
      return { event, id, message: message(d) };
    case "part_start":
      return {
        event,
        id,
        index: int(d.index),
        type: String(d.type ?? ""),
        call_id: optStr(d.id),
        name: optStr(d.name),
        arguments: optStr(d.arguments),
        output: optStr(d.output),
        is_error: d.is_error === true,
      };
    case "delta":
      return { event, id, index: int(d.index), content: optStr(d.content), reasoning: optStr(d.reasoning) };
    case "part_end":
      return { event, id, index: int(d.index) };
    case "title":
      return { event, id, title: String(d.title ?? "") };
    case "done":
      return { event, id, message: message(d) };
    case "error":
      return { event, id, detail: String(d.detail ?? "The stream ended with an error."), code: optStr(d.code) };
    case "moderation_block":
      return {
        event,
        id,
        detail: String(d.detail ?? ""),
        code: optStr(d.code),
        request_id: optStr(d.request_id),
      };
    case "compaction":
      return {
        event,
        id,
        message: message(d.message),
        covers_from: optStr(d.covers_from),
        covers_to: optStr(d.covers_to),
        tokens_before: int(d.tokens_before),
        tokens_after: int(d.tokens_after),
      };
    case "context":
      return {
        event,
        id,
        prompt_tokens: optInt(d.prompt_tokens),
        completion_tokens: optInt(d.completion_tokens),
        context_window: optInt(d.context_window),
      };
    case "notice":
      return { event, id, detail: String(d.detail ?? ""), code: optStr(d.code) };
    default:
      return { event: "unknown", id, name: event, data };
  }
}
