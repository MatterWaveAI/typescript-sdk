/**
 * The MatterWave deployment as an MCP client, mirroring the Python SDK's
 * `examples/mcp_client.py`: discover the server's MCP endpoint, list its
 * tools and call one, with an ordinary API key as the bearer.
 *
 *     MATTERWAVE_BASE_URL=https://your-matterwave.example MATTERWAVE_API_KEY=mw_... \
 *         npx tsx examples/mcp-client.ts "pumpkin soup"
 *
 * The only MatterWave-specific part is the bearer header, which is an
 * ordinary API key (Settings -> API keys).
 *
 * This file is documentation first: it is type-checked with the repo, not
 * wired into the build, and the `@modelcontextprotocol/sdk` import is
 * intentionally left to the reader to install (`pnpm add -D
 * @modelcontextprotocol/sdk tsx`).
 */

import Client from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

async function main(query: string): Promise<number> {
  const baseUrl = (process.env.MATTERWAVE_BASE_URL ?? "http://localhost:8000").replace(/\/+$/, "");
  const apiKey = process.env.MATTERWAVE_API_KEY;
  if (!apiKey) {
    console.error("Set MATTERWAVE_API_KEY to a MatterWave API key.");
    return 2;
  }
  const transport = new StreamableHTTPClientTransport(`${baseUrl}/mcp`, {
    requestInit: { headers: { Authorization: `Bearer ${apiKey}` } },
  });
  const client = new Client({ name: "matterwave-mcp-example", version: "0.2.0" });
  try {
    await client.connect(transport);
    console.log(`connected, protocol ${client.getServerVersion()?.protocolVersion ?? "?"}`);
    const { tools } = await client.listTools();
    console.log("tools:", tools.map((tool) => tool.name).join(", "));
    const result = await client.callTool({ name: "search_conversations", arguments: { query } });
    if (result.isError) {
      console.error("refused:", JSON.stringify(result.content));
      return 1;
    }
    for (const block of result.content) {
      if (block.type === "text") console.log(block.text);
    }
  } finally {
    await client.close();
  }
  return 0;
}

main(process.argv.slice(2).join(" ") || "hello").then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
