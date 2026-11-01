/**
 * One chat completion: a prompt in, the answer and its token count out.
 *
 *     MATTERWAVE_BASE_URL=https://your-matterwave.example MATTERWAVE_API_KEY=mw_... \
 *         npx tsx examples/chat.ts "Say hello in five words."
 */

import { APIError, MatterWave } from "../src/index.js";
import { isMain, start, terminal, type Io } from "./io.js";

export async function run(client: MatterWave, prompt: string, io: Io = terminal): Promise<number> {
  try {
    const completion = await client.chat.completions.create({ messages: [{ role: "user", content: prompt }] });
    io.write(`${completion.choices[0]?.message.content ?? ""}\n`);
    io.write(`[${completion.model}: ${completion.usage.total_tokens} tokens]\n`);
    return 0;
  } catch (error) {
    if (!(error instanceof APIError)) throw error;
    io.error(`failed: ${error.status} ${error.code} ${error.requestId}`);
    return 1;
  }
}

if (isMain(import.meta.url)) {
  start(async () => {
    if (!process.env.MATTERWAVE_API_KEY) {
      console.error("Set MATTERWAVE_API_KEY to a MatterWave API key.");
      return 2;
    }
    // MATTERWAVE_API_KEY and MATTERWAVE_BASE_URL.
    return run(new MatterWave(), process.argv.slice(2).join(" ") || "Say hello in five words.");
  });
}
