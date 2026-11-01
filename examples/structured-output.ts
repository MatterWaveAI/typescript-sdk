/**
 * Ask for JSON and get it back validated: `chat.completions.parse` with a
 * zod schema.
 *
 *     MATTERWAVE_BASE_URL=https://your-matterwave.example MATTERWAVE_API_KEY=mw_... \
 *         npx tsx examples/structured-output.ts "pancakes"
 *
 * `parse` asks the model for a JSON object and validates the answer against
 * the schema; the value it resolves to is typed by the schema. A schema
 * failure throws zod's own error, which names the field the model got wrong.
 */

import { z } from "zod";
import { APIError, MatterWave, ParseError } from "../src/index.js";
import { isMain, start, terminal, type Io } from "./io.js";

export const Recipe = z.object({
  name: z.string(),
  minutes: z.number().int(),
  ingredients: z.array(z.string()),
});

export async function run(client: MatterWave, dish: string, io: Io = terminal): Promise<number> {
  const prompt =
    `Give a recipe for ${dish} as a JSON object with \`name\` (string), ` +
    "`minutes` (integer) and `ingredients` (list of strings).";
  try {
    const recipe = await client.chat.completions.parse({
      messages: [{ role: "user", content: prompt }],
      schema: Recipe,
    });
    io.write(`${recipe.name} (${recipe.minutes} min): ${recipe.ingredients.join(", ")}\n`);
    return 0;
  } catch (error) {
    if (error instanceof ParseError) {
      io.error(`the answer was not JSON: ${error.message}`);
      return 1;
    }
    if (error instanceof z.ZodError) {
      io.error(`the answer was JSON but not a recipe: ${error.issues.map((i) => i.path.join(".")).join(", ")}`);
      return 1;
    }
    if (error instanceof APIError) {
      io.error(`failed: ${error.status} ${error.code} ${error.requestId}`);
      return 1;
    }
    throw error;
  }
}

if (isMain(import.meta.url)) {
  start(async () => {
    if (!process.env.MATTERWAVE_API_KEY) {
      console.error("Set MATTERWAVE_API_KEY to a MatterWave API key.");
      return 2;
    }
    return run(new MatterWave(), process.argv.slice(2).join(" ") || "pancakes");
  });
}
