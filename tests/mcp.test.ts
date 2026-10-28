import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  API_KEY,
  BASE_URL,
  REQUEST_ID,
  json,
  recordSleeps,
} from "./helpers.js";
import {
  B64_PREFIX,
  B64_SUFFIX,
  BadRequestError,
  DEFAULT_HANDSHAKE_VERSION,
  McpError,
  McpToolError,
  MatterWave,
  RateLimitError,
  SEND_MESSAGE_TIMEOUT_MS,
  nameHeader,
} from "../src/index.js";

/** The canned answers: method -> `{"result": ...}` or `{"error": ..., "status": 401}`. */
type Table = Record<string, { result?: Record<string, unknown>; error?: Record<string, unknown>; status?: number }>;

function mcpClient(table: Table) {
  const seen: { headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const fetch = vi.fn(async (_url: string, init: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    seen.push({ headers: { ...(init.headers as Record<string, string>) }, body });
    expect(body.jsonrpc).toBe("2.0");
    expect(typeof body.id).toBe("number");
    const payload = table[body.method as string] ?? {};
    if (payload.error !== undefined) {
      return json(
        { jsonrpc: "2.0", id: body.id, error: payload.error },
        payload.status ?? 200,
      );
    }
    return json({ jsonrpc: "2.0", id: body.id, result: payload.result ?? {} });
  });
  return {
    c: new MatterWave({ apiKey: API_KEY, baseUrl: BASE_URL, maxRetries: 2, fetch }),
    seen,
  };
}

function textResult(text: string, structured: Record<string, unknown>): Record<string, unknown> {
  return {
    content: [{ type: "text", text }],
    structuredContent: structured,
    isError: false,
  };
}

const TOOLS = {
  tools: [
    {
      name: "list_conversations",
      title: "List conversations",
      description: "One page of the user's conversations, most recent first.",
      inputSchema: {
        type: "object",
        properties: { filter: { type: "string", enum: ["default", "all", "pinned", "archived"] } },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    {
      name: "send_message",
      title: "Send a message",
      description: "Append a user message to a conversation and return MatterWave's answer.",
      inputSchema: {
        type: "object",
        properties: { conversation_id: { type: "string" }, content: { type: "string" } },
        required: ["conversation_id", "content"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
  ],
};

const HANDSHAKE = { initialize: { result: { protocolVersion: "2025-06-18", serverInfo: { name: "matterwave" } } } };

let restore: () => void;
beforeEach(() => {
  ({ restore } = recordSleeps());
});
afterEach(() => restore());

describe("the mcp wrapper, handshake era", () => {
  it("the handshake precedes the first call and is not repeated", async () => {
    const { c, seen } = mcpClient({ ...HANDSHAKE, "tools/list": { result: TOOLS } });
    const tools = await c.mcp.listTools();
    expect(tools.map((t) => t.name)).toEqual(["list_conversations", "send_message"]);
    expect(seen.map((s) => s.body.method)).toEqual(["initialize", "tools/list"]);
    const opened = seen[0]!.body;
    expect((opened.params as Record<string, unknown>).protocolVersion).toBe(DEFAULT_HANDSHAKE_VERSION);
    expect((opened.params as Record<string, unknown>).clientInfo).toMatchObject({ name: "matterwave-sdk" });
    // Statelessly stateful: the second call on the same wrapper speaks for itself.
    await c.mcp.listTools();
    expect(seen.at(-1)!.body.method).toBe("tools/list");
    expect(seen).toHaveLength(3);
  });

  it("an explicit initialize returns the server's answer", async () => {
    const { c, seen } = mcpClient({
      initialize: {
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "matterwave", title: "MatterWave", version: "1.0" },
          instructions: "MatterWave holds this user's chat conversations.",
        },
      },
    });
    const answer = await c.mcp.initialize({ protocol_version: "2025-11-25" });
    expect(answer.protocolVersion).toBe("2025-11-25");
    expect((answer.serverInfo as Record<string, unknown>).name).toBe("matterwave");
    // An explicit initialize always goes to the wire; it is the lazy one
    // inside callTool that fires once per version and then never again.
    expect(await c.mcp.initialize({ protocol_version: "2025-11-25" })).toEqual(answer);
    expect(seen).toHaveLength(2);
  });

  it("a version the server has never heard of is answered with its default", async () => {
    const { c, seen } = mcpClient({ initialize: { result: { protocolVersion: "2025-06-18" } } });
    // The server answers an unknown requested revision with 2025-06-18 and
    // decides; the wrapper relays whatever came back.
    const answer = await c.mcp.initialize({ protocol_version: "2025-03-26" });
    expect(answer.protocolVersion).toBe("2025-06-18");
    expect((seen[0]!.body.params as Record<string, unknown>).protocolVersion).toBe("2025-03-26");
  });

  it("listTools honours the key's scopes", async () => {
    // A read-only key is shown no write: the server's tools/list is already
    // filtered, and the wrapper relays the tools it names.
    const { c, seen } = mcpClient({
      ...HANDSHAKE,
      "tools/list": { result: { tools: [TOOLS.tools[0]] } },
    });
    const tools = await c.mcp.listTools();
    expect(tools.map((t) => t.name)).toEqual(["list_conversations"]);
    expect(tools[0]!.title).toBe("List conversations");
    expect((tools[0]!.inputSchema as { properties: { filter: { enum: string[] } } }).properties.filter.enum).toEqual([
      "default",
      "all",
      "pinned",
      "archived",
    ]);
    expect(tools[0]!.annotations.readOnlyHint).toBe(true);
    expect(seen.at(-1)!.body.method).toBe("tools/list");
  });

  it("callTool returns the text blocks and the structured content", async () => {
    const page = { conversations: [{ id: "c-1", title: "Plans" }], filter: "default", next_cursor: null };
    const { c, seen } = mcpClient({
      ...HANDSHAKE,
      "tools/call": {
        result: {
          content: [
            { type: "text", text: "- c-1 · Plans · 2 messages" },
            { type: "text", text: "More: call again with cursor." },
          ],
          structuredContent: page,
        },
      },
    });
    const got = await c.mcp.callTool("list_conversations", { filter: "default" });
    expect(got.text).toBe("- c-1 · Plans · 2 messagesMore: call again with cursor.");
    expect(got.structured).toEqual(page);
    expect(got.raw.structuredContent).toEqual(page);
    expect(seen.at(-1)!.body.params).toEqual({
      name: "list_conversations",
      arguments: { filter: "default" },
    });
  });

  it("a tool failure is a result that throws McpToolError", async () => {
    const { c, seen } = mcpClient({
      ...HANDSHAKE,
      "tools/call": {
        result: {
          isError: true,
          content: [{ type: "text", text: "The org is over its budget." }],
          structuredContent: {
            error: { code: "budget", detail: "The org is over its budget.", request_id: REQUEST_ID, status: 402 },
          },
        },
      },
    });
    const err = await c.mcp
      .callTool("send_message", { conversation_id: "c-1", content: "hi" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpToolError);
    const tool = err as McpToolError;
    expect(tool.tool).toBe("send_message");
    expect(tool.errorCode).toBe("budget");
    expect(tool.detail).toBe("The org is over its budget.");
    expect(tool.message).toBe("The org is over its budget.");
    expect(tool.requestId).toBe(REQUEST_ID);
    expect(tool.status).toBe(402);
    expect((tool.error as Record<string, unknown>).code).toBe("budget");
    // The call itself succeeded: the JSON-RPC layer answered 200 with a result.
    expect(seen.at(-1)!.body.method).toBe("tools/call");
  });

  it("a tool failure without a structured error still throws", async () => {
    const { c } = mcpClient({
      ...HANDSHAKE,
      "tools/call": { result: { isError: true, content: [{ type: "text", text: "Refused." }] } },
    });
    const err = (await c.mcp
      .callTool("send_message", { conversation_id: "c-1", content: "hi" })
      .catch((e: unknown) => e)) as McpToolError;
    expect(err.errorCode).toBe("tool_error");
    expect(err.detail).toBe("Refused.");
  });

  it("a JSON-RPC error in a 200 is an McpError", async () => {
    // The handshake era puts every JSON-RPC error in a 200.
    const { c } = mcpClient({
      ...HANDSHAKE,
      "tools/call": { error: { code: -32602, message: "Unknown tool: 'nope'" } },
    });
    const err = (await c.mcp.callTool("nope", {}).catch((e: unknown) => e)) as McpError;
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(-32602);
    expect(err.message).toContain("Unknown tool");
  });

  it("the key's rate limit is a JSON-RPC error with its HTTP status", async () => {
    const { c, seen } = mcpClient({
      "tools/call": {
        status: 429,
        error: {
          code: 429,
          message: "Rate limit of 60 requests per minute exceeded for this MCP client.",
          data: { status: 429, request_id: REQUEST_ID, retry_after_s: 30 },
        },
      },
    });
    const err = await c.mcp
      .callTool("list_conversations", {}, { protocol_version: "2026-07-28" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    const limit = err as RateLimitError;
    expect(limit.status).toBe(429);
    expect(limit.message.startsWith("Rate limit of 60 requests per minute")).toBe(true);
    expect(limit.requestId).toBe(REQUEST_ID);
    expect(seen.length).toBeGreaterThanOrEqual(1);
  });
});

describe("the mcp wrapper, modern era", () => {
  it("modern requests carry the envelope and the mirrored headers", async () => {
    const { c, seen } = mcpClient({ "tools/call": { result: textResult("ok", {}) } });
    await c.mcp.callTool("list_conversations", { filter: "all" }, { protocol_version: "2026-07-28" });
    expect(seen.map((s) => s.body.method)).toEqual(["tools/call"]);
    const meta = (seen[0]!.body.params as Record<string, Record<string, unknown>>)._meta!;
    expect(meta["io.modelcontextprotocol/protocolVersion"]).toBe("2026-07-28");
    expect("io.modelcontextprotocol/clientCapabilities" in meta).toBe(true);
    expect(seen[0]!.headers["MCP-Protocol-Version"]).toBe("2026-07-28");
    expect(seen[0]!.headers["Mcp-Method"]).toBe("tools/call");
    expect(seen[0]!.headers["Mcp-Name"]).toBe("list_conversations");
  });

  it("modern names that are not header-safe travel base64", () => {
    const header = nameHeader("konversation://über");
    expect(header.startsWith(B64_PREFIX) && header.endsWith(B64_SUFFIX)).toBe(true);
    expect(nameHeader("list_conversations")).toBe("list_conversations");
  });

  it("an unsupported modern version is refused with its status", async () => {
    const { c } = mcpClient({
      "tools/call": {
        status: 400,
        error: {
          code: -32022,
          message: "Unsupported protocol version",
          data: { supported: ["2026-07-28"], requested: "2026-01-01" },
        },
      },
    });
    const err = await c.mcp
      .callTool("list_conversations", {}, { protocol_version: "2026-01-01" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestError);
    expect((err as BadRequestError).status).toBe(400);
    expect((err as BadRequestError).message).toBe("Unsupported protocol version");
  });

  it("sendMessage returns the whole answer with the long timeout", async () => {
    const message = {
      id: "m-asst",
      role: "assistant",
      content: "One: coffee. Two: sugar. Three: cream.",
      created_at: "2026-10-27T09:00:00+00:00",
      model: "grt-nano",
      parent_id: "m-user",
      truncated: false,
    };
    const { c, seen } = mcpClient({
      ...HANDSHAKE,
      "tools/call": {
        result: textResult("One: coffee. Two: sugar. Three: cream.", {
          conversation_id: "c-1",
          message,
          title: "Shopping list",
          notices: ["Older messages may be cut."],
          truncated: false,
        }),
      },
    });
    const timers = vi.spyOn(globalThis, "setTimeout");
    const answer = await c.mcp.sendMessage("c-1", "Shopping list, please.", { model: "grt-nano" });
    const delays = timers.mock.calls.map(([, ms]) => ms);
    timers.mockRestore();
    expect(answer.conversation_id).toBe("c-1");
    expect(answer.text.startsWith("One: coffee.")).toBe(true);
    expect(answer.message && (answer.message as Record<string, unknown>).id).toBe("m-asst");
    expect(answer.title).toBe("Shopping list");
    expect(answer.notices).toEqual(["Older messages may be cut."]);
    expect(answer.truncated).toBe(false);
    const sent = seen.at(-1)!.body.params as Record<string, unknown>;
    expect(sent.name).toBe("send_message");
    expect(sent.arguments).toEqual({
      conversation_id: "c-1",
      content: "Shopping list, please.",
      model: "grt-nano",
    });
    // The one long tool gets the long timeout, not the client's 60s.
    expect(delays).toContain(SEND_MESSAGE_TIMEOUT_MS);
  });

  it("an empty protocol version is refused before the wire", async () => {
    const { c, seen } = mcpClient({ "tools/call": { result: textResult("ok", {}) } });
    await expect(c.mcp.callTool("list_conversations", {}, { protocol_version: "" })).rejects.toThrow(
      /non-empty/,
    );
    expect(seen).toHaveLength(0);
  });

  it("initialize refuses a modern version", async () => {
    const { c, seen } = mcpClient({});
    await expect(c.mcp.initialize({ protocol_version: "2026-07-28" })).rejects.toThrow(
      /handshake revisions/,
    );
    expect(seen).toHaveLength(0);
  });
});
