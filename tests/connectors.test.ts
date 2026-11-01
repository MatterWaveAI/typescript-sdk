/**
 * The org's presets and connections against the fake API, and a
 * conversation on a preset. Each test answers with the body the route sends
 * (routes_presets.py, routes_connectors.py, routes_slack.py,
 * routes_usage.py) and checks the request the client made and what came
 * back. Credentials go out on create and update and are never read back.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  APP_OPERATIONS,
  ConflictError,
  MatterWave,
  MatterWaveConfigError,
  PermissionDeniedError,
  ServerError,
} from "../src/index.js";
import type { Connection, CreateConnectionParams, Fetch, UpdateConnectionParams } from "../src/index.js";
import { BASE_URL, REQUEST_ID, client, json, stubFetch } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const DOCUMENT = JSON.parse(readFileSync(resolve(here, "openapi-full.json"), "utf-8")) as {
  paths: Record<string, Record<string, { parameters?: { name: string; in: string }[] }>>;
  components: { schemas: Record<string, { properties: Record<string, { enum?: string[] }> }> };
};

const PRESET_ID = "0193a8f2-0000-7000-8000-00000000p001";
const CONNECTION_ID = "0193a8f2-0000-7000-8000-00000000c001";
const ROUTE_ID = "0193a8f2-0000-7000-8000-00000000r001";
const IDENTITY_ID = "0193a8f2-0000-7000-8000-00000000i001";
const CONV = "c0ffee00-0000-4000-8000-000000000001";
const WHEN = "2026-11-01T09:00:00+00:00";
const SECRET = "xoxb-never-to-be-seen-again";

function person(fetch: Fetch): MatterWave {
  return new MatterWave({ accessToken: "person-token", baseUrl: BASE_URL, maxRetries: 0, fetch });
}

function route(s: { method: string; url: string }): string {
  return `${s.method} ${s.url.slice(BASE_URL.length)}`;
}

function presetBody(extra: Record<string, unknown> = {}) {
  return {
    id: PRESET_ID,
    name: "Support",
    description: "Answers in the support channel",
    model: "grt-nano",
    instructions: "Be brief.",
    tools: null,
    welcome_message: null,
    created_by: "u-1",
    created_at: WHEN,
    updated_at: WHEN,
    deleted_at: null,
    ...extra,
  };
}

function listingBody() {
  return {
    data: [presetBody()],
    tools: [{ name: "web_search", description: "Search the web." }],
    limits: { max_presets: 50, name_max_len: 80, description_max_len: 500, instructions_max_len: 4000, welcome_max_len: 2000 },
    can_manage: true,
  };
}

function connectionBody(extra: Record<string, unknown> = {}) {
  return {
    id: CONNECTION_ID,
    connector: "slack",
    display_name: "Acme Slack",
    status: "active",
    ingress_url: "https://app.example.test/api/hooks/slack/tok",
    config: { notify_events: ["budget.exhausted"] },
    external_workspace_id: "T0001",
    rate_limit_per_minute: 60,
    installed_by: "u-1",
    last_event_at: null,
    last_error: null,
    created_at: WHEN,
    updated_at: WHEN,
    ...extra,
  };
}

function routeBody(extra: Record<string, unknown> = {}) {
  return {
    id: ROUTE_ID,
    connection_id: CONNECTION_ID,
    external_channel_id: "C0001",
    channel_label: "#support",
    preset_id: PRESET_ID,
    preset_name: "Support",
    paying_subject: "u-1",
    enabled: true,
    created_by: "u-1",
    created_at: WHEN,
    updated_at: WHEN,
    ...extra,
  };
}

function identityBody(extra: Record<string, unknown> = {}) {
  return {
    id: IDENTITY_ID,
    connection_id: CONNECTION_ID,
    external_user_id: "U0001",
    display_name: "Ada",
    email: "ada@example.test",
    subject: null,
    status: "unmapped",
    mapped_by: "auto",
    created_at: WHEN,
    updated_at: WHEN,
    ...extra,
  };
}

function eventBody(id: string, outcome = "answered") {
  return {
    id,
    connection_id: CONNECTION_ID,
    external_event_id: `Ev${id}`,
    received_at: WHEN,
    kind: "mention",
    outcome,
    external_user_id: "U0001",
    external_channel_id: "C0001",
    conversation_id: CONV,
    paying_subject: "u-1",
    detail: null,
    updated_at: WHEN,
  };
}

describe("the route table", () => {
  it("names a method on the client for every preset and connection operation", () => {
    const names = Object.keys(APP_OPERATIONS).filter((name) => ["presets", "connections"].includes(name.split(".")[0]!));
    expect(names).toHaveLength(23);
    const c = new MatterWave({ apiKey: "k", baseUrl: BASE_URL });
    for (const dotted of names) {
      let target: unknown = c;
      for (const part of dotted.split(".")) {
        expect(target, `client has no ${dotted}`).toHaveProperty(part);
        target = (target as Record<string, unknown>)[part];
      }
      expect(typeof target, dotted).toBe("function");
    }
  });
});

describe("presets", () => {
  it("lists the presets with the tools, the limits and can_manage", async () => {
    const { fetch, seen } = stubFetch([json(listingBody())]);
    const listing = await client(fetch).presets.list();
    expect(route(seen[0]!)).toBe("GET /api/org/presets");
    expect(listing.data.map((p) => p.name)).toEqual(["Support"]);
    expect(listing.tools[0]!.name).toBe("web_search");
    expect(listing.limits.max_presets).toBe(50);
    expect(listing.can_manage).toBe(true);
    expect(listing.requestId).toBe(REQUEST_ID);
  });

  it("gets a deleted one", async () => {
    const { fetch } = stubFetch([json(presetBody({ deleted_at: WHEN, tools: [] }))]);
    const preset = await client(fetch).presets.get(PRESET_ID);
    expect([preset.deleted_at, preset.tools]).toEqual([WHEN, []]);
  });

  it("creates one with only what was given", async () => {
    const { fetch, seen } = stubFetch([json(presetBody({ tools: [] }), 201)]);
    await client(fetch).presets.create({ name: "Support", model: "grt-nano", instructions: "Be brief.", tools: [] });
    expect(seen[0]!.body).toEqual({ name: "Support", model: "grt-nano", instructions: "Be brief.", tools: [] });
  });

  it("sends null for tools and the welcome message only when given", async () => {
    const { fetch, seen } = stubFetch([() => json(presetBody())]);
    const c = client(fetch);
    await c.presets.update(PRESET_ID, { tools: null, welcome_message: null });
    await c.presets.update(PRESET_ID, { name: "Helpdesk" });
    expect(seen.map((s) => s.body)).toEqual([{ tools: null, welcome_message: null }, { name: "Helpdesk" }]);
    expect(route(seen[0]!)).toBe(`PATCH /api/org/presets/${PRESET_ID}`);
  });

  it("refuses an empty update and a blank name before the request", () => {
    const { fetch, calls } = stubFetch([json({})]);
    const c = client(fetch);
    expect(() => c.presets.update(PRESET_ID, {})).toThrow(/update needs one of name/);
    expect(() => c.presets.create({ name: " ", model: "grt-nano" })).toThrow(MatterWaveConfigError);
    expect(calls()).toBe(0);
  });

  it("a taken name is a conflict, and delete is a 204", async () => {
    const { fetch, seen } = stubFetch([
      json({ detail: "This organisation already has a preset named 'Support'." }, 409),
      new Response(null, { status: 204 }),
    ]);
    const c = client(fetch);
    await expect(c.presets.create({ name: "support", model: "grt-nano" })).rejects.toBeInstanceOf(ConflictError);
    await c.presets.delete(PRESET_ID);
    expect(route(seen[1]!)).toBe(`DELETE /api/org/presets/${PRESET_ID}`);
  });
});

describe("a conversation on a preset", () => {
  const conversation = (extra: Record<string, unknown> = {}) => ({
    id: CONV,
    title: "New chat",
    created_at: WHEN,
    updated_at: WHEN,
    preset_id: PRESET_ID,
    preset: { id: PRESET_ID, name: "Support" },
    source: null,
    ...extra,
  });

  it("is created on a preset, and a null preset is left out", async () => {
    const { fetch, seen } = stubFetch([() => json(conversation(), 201)]);
    const c = client(fetch);
    const created = await c.conversations.create({ preset_id: PRESET_ID });
    await c.conversations.create({ title: "Plain", preset_id: null });
    expect(seen.map((s) => s.body)).toEqual([{ preset_id: PRESET_ID }, { title: "Plain" }]);
    expect(created.preset).toEqual({ id: PRESET_ID, name: "Support" });
  });

  it("is put on a preset and taken off with null", async () => {
    const { fetch, seen } = stubFetch([() => json(conversation({ preset_id: null, preset: null }))]);
    const c = client(fetch);
    const off = await c.conversations.update(CONV, { preset_id: null });
    await c.conversations.update(CONV, { preset_id: PRESET_ID });
    expect(seen.map((s) => s.body)).toEqual([{ preset_id: null }, { preset_id: PRESET_ID }]);
    expect(off.preset).toBeNull();
    expect(() => c.conversations.update(CONV, {})).toThrow(/or a preset_id/);
  });
});

describe("connections", () => {
  it("lists them with the vocabularies, for a person's token", async () => {
    const { fetch, seen } = stubFetch([
      json({
        data: [connectionBody()],
        connectors: ["slack"],
        notifiable_events: ["budget.exhausted"],
        outcomes: ["accepted", "answered", "duplicate"],
        identity_statuses: ["mapped", "unmapped", "guest", "blocked"],
      }),
    ]);
    const listed = await person(fetch).connections.list();
    expect(seen[0]!.headers.Authorization).toBe("Bearer person-token");
    expect(listed.data[0]!.config).toEqual({ notify_events: ["budget.exhausted"] });
    expect([listed.connectors, listed.outcomes[1], listed.identity_statuses[3]]).toEqual([["slack"], "answered", "blocked"]);
  });

  it("creates a pending one with no credentials", async () => {
    const { fetch, seen } = stubFetch([json(connectionBody({ status: "pending", external_workspace_id: null }), 201)]);
    const created = await person(fetch).connections.create({ connector: "slack", display_name: "Acme Slack" });
    expect(seen[0]!.body).toEqual({ connector: "slack", display_name: "Acme Slack" });
    expect(created.status).toBe("pending");
  });

  it("sends the credentials in and never hands them back", async () => {
    // The answers carry them here, as a server that leaked them would.
    const leaked = connectionBody({ credentials: { bot_token: SECRET } });
    const { fetch, seen } = stubFetch([
      json(leaked, 201),
      json(leaked),
      json(leaked),
      json(leaked),
      json({ data: [leaked], connectors: [], notifiable_events: [], outcomes: [], identity_statuses: [] }),
    ]);
    const c = person(fetch);
    const credentials = { bot_token: SECRET, signing_secret: "s3cr3t" };
    const created = await c.connections.create({
      connector: "slack",
      display_name: "Acme Slack",
      credentials,
      rate_limit_per_minute: 60,
    });
    const answers = [
      created,
      await c.connections.update(CONNECTION_ID, { credentials }),
      await c.connections.get(CONNECTION_ID),
      await c.connections.rotateUrl(CONNECTION_ID),
      ...(await c.connections.list()).data,
    ];
    expect((seen[0]!.body as { credentials: unknown }).credentials).toEqual(credentials);
    expect(seen[1]!.body).toEqual({ credentials });
    for (const answer of answers) {
      expect(answer).not.toHaveProperty("credentials");
      expect(JSON.stringify(answer)).not.toContain(SECRET);
    }
    expect(created.requestId).toBe(REQUEST_ID);
    expectTypeOf<Connection>().not.toHaveProperty("credentials");
    expectTypeOf<CreateConnectionParams>().toHaveProperty("credentials");
    expectTypeOf<UpdateConnectionParams>().toHaveProperty("credentials");
  });

  it("updates the status, the rate limit and the config", async () => {
    const { fetch, seen } = stubFetch([json(connectionBody({ status: "disabled", rate_limit_per_minute: 10 }))]);
    const updated = await person(fetch).connections.update(CONNECTION_ID, {
      status: "disabled",
      rate_limit_per_minute: 10,
      config: { notify_events: [] },
    });
    expect(seen[0]!.body).toEqual({ status: "disabled", rate_limit_per_minute: 10, config: { notify_events: [] } });
    expect(updated.status).toBe("disabled");
  });

  it("refuses what the route would before the request", () => {
    const { fetch, calls } = stubFetch([json({})]);
    const c = person(fetch);
    // @ts-expect-error -- revoked is the provider's to set
    expect(() => c.connections.update(CONNECTION_ID, { status: "revoked" })).toThrow(/status must be one of active, disabled/);
    expect(() => c.connections.create({ connector: "slack", display_name: "x", rate_limit_per_minute: 0 })).toThrow(
      /rate_limit_per_minute must be 1 to 10000/,
    );
    expect(() => c.connections.create({ connector: "slack", display_name: "x", credentials: {} })).toThrow(
      /credentials must name at least one field/,
    );
    expect(() => c.connections.update(CONNECTION_ID, {})).toThrow(/update needs one of display_name/);
    expect(calls()).toBe(0);
  });

  it("gets, deletes and rotates the URL", async () => {
    const { fetch, seen } = stubFetch([
      json(connectionBody()),
      json(connectionBody({ ingress_url: "https://app.example.test/api/hooks/slack/new" })),
      new Response(null, { status: 204 }),
    ]);
    const c = person(fetch);
    expect((await c.connections.get(CONNECTION_ID)).rate_limit_per_minute).toBe(60);
    expect((await c.connections.rotateUrl(CONNECTION_ID)).ingress_url).toMatch(/\/slack\/new$/);
    await c.connections.delete(CONNECTION_ID);
    expect(seen.map(route)).toEqual([
      `GET /api/org/connections/${CONNECTION_ID}`,
      `POST /api/org/connections/${CONNECTION_ID}/rotate-url`,
      `DELETE /api/org/connections/${CONNECTION_ID}`,
    ]);
  });

  it("reads the Slack manifest for one connection", async () => {
    const { fetch, seen } = stubFetch([
      json({
        connection_id: CONNECTION_ID,
        status: "pending",
        request_url: "https://app.example.test/api/hooks/slack/tok",
        publicly_reachable: true,
        manifest: { display_information: { name: "MatterWave" } },
        create_url: "https://api.slack.com/apps?new_app=1&manifest_json=...",
      }),
    ]);
    const manifest = await person(fetch).connections.slackManifest(CONNECTION_ID);
    expect(route(seen[0]!)).toBe(`GET /api/org/connections/slack/manifest?connection_id=${CONNECTION_ID}`);
    expect(manifest.publicly_reachable).toBe(true);
  });

  it("an API key gets the documented 403", async () => {
    const { fetch } = stubFetch([json({ detail: "Membership is managed by a person, not an API key." }, 403)]);
    await expect(client(fetch).connections.list()).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("a deployment without connectors is a ServerError naming the setting", async () => {
    const detail = "Connectors are not enabled on this deployment; set MW_CONNECTOR_SECRET_KEY.";
    const { fetch } = stubFetch([json({ detail }, 503)]);
    const error = await person(fetch).connections.list().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServerError);
    expect((error as ServerError).status).toBe(503);
    expect((error as ServerError).message).toContain("MW_CONNECTOR_SECRET_KEY");
    expect((error as ServerError).requestId).toBe(REQUEST_ID);
  });
});

describe("routes", () => {
  it("lists, creates, updates and deletes", async () => {
    const { fetch, seen } = stubFetch([
      json({ data: [routeBody()] }),
      json(routeBody(), 201),
      json(routeBody({ enabled: false, preset_name: null })),
      new Response(null, { status: 204 }),
    ]);
    const routes = person(fetch).connections.routes;
    expect((await routes.list(CONNECTION_ID)).data[0]!.channel_label).toBe("#support");
    await routes.create(CONNECTION_ID, { external_channel_id: "C0001", preset_id: PRESET_ID, paying_subject: "u-1", channel_label: "#support" });
    const updated = await routes.update(CONNECTION_ID, ROUTE_ID, { enabled: false });
    await routes.delete(CONNECTION_ID, ROUTE_ID);
    const base = `/api/org/connections/${CONNECTION_ID}/routes`;
    expect(seen.map(route)).toEqual([`GET ${base}`, `POST ${base}`, `PATCH ${base}/${ROUTE_ID}`, `DELETE ${base}/${ROUTE_ID}`]);
    expect(seen[1]!.body).toEqual({ external_channel_id: "C0001", preset_id: PRESET_ID, paying_subject: "u-1", channel_label: "#support" });
    expect(seen[2]!.body).toEqual({ enabled: false });
    expect([updated.enabled, updated.preset_name]).toEqual([false, null]);
    expect(() => routes.update(CONNECTION_ID, ROUTE_ID, {})).toThrow(/update needs one of channel_label/);
  });
});

describe("identities", () => {
  it("filters the list and sends each action's body", async () => {
    const mapped = identityBody({ subject: "u-2", status: "mapped", mapped_by: "manual" });
    const { fetch, seen } = stubFetch([json({ data: [identityBody()] }), () => json(mapped)]);
    const identities = person(fetch).connections.identities;
    expect((await identities.list(CONNECTION_ID, { status: "unmapped" })).data[0]!.email).toBe("ada@example.test");
    const answer = await identities.map(CONNECTION_ID, IDENTITY_ID, "u-2");
    await identities.unmap(CONNECTION_ID, IDENTITY_ID);
    await identities.block(CONNECTION_ID, IDENTITY_ID);
    await identities.unblock(CONNECTION_ID, IDENTITY_ID);
    expect(route(seen[0]!)).toBe(`GET /api/org/connections/${CONNECTION_ID}/identities?status=unmapped`);
    expect(route(seen[1]!)).toBe(`PATCH /api/org/connections/${CONNECTION_ID}/identities/${IDENTITY_ID}`);
    expect(seen.slice(1).map((s) => s.body)).toEqual([
      { action: "map", subject: "u-2" },
      { action: "unmap" },
      { action: "block" },
      { action: "unblock" },
    ]);
    expect([answer.subject, answer.mapped_by]).toEqual(["u-2", "manual"]);
  });

  it("finds one member's accounts across connections", async () => {
    const { fetch, seen } = stubFetch([json({ data: [identityBody({ connector: "slack", connection_name: "Acme Slack" })] })]);
    const rows = await person(fetch).connections.identities.forMember("u-2");
    expect(route(seen[0]!)).toBe("GET /api/org/connector-identities?subject=u-2");
    expect([rows.data[0]!.connector, rows.data[0]!.connection_name]).toEqual(["slack", "Acme Slack"]);
  });
});

describe("the event log", () => {
  it("filters by outcome and since", async () => {
    const { fetch, seen } = stubFetch([json({ data: [eventBody("e-1", "rate_limited")], next_cursor: null })]);
    const page = await person(fetch).connections.events.list(CONNECTION_ID, {
      outcome: "rate_limited",
      since: "2026-10-01T00:00:00+00:00",
      limit: 10,
    });
    const params = new URL(seen[0]!.url).searchParams;
    expect([params.get("outcome"), params.get("since"), params.get("limit")]).toEqual([
      "rate_limited",
      "2026-10-01T00:00:00+00:00",
      "10",
    ]);
    expect(page.data[0]!.outcome).toBe("rate_limited");
  });

  it("walks the cursor", async () => {
    const { fetch, seen } = stubFetch([
      json({ data: [eventBody("e-2")], next_cursor: "cur-1" }),
      json({ data: [eventBody("e-1")], next_cursor: null }),
    ]);
    const ids: string[] = [];
    for await (const event of person(fetch).connections.events.items(CONNECTION_ID, { outcome: "answered" })) ids.push(event.id);
    expect(ids).toEqual(["e-2", "e-1"]);
    const second = new URL(seen[1]!.url).searchParams;
    expect([second.get("cursor"), second.get("outcome")]).toEqual(["cur-1", "answered"]);
  });

  it("refuses a since without a zone and a limit out of range", () => {
    const events = person(stubFetch([json({})]).fetch).connections.events;
    expect(() => events.list(CONNECTION_ID, { since: "2026-10-01T00:00:00" })).toThrow(/since must carry a timezone/);
    expect(() => events.list(CONNECTION_ID, { limit: 201 })).toThrow(/limit must be 1 to 200/);
  });
});

describe("usage", () => {
  it("carries what each connection's turns cost", async () => {
    const { fetch } = stubFetch([
      json({
        period: "2026-11",
        period_start: "2026-11-01",
        period_end: "2026-12-01",
        unit: "weighted_tokens",
        scope: "org",
        data: [],
        by_connection: [
          {
            connection_id: CONNECTION_ID,
            connector: "slack",
            display_name: "Acme Slack",
            weighted_tokens: 1200,
            cost_micros: 3400,
            turns: 3,
            tokens: 900,
            last_active: WHEN,
          },
        ],
        totals: { weighted_tokens: 0, cost_micros: 0, turns: 0, tokens: 0 },
      }),
    ]);
    const usage = await client(fetch).usage.org({ period: "2026-11" });
    expect(usage.by_connection?.[0]?.cost_micros).toBe(3400);
  });
});

describe("the contract", () => {
  const properties = (schema: string) => Object.keys(DOCUMENT.components.schemas[schema]!.properties).sort();
  const queryOf = (path: string) =>
    (DOCUMENT.paths[path]!.get!.parameters ?? []).filter((p) => p.in === "query").map((p) => p.name).sort();

  it("a conversation names its preset in the document's bodies", () => {
    expect(properties("NewConversation")).toContain("preset_id");
    expect(properties("UpdateConversation")).toContain("preset_id");
  });

  it("each write sends exactly the fields its schema names when every one is given", async () => {
    const { fetch, seen } = stubFetch([() => json(presetBody())]);
    const c = person(fetch);
    const preset = { name: "n", description: "d", model: "m", instructions: "i", tools: [], welcome_message: "w" };
    await c.presets.create(preset);
    await c.presets.update(PRESET_ID, preset);
    const connection = { display_name: "n", rate_limit_per_minute: 1, config: {}, credentials: { k: "v" } };
    await c.connections.create({ connector: "slack", ...connection });
    await c.connections.update(CONNECTION_ID, { ...connection, status: "active" });
    const channel = { channel_label: "#x", preset_id: PRESET_ID, paying_subject: "u-1", enabled: true };
    await c.connections.routes.create(CONNECTION_ID, { external_channel_id: "C1", ...channel });
    await c.connections.routes.update(CONNECTION_ID, ROUTE_ID, channel);
    const sent = seen.map((s) => Object.keys(s.body as object).sort());
    expect(sent).toEqual(
      ["CreatePreset", "UpdatePreset", "CreateConnection", "UpdateConnection", "CreateRoute", "UpdateRoute"].map(properties),
    );
  });

  it("the identity actions are the ones the schema names", () => {
    const actions = DOCUMENT.components.schemas.UpdateIdentity!.properties.action!.enum!;
    const identities = new MatterWave({ apiKey: "k", baseUrl: BASE_URL }).connections.identities as unknown as Record<string, unknown>;
    expect([...actions].sort()).toEqual(["block", "map", "unblock", "unmap"]);
    for (const action of actions) expect(typeof identities[action]).toBe("function");
  });

  it("the reads take the query parameters the document names", () => {
    expect(queryOf("/api/org/connections/{connection_id}/events")).toEqual(["cursor", "limit", "outcome", "since"]);
    expect(queryOf("/api/org/connections/{connection_id}/identities")).toEqual(["status"]);
    expect(queryOf("/api/org/connections/slack/manifest")).toEqual(["connection_id"]);
    expect(queryOf("/api/org/connector-identities")).toEqual(["subject"]);
  });
});
