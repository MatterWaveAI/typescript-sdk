/**
 * Walk cursor-paged lists without handling a cursor.
 *
 *     MATTERWAVE_BASE_URL=https://your-matterwave.example MATTERWAVE_API_KEY=mw_... \
 *         npx tsx examples/pagination.ts "invoice"
 *
 * `items()` (and `searchItems`) fetch the next page only when the loop
 * reaches it, so breaking out early fetches nothing more; `pages()` hands
 * over whole pages instead. `pagesOf` / `itemsOf` do the same walk for any
 * list that answers `{ data, next_cursor }`, given how to fetch one page
 * from a cursor.
 */

import { APIError, MatterWave, itemsOf, pagesOf } from "../src/index.js";
import { isMain, start, terminal, type Io } from "./io.js";

export async function run(client: MatterWave, query: string, io: Io = terminal): Promise<number> {
  try {
    let archived = 0;
    for await (const _conversation of client.conversations.items({ filter: "archived", limit: 100 })) archived += 1;
    io.write(`archived conversations: ${archived}\n`);

    let shown = 0;
    for await (const hit of client.library.searchItems(query, { limit: 20 })) {
      io.write(`match: ${hit.title}\n`);
      if ((shown += 1) === 5) break;
    }

    const pinned: string[] = [];
    for await (const conversation of itemsOf(pagesOf((cursor) => client.conversations.list({ filter: "pinned", cursor })))) {
      pinned.push(conversation.title);
    }
    io.write(`pinned: ${pinned.join(", ") || "none"}\n`);
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
    return run(new MatterWave(), process.argv.slice(2).join(" ") || "invoice");
  });
}
