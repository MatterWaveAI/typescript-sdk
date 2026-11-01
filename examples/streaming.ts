/**
 * Stream an answer as it is written, then report the whole completion.
 *
 *     MATTERWAVE_BASE_URL=https://your-matterwave.example MATTERWAVE_API_KEY=mw_... \
 *         npx tsx examples/streaming.ts "Write a haiku about rivers."
 *
 * Each chunk's text is printed as it arrives and fed to a
 * `ChatCompletionAccumulator`, which ends up holding what a non-streamed
 * call would have returned: the message, the finish reason and the usage
 * (the stream carries the usage because the call asks for it). A caller that
 * only wants the whole answer can skip the loop: `stream.finalCompletion()`.
 */

import { APIError, ChatCompletionAccumulator, MatterWave } from "../src/index.js";
import { isMain, start, terminal, type Io } from "./io.js";

export async function run(client: MatterWave, prompt: string, io: Io = terminal): Promise<number> {
  const accumulator = new ChatCompletionAccumulator();
  try {
    const stream = await client.chat.completions.create({
      messages: [{ role: "user", content: prompt }],
      stream: true,
      stream_options: { include_usage: true },
    });
    for await (const chunk of stream) {
      io.write(chunk.choices[0]?.delta.content ?? "");
      accumulator.add(chunk);
    }
  } catch (error) {
    if (!(error instanceof APIError)) throw error;
    io.error(`\nfailed: ${error.status} ${error.code} ${error.requestId}`);
    return 1;
  }
  const completion = accumulator.completion();
  io.write(
    `\n[${completion.choices[0]?.finish_reason}: ${completion.usage.prompt_tokens} in, ${completion.usage.completion_tokens} out]\n`,
  );
  return 0;
}

if (isMain(import.meta.url)) {
  start(async () => {
    if (!process.env.MATTERWAVE_API_KEY) {
      console.error("Set MATTERWAVE_API_KEY to a MatterWave API key.");
      return 2;
    }
    return run(new MatterWave(), process.argv.slice(2).join(" ") || "Write a haiku about rivers.");
  });
}
