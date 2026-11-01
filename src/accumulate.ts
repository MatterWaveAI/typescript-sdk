/**
 * The caller's half of a tool loop: a stream's chunks folded back into the
 * message they spell out, and the `tool` message that answers a call.
 */

import { MatterWaveError } from "./errors.js";
import type {
  AssistantMessage,
  ChatCompletion,
  ChatCompletionChunk,
  FinishReason,
  Message,
  ToolCall,
  Usage,
} from "./types.js";

interface PendingCall {
  id: string;
  type: "function";
  name: string;
  arguments: string;
}

/**
 * Folds a stream's chunks into the message they spell out: the text joined,
 * and each tool call put back together from its fragments. The first
 * fragment for an `index` carries the call's `id` and name, the rest carry
 * pieces of `arguments` to join in order; calls at different indexes may
 * interleave.
 *
 *     const acc = new ChatCompletionAccumulator();
 *     for await (const chunk of stream) {
 *       render(chunk.choices[0]?.delta.content ?? "");
 *       acc.add(chunk);
 *     }
 *     const message = acc.message(); // content and complete tool_calls
 *     const completion = acc.completion(); // the same, with finish reason and usage
 *
 * `stream.finalMessage()` and `stream.finalCompletion()` run that loop.
 */
export class ChatCompletionAccumulator {
  private text = "";
  private readonly calls = new Map<number, PendingCall>();
  finishReason: FinishReason | null = null;
  usage: Usage | null = null;
  model: string | null = null;
  id: string | null = null;
  created: number | null = null;

  add(chunk: ChatCompletionChunk): void {
    if (chunk.usage) this.usage = chunk.usage;
    if (chunk.model) this.model = chunk.model;
    if (chunk.id) this.id = chunk.id;
    if (chunk.created) this.created = chunk.created;
    const choice = chunk.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason !== null && choice.finish_reason !== undefined) this.finishReason = choice.finish_reason;
    const delta = choice.delta ?? {};
    if (delta.content) this.text += delta.content;
    for (const fragment of delta.tool_calls ?? []) {
      let call = this.calls.get(fragment.index);
      if (call === undefined) {
        call = { id: "", type: "function", name: "", arguments: "" };
        this.calls.set(fragment.index, call);
      }
      if (fragment.id) call.id = fragment.id;
      if (fragment.type) call.type = fragment.type;
      if (fragment.function?.name) call.name += fragment.function.name;
      if (fragment.function?.arguments) call.arguments += fragment.function.arguments;
    }
  }

  get content(): string {
    return this.text;
  }

  /** The calls so far, in index order, each with its arguments joined. */
  get toolCalls(): ToolCall[] {
    return [...this.calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call]) => ({ id: call.id, type: call.type, function: { name: call.name, arguments: call.arguments } }));
  }

  /**
   * The assistant message the stream spelled out, in the shape the next
   * request's `messages` takes; `content` is null on a pure tool-call turn,
   * as the non-streamed answer has it, and `tool_calls` is absent on a plain
   * answer.
   */
  message(): AssistantMessage {
    const calls = this.toolCalls;
    const content = this.text !== "" || calls.length === 0 ? this.text : null;
    return calls.length > 0 ? { role: "assistant", content, tool_calls: calls } : { role: "assistant", content };
  }

  /**
   * The whole answer in the shape a non-streamed `create` resolves to: the
   * message, its finish reason, the usage, the id and model. The usage is
   * all zeros when the stream carried none -- ask for it with
   * `stream_options: { include_usage: true }`. `MatterWaveError` when no
   * chunk carried a finish reason: the stream was cut short, so it is not a
   * whole answer.
   */
  completion(): ChatCompletion {
    if (this.finishReason === null) {
      throw new MatterWaveError("The stream ended without a finish reason, so it is not a whole completion.");
    }
    return {
      id: this.id ?? "",
      object: "chat.completion",
      created: this.created ?? 0,
      model: this.model ?? "",
      choices: [{ index: 0, message: this.message(), finish_reason: this.finishReason }],
      usage: this.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  }
}

/**
 * The `tool` message answering one call: its `id` as `tool_call_id` and the
 * result as text. A failed call is answered too, with the error as
 * `content`, so the model sees why rather than a gap.
 */
export function toolMessage(toolCallId: string, content: string): Message {
  if (!toolCallId) throw new TypeError("toolCallId must be the id of the call this answers");
  return { role: "tool", tool_call_id: toolCallId, content };
}
