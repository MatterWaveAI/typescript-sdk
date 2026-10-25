/**
 * A fetch stub in place of a server. Each test queues the responses it
 * wants, in order, and reads back the requests the client made.
 */

import { vi } from "vitest";
import { MatterWave, setSleep, type Fetch } from "../src/index.js";

export const BASE_URL = "https://matterwave.test";
export const API_KEY = "mw_test_key";
export const REQUEST_ID = "req-0123456789abcdef";

export interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  /** The body as passed to fetch: a FormData for an upload. */
  raw: unknown;
}

export type Answer = Response | Error | (() => Response | Error);

export function stubFetch(answers: Answer[]): { fetch: Fetch; seen: Seen[]; calls: () => number } {
  const seen: Seen[] = [];
  const queue = [...answers];
  const fetch = vi.fn(async (url: string, init: RequestInit): Promise<Response> => {
    seen.push({
      url,
      method: init.method ?? "GET",
      headers: { ...(init.headers as Record<string, string>) },
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      raw: init.body,
    });
    const next = queue.length > 1 ? queue.shift()! : queue[0]!;
    const answer = typeof next === "function" ? next() : next;
    if (answer instanceof Error) throw answer;
    return answer;
  });
  return { fetch, seen, calls: () => fetch.mock.calls.length };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "X-Request-Id": REQUEST_ID, ...headers },
  });
}

export function text(body: string, status: number, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "X-Request-Id": REQUEST_ID, ...headers } });
}

/** An SSE response delivered in the given byte chunks, so line splits land anywhere. */
export function sse(chunks: string[], headers: Record<string, string> = {}): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "X-Request-Id": REQUEST_ID, ...headers },
  });
}

export function client(fetch: Fetch, options: { maxRetries?: number; apiKey?: string | null } = {}): MatterWave {
  return new MatterWave({
    apiKey: options.apiKey === undefined ? API_KEY : options.apiKey,
    baseUrl: BASE_URL,
    maxRetries: options.maxRetries ?? 2,
    fetch,
  });
}

export function completionBody(content = "Hello there, friend of mine.") {
  return {
    id: "chatcmpl-01",
    object: "chat.completion",
    created: 1790621573,
    model: "grt-nano",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 41, completion_tokens: 9, total_tokens: 50 },
  };
}

/** One SSE frame the way routes_openai.py writes it: `data:` + one-line JSON. */
export function chunk(
  delta: Record<string, unknown> | null,
  finish: string | null = null,
  usage: Record<string, number> | null = null,
): string {
  const body: Record<string, unknown> = {
    id: "chatcmpl-01",
    object: "chat.completion.chunk",
    created: 1790621573,
    model: "grt-nano",
    choices: [],
  };
  if (delta !== null) body.choices = [{ index: 0, delta, finish_reason: finish }];
  if (usage !== null || delta === null) body.usage = usage;
  return `data: ${JSON.stringify(body)}\n\n`;
}

export function errorBody(message: string, type: string, code: string | null, param: string | null = null) {
  return { error: { message, type, param, code } };
}

/** Record every delay the client asks for, without waiting. */
export function recordSleeps(): { sleeps: number[]; restore: () => void } {
  const sleeps: number[] = [];
  const previous = setSleep(async (ms) => {
    sleeps.push(ms);
  });
  return { sleeps, restore: () => void setSleep(previous) };
}
