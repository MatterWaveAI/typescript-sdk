/**
 * The client and the exported OpenAPI document describe the same API.
 *
 * docs/developers/openapi.json is generated from the app by
 * scripts/export_openapi.py. Every operation this client exposes must be in
 * it with the same method and path, and every operation in it must be
 * exposed here; the request fields are held to the request schemas the same
 * way. Neither side can grow without the other noticing.
 *
 * The document is read from the platform checkout when this repo sits
 * inside it; a standalone checkout reads the snapshot in tests/openapi.json,
 * copied from the export. The /api routes are not in the export (it is the
 * `/v1` contract), so they are held to the API by the mocked-transport
 * tests instead.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  APP_OPERATIONS,
  CHAT_COMPLETION_REQUEST_FIELDS,
  CONVERSATION_EVENTS,
  EMBEDDINGS_REQUEST_FIELDS,
  MatterWave,
  OPERATIONS,
  frameFromEvent,
  isTerminal,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const MONOREPO = resolve(here, "../../../docs/developers/openapi.json");
const OPENAPI = existsSync(MONOREPO) ? MONOREPO : resolve(here, "openapi.json");

const CONVERSATION_STREAM = APP_OPERATIONS["conversations.send"]![1];
// A `part_start`'s `id` is the tool call's, and the frame carries the SSE
// `id:` under that name, so the call's is spelled `call_id`.
const RENAMED_FRAME_FIELDS: Record<string, string> = { "part_start.id": "call_id" };
const MESSAGE_SCHEMA = "#/components/schemas/ConversationMessage";

interface SSEEventDoc {
  description: string;
  data: { $ref?: string; oneOf?: { $ref: string }[] };
  terminal: boolean;
}

interface Document {
  paths: Record<string, Record<string, { operationId: string; security: Record<string, string[]>[] }>>;
  "x-sse-events": Record<string, { events: Record<string, SSEEventDoc> }>;
  components: {
    schemas: Record<string, { properties?: Record<string, unknown> }>;
    securitySchemes: Record<string, { scheme?: string }>;
  };
}

function refName(ref: string): string {
  return ref.slice(ref.lastIndexOf("/") + 1);
}

function load(): Document {
  return JSON.parse(readFileSync(OPENAPI, "utf-8")) as Document;
}

function exportedOperations(document: Document): Record<string, [string, string]> {
  const found: Record<string, [string, string]> = {};
  for (const [path, item] of Object.entries(document.paths)) {
    for (const [method, op] of Object.entries(item)) found[op.operationId] = [method.toUpperCase(), path];
  }
  return found;
}

describe("the exported OpenAPI document", () => {
  it("lists exactly the operations this client exposes, with the same method and path", () => {
    const exported = exportedOperations(load());
    const exposed = Object.fromEntries(
      Object.values(OPERATIONS).map((op) => [op.operationId, [op.method, op.path]]),
    );
    expect(exposed).toEqual(exported);
  });

  // The conversation, /api/me and device-login routes are the app's, not the
  // `/v1` contract, so the export does not carry them yet. Where it names one
  // of their paths the method must agree; until it names any, the check is
  // skipped rather than passing on nothing.
  const document = load();
  const named = Object.entries(APP_OPERATIONS).filter(([, [, path]]) => path in document.paths);
  it.skipIf(named.length === 0)("matches the app routes where the export names them", () => {
    for (const [key, [method, path]] of named) {
      expect(document.paths[path], `${key}: ${method} ${path}`).toHaveProperty(method.toLowerCase());
    }
  });

  it("names client methods that exist", () => {
    const client = new MatterWave({ apiKey: "k", baseUrl: "https://matterwave.test" });
    for (const dotted of Object.keys(OPERATIONS)) {
      let target: unknown = client;
      for (const part of dotted.split(".")) {
        expect(target, `client has no ${dotted}`).toHaveProperty(part);
        target = (target as Record<string, unknown>)[part];
      }
      expect(typeof target).toBe("function");
    }
  });

  it("the request schemas name exactly the fields the client types", () => {
    const schemas = load().components.schemas;
    expect(new Set(Object.keys(schemas.ChatCompletionRequest!.properties!))).toEqual(
      new Set(CHAT_COMPLETION_REQUEST_FIELDS),
    );
    expect(new Set(Object.keys(schemas.EmbeddingsRequest!.properties!))).toEqual(
      new Set(EMBEDDINGS_REQUEST_FIELDS),
    );
  });

  it("names exactly the conversation stream events this client types", () => {
    const events = load()["x-sse-events"][CONVERSATION_STREAM]!.events;
    expect(new Set(CONVERSATION_EVENTS)).toEqual(new Set(Object.keys(events)));
    for (const name of CONVERSATION_EVENTS) expect(frameFromEvent(name, {}).event).toBe(name);
    expect(frameFromEvent("not-an-event", {}).event).toBe("unknown");
  });

  it("marks terminal exactly the frames this client stops after", () => {
    const events = load()["x-sse-events"][CONVERSATION_STREAM]!.events;
    const documented = Object.entries(events).filter(([, e]) => e.terminal).map(([name]) => name);
    const typed = CONVERSATION_EVENTS.filter((name) => isTerminal(frameFromEvent(name, {})));
    expect(new Set(typed)).toEqual(new Set(documented));
  });

  it("each frame carries exactly the fields its event schema names", () => {
    const document = load();
    for (const [name, event] of Object.entries(document["x-sse-events"][CONVERSATION_STREAM]!.events)) {
      const ref = event.data.$ref!;
      // The message and done data is the message itself; the frame wraps it as `message`.
      const expected =
        ref === MESSAGE_SCHEMA
          ? ["message"]
          : Object.keys(document.components.schemas[refName(ref)]!.properties!).map(
              (p) => RENAMED_FRAME_FIELDS[`${name}.${p}`] ?? p,
            );
      const fields = Object.keys(frameFromEvent(name, {})).filter((k) => k !== "event" && k !== "id");
      expect(new Set(fields), name).toEqual(new Set(expected));
    }
  });

  it("documents the /v1 stream as chunks or an error envelope", () => {
    const v1 = load()["x-sse-events"][OPERATIONS["chat.completions.create"]!.path]!;
    expect(Object.keys(v1.events)).toEqual(["message"]);
    expect(new Set(v1.events.message!.data.oneOf!.map((alt) => refName(alt.$ref)))).toEqual(
      new Set(["ChatCompletionChunk", "ErrorEnvelope"]),
    );
  });

  it("the security scheme is a bearer and only the index is open", () => {
    const document = load();
    expect(document.components.securitySchemes.apiKey!.scheme).toBe("bearer");
    for (const [operationId, [method, path]] of Object.entries(exportedOperations(document))) {
      const op = document.paths[path]![method.toLowerCase()]!;
      if (operationId === "openai_index") expect(op.security).toEqual([]);
      else {
        expect(op.security).toHaveLength(1);
        expect(Object.keys(op.security[0]!)).toEqual(["apiKey"]);
        expect(op.security[0]!.apiKey).toHaveLength(1);
      }
    }
  });
});
