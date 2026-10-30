/**
 * Drive a MatterWave deployment through the SDK's own MCP wrapper,
 * `client.mcp`, mirroring the Python SDK's `examples/mcp_via_sdk.py`: list
 * the tools the key's scopes allow, start a conversation, send one message
 * (the wrapper waits out the whole model turn -- ten minutes, not the
 * client's 60 seconds), then search for it.
 *
 *     MATTERWAVE_BASE_URL=https://your-matterwave.example MATTERWAVE_API_KEY=mw_... \
 *         npx tsx examples/mcp-via-sdk.ts "pumpkin soup"
 *
 * To connect an *editor* instead -- Claude Desktop, VS Code, Cursor -- see
 * docs/mcp.md: editors speak the protocol themselves and need only the URL
 * and the key. This file is documentation first: it imports the SDK from
 * this repo's source and is checked with the compiler, but tsx is left to
 * the reader to install (`pnpm add -D tsx`).
 */

import { APIError, MatterWave, McpToolError } from "../src/index.js";

async function main(): Promise<number> {
  const baseUrl = (process.env.MATTERWAVE_BASE_URL ?? "http://localhost:8000").replace(/\/+$/, "");
  const apiKey = process.env.MATTERWAVE_API_KEY;
  if (!apiKey) {
    console.error("Set MATTERWAVE_API_KEY to a MatterWave API key.");
    return 2;
  }
  const question = process.argv.slice(2).join(" ") || "hello";
  const client = new MatterWave({ apiKey, baseUrl });
  try {
    const tools = await client.mcp.listTools();
    console.log("tools:", tools.map((tool) => tool.name).join(", "));

    const created = await client.mcp.callTool("create_conversation", {
      title: "From the MCP example",
    });
    const conversation = created.structured.conversation as { id: string };

    const answer = await client.mcp.sendMessage(
      conversation.id,
      `Answer in one sentence: ${question}`,
    );
    console.log("answer:", answer.text);

    const found = await client.mcp.callTool("search_conversations", {
      query: question,
      limit: 5,
    });
    console.log("searched:", found.structured.query);
    return 0;
  } catch (err) {
    if (err instanceof McpToolError) {
      // A tool that ran and refused: the budget, the plan, moderation.
      console.error(`refused: ${err.errorCode}: ${err.detail}`);
    } else if (err instanceof APIError) {
      // A refusal before any method ran: auth, the key's rate limit.
      console.error(`failed: ${err.status} ${err.code} ${err.requestId}`);
    } else {
      console.error(err);
    }
    return 1;
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
