/**
 * Structured outputs: `client.chat.completions.parse({ schema })` --
 * create, then the answer's text as JSON, validated by the caller's zod
 * schema.
 */

import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { ParseError } from "../src/index.js";
import { client, completionBody, json, stubFetch } from "./helpers.js";

const PROMPT = { messages: [{ role: "user" as const, content: "parts" }] };

const Row = z.object({ name: z.string(), quantity: z.number().default(0) });
type Row = z.infer<typeof Row>;

interface MutableBody {
  choices: Array<{ message: Record<string, unknown> }>;
}

function rowBody(content: unknown) {
  const body = completionBody() as unknown as MutableBody;
  body.choices[0].message = {
    role: "assistant",
    content: typeof content === "string" ? content : JSON.stringify(content),
  };
  return json(body);
}

describe("chat.completions.parse", () => {
  it("a valid answer validates into the schema", async () => {
    const { fetch } = stubFetch([rowBody({ name: "bolt", quantity: 12 })]);
    const row = await client(fetch).chat.completions.parse({ ...PROMPT, schema: Row });
    expect(row).toEqual({ name: "bolt", quantity: 12 });
    expectTypeOf(row).toEqualTypeOf<Row>();
  });

  it("the request asks for a JSON object", async () => {
    const { fetch, seen } = stubFetch([rowBody({ name: "bolt" })]);
    await client(fetch).chat.completions.parse({ ...PROMPT, schema: Row });
    expect(seen[0]!.body).toHaveProperty("response_format", { type: "json_object" });
  });

  it("a caller-passed response_format wins", async () => {
    const { fetch, seen } = stubFetch([rowBody({ name: "bolt" })]);
    const response_format = { type: "json_schema" as const, json_schema: { name: "row", strict: true } };
    await client(fetch).chat.completions.parse({ ...PROMPT, schema: Row, response_format });
    expect(seen[0]!.body).toHaveProperty("response_format", response_format);
  });

  it("an answer that is not JSON is a ParseError", async () => {
    const { fetch } = stubFetch([rowBody("Here are the parts you asked for.")]);
    await expect(
      client(fetch).chat.completions.parse({ ...PROMPT, schema: Row }),
    ).rejects.toThrow(ParseError);
  });

  it("a tool call with no content is a ParseError", async () => {
    const body = completionBody() as unknown as MutableBody;
    body.choices[0].message = {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_0", type: "function", function: { name: "parts", arguments: "{}" } }],
    };
    const { fetch } = stubFetch([json(body)]);
    await expect(
      client(fetch).chat.completions.parse({ ...PROMPT, schema: Row }),
    ).rejects.toThrow(/no content to parse/);
  });

  it("a schema refusal throws the schema's own error", async () => {
    const { fetch } = stubFetch([rowBody({ quantity: 3 })]);
    const error = await client(fetch)
      .chat.completions.parse({ ...PROMPT, schema: Row })
      .catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(ParseError);
    expect((error as { issues?: unknown[] }).issues).toHaveLength(1);
  });
});
