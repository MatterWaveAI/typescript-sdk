/**
 * Server-sent events, read the way the spec reads them: `event:`, `data:`
 * (several lines join with a newline) and `id:` fields, an event ended by a
 * blank line; comments and other fields skipped; a last event with no
 * trailing blank line still delivered. Bytes arrive in chunks that split
 * lines anywhere, so a partial line is carried across reads.
 */

/** One dispatched event: its name (`message` when the frame named none, as the spec has it), its joined data, and its `id:` if it had one. */
export interface SSEEvent {
  event: string;
  data: string;
  id: string | null;
}

/**
 * The `data:` of each event, for `/v1`, which names none: `sseEvents` with
 * the names dropped. One parser underneath, so the two streams cannot
 * disagree on a frame.
 */
export async function* sseDataFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  for await (const event of sseEvents(body)) yield event.data;
}

/**
 * Named events, for the conversation stream: `event:`, `data:` and `id:`
 * read per the spec, comments (the `: mw-heartbeat` every few seconds)
 * skipped.
 */
export async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<SSEEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let event = "";
  let data: string[] = [];
  let id: string | null = null;

  function dispatch(): SSEEvent | null {
    const out = data.length > 0 ? { event: event || "message", data: data.join("\n"), id } : null;
    event = "";
    data = [];
    id = null;
    return out;
  }

  function take(line: string): SSEEvent | null {
    if (line === "") return dispatch();
    if (line.startsWith(":")) return null;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    else if (field === "event") event = value;
    else if (field === "id" && !value.includes("\0")) id = value;
    return null;
  }

  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffered += decoder.decode(value, { stream: !done });
      let newline: number;
      while ((newline = buffered.search(/\r\n|\n|\r/)) !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + (buffered.startsWith("\r\n", newline) ? 2 : 1));
        const out = take(line);
        if (out) yield out;
      }
      if (done) break;
    }
    if (buffered !== "") {
      const out = take(buffered);
      if (out) yield out;
    }
    const last = dispatch();
    if (last) yield last;
  } finally {
    reader.releaseLock();
  }
}
