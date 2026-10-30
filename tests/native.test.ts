/**
 * The native API clients against the fake API: keys, usage, webhooks,
 * attachments, library, shares, notifications, announcements and
 * entitlements. Each test answers with the body the route in api/matterwave
 * sends and checks the request the client made (method, path, query, body)
 * and what came back.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  APIError,
  APP_OPERATIONS,
  MatterWave,
  MatterWaveConfigError,
  NotFoundError,
  PermissionDeniedError,
  setSleep,
} from "../src/index.js";
import { API_KEY, BASE_URL, REQUEST_ID, client, json, stubFetch, text } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const ROUTES = resolve(here, "../../../api/matterwave");
const NATIVE = ["keys", "usage", "webhooks", "attachments", "library", "shares", "notifications", "announcements", "entitlements"];

const KEY_ID = "key-0001";
const ENDPOINT_ID = "whe-0001";
const DELIVERY_ID = "whd-0001";
const ATTACHMENT_ID = "att-0001";
const CONV = "c0ffee00-0000-4000-8000-000000000001";

function nativeOperations(): [string, readonly [string, string]][] {
  return Object.entries(APP_OPERATIONS).filter(([key]) => NATIVE.includes(key.split(".")[0]!));
}

/** Every (method, path) the app's routers declare, read from the source. The
 *  native routes live in the routes_* files, and notifications and
 *  announcements carry their own routers beside them. */
function apiRoutes(): Set<string> {
  const found = new Set<string>();
  const names = readdirSync(ROUTES).filter(
    (f) => /^routes_.*\.py$/.test(f) || f === "notifications.py" || f === "announcements.py",
  );
  for (const name of names) {
    const source = readFileSync(join(ROUTES, name), "utf-8");
    const prefixes = new Map<string, string>();
    for (const m of source.matchAll(/(\w+)\s*=\s*APIRouter\([^)]*prefix="([^"]*)"/g)) prefixes.set(m[1]!, m[2]!);
    for (const m of source.matchAll(/@(\w+)\.(get|post|put|patch|delete)\(\s*"([^"]*)"/g)) {
      found.add(`${m[2]!.toUpperCase()} ${(prefixes.get(m[1]!) ?? "") + m[3]!}`);
    }
  }
  return found;
}

describe("the native route table", () => {
  it("names a method on the client for every native operation", () => {
    const c = new MatterWave({ apiKey: "k", baseUrl: BASE_URL });
    for (const [dotted] of nativeOperations()) {
      let target: unknown = c;
      for (const part of dotted.split(".")) {
        expect(target, `client has no ${dotted}`).toHaveProperty(part);
        target = (target as Record<string, unknown>)[part];
      }
      expect(typeof target, dotted).toBe("function");
    }
  });

  it.skipIf(!existsSync(ROUTES))("names only routes the API declares", () => {
    const routes = apiRoutes();
    for (const [key, [method, path]] of nativeOperations()) {
      expect(routes.has(`${method} ${path}`), `${key}: ${method} ${path}`).toBe(true);
    }
  });
});

// --- keys -----------------------------------------------------------------------

function keyBody(extra: Record<string, unknown> = {}) {
  return {
    id: KEY_ID,
    prefix: "mw_ab12",
    name: "deploy",
    kind: "api",
    scopes: ["chat:read", "chat:write"],
    created_at: "2026-10-18T09:00:00+00:00",
    expires_at: null,
    revoked_at: null,
    last_used_at: null,
    rotated_at: null,
    previous_prefix: null,
    previous_valid_until: null,
    allowed_cidrs: null,
    rpm_limit: null,
    ...extra,
  };
}

describe("keys", () => {
  it("lists with the key and parses the rows", async () => {
    const { fetch, seen } = stubFetch([json({ data: [keyBody()] })]);
    const keys = await client(fetch).keys.list();
    expect(seen[0]!.method).toBe("GET");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/keys`);
    expect(seen[0]!.headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(keys.data[0]!.prefix).toBe("mw_ab12");
    expect(keys.requestId).toBe(REQUEST_ID);
  });

  it("creates with only what was given and returns the secret once", async () => {
    const { fetch, seen } = stubFetch([json(keyBody({ key: "mw_ab12_secret", rpm_limit: 30 }), 201)]);
    const key = await client(fetch).keys.create({
      name: "deploy",
      scopes: ["chat:read"],
      expires_in_days: 30,
      rpm_limit: 30,
      allowed_cidrs: undefined,
    });
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.body).toEqual({ name: "deploy", scopes: ["chat:read"], expires_in_days: 30, rpm_limit: 30 });
    expect(key.key).toBe("mw_ab12_secret");
  });

  it("refuses a nameless key and both expiries before the request", () => {
    const c = client(stubFetch([json({})]).fetch);
    expect(() => c.keys.create({ name: " " })).toThrow(MatterWaveConfigError);
    expect(() => c.keys.create({ name: "x", expires_in_days: 1, expires_at: "2027-01-01T00:00:00Z" })).toThrow(
      /not both/,
    );
  });

  it("updates in place, sending null to clear and leaving out what was not given", async () => {
    const { fetch, seen } = stubFetch([json(keyBody({ name: "renamed" }))]);
    const key = await client(fetch).keys.update(KEY_ID, { name: "renamed", expires_at: null, rpm_limit: undefined });
    expect(seen[0]!.method).toBe("PATCH");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/keys/${KEY_ID}`);
    expect(seen[0]!.body).toEqual({ name: "renamed", expires_at: null });
    expect(key.name).toBe("renamed");
  });

  it("refuses an update with nothing to change", () => {
    const c = client(stubFetch([json({})]).fetch);
    expect(() => c.keys.update(KEY_ID, {})).toThrow(/update needs one of/);
  });

  it("rotates: a new secret and the old one's grace window", async () => {
    const { fetch, seen } = stubFetch([
      json(
        keyBody({
          prefix: "mw_cd34",
          key: "mw_cd34_secret",
          previous_prefix: "mw_ab12",
          previous_valid_until: "2026-10-19T09:00:00+00:00",
        }),
      ),
    ]);
    const key = await client(fetch).keys.rotate(KEY_ID);
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/keys/${KEY_ID}/rotate`);
    expect(seen[0]!.raw).toBeUndefined();
    expect([key.key, key.previous_prefix]).toEqual(["mw_cd34_secret", "mw_ab12"]);
  });

  it("revokes with a DELETE answered 204", async () => {
    const { fetch, seen } = stubFetch([new Response(null, { status: 204 })]);
    await expect(client(fetch).keys.revoke(KEY_ID)).resolves.toBeUndefined();
    expect(seen[0]!.method).toBe("DELETE");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/keys/${KEY_ID}`);
  });

  it("a missing key is NotFoundError with the request id", async () => {
    const { fetch } = stubFetch([json({ detail: "No such API key" }, 404)]);
    const error = await client(fetch).keys.revoke(KEY_ID).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as NotFoundError).requestId).toBe(REQUEST_ID);
  });

  it("refuses an id that would change the path", () => {
    const c = client(stubFetch([json({})]).fetch);
    expect(() => c.keys.rotate("../usage")).toThrow(MatterWaveConfigError);
  });
});

// --- usage ----------------------------------------------------------------------

const BALANCE = {
  unit: "tokens",
  used: 850,
  included: 1000,
  remaining: 150,
  percent: 85.0,
  warn: true,
  in_overage: false,
  exhausted: false,
  period_start: "2026-10-01",
  resets_at: "2026-11-01T00:00:00+00:00",
  plan: { code: "team", name: "Team" },
  seats: null,
  overage: { enabled: false, spent_micros: 0, cap_micros: 0 },
  models: [],
  compaction: { weighted_tokens: 0, requests: 0 },
  history: [],
};

const ORG_USAGE = {
  period: "2026-10",
  period_start: "2026-10-01",
  period_end: "2026-11-01",
  unit: "tokens",
  scope: "self",
  data: [
    {
      subject: "user-1",
      email: "a@example.test",
      name: "A",
      weighted_tokens: 850,
      cost_micros: 1200,
      turns: 11,
      tokens: 567,
      last_active: "2026-10-18T09:00:00+00:00",
    },
  ],
  totals: { weighted_tokens: 850, cost_micros: 1200, turns: 11, tokens: 567 },
};

const CSV =
  "subject,email,name,weighted_tokens,tokens,cost_usd,turns,last_active\r\n" +
  "user-1,a@example.test,A,850,567,0.001200,11,2026-10-18T09:00:00+00:00\r\n";

describe("usage", () => {
  it("gets the balance", async () => {
    const { fetch, seen } = stubFetch([json(BALANCE)]);
    const balance = await client(fetch).usage.get();
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/me/usage`);
    expect([balance.used, balance.included, balance.warn]).toEqual([850, 1000, true]);
  });

  it("reads the per-member month for a period", async () => {
    const { fetch, seen } = stubFetch([json(ORG_USAGE)]);
    const report = await client(fetch).usage.org({ period: "2026-10" });
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/org/usage?period=2026-10`);
    expect(report.scope).toBe("self");
    expect(report.totals.cost_micros).toBe(1200);
  });

  it("exports the CSV as the text the server wrote", async () => {
    const { fetch, seen } = stubFetch([
      text(CSV, 200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="usage-2026-10.csv"',
      }),
    ]);
    expect(await client(fetch).usage.exportCsv({ period: "2026-10" })).toBe(CSV);
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/org/usage.csv?period=2026-10`);
    expect(seen[0]!.headers.Accept).toBe("text/csv");
  });

  it("exports this month when no period is given", async () => {
    const { fetch, seen } = stubFetch([text(CSV, 200)]);
    await client(fetch).usage.exportCsv();
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/org/usage.csv`);
  });

  it("a malformed period is the server's 422", async () => {
    const { fetch } = stubFetch([json({ detail: "period must look like 2026-10" }, 422)]);
    const error = await client(fetch)
      .usage.exportCsv({ period: "October" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(APIError);
    expect((error as APIError).message).toBe("period must look like 2026-10");
  });
});

// --- webhooks -------------------------------------------------------------------

function endpointBody(extra: Record<string, unknown> = {}) {
  return {
    id: ENDPOINT_ID,
    url: "https://hooks.example.test/mw",
    description: "",
    events: ["message.completed"],
    enabled: true,
    failure_count: 0,
    created_at: "2026-10-18T09:00:00+00:00",
    updated_at: "2026-10-18T09:00:00+00:00",
    disabled_at: null,
    ...extra,
  };
}

function deliveryBody(extra: Record<string, unknown> = {}) {
  return {
    id: DELIVERY_ID,
    endpoint_id: ENDPOINT_ID,
    event: "ping",
    event_id: "evt-1",
    payload: { type: "ping" },
    attempt: 1,
    status: "delivered",
    response_code: 200,
    response_ms: 41,
    response_excerpt: "ok",
    next_attempt_at: null,
    delivered_at: "2026-10-18T09:00:01+00:00",
    last_error: null,
    created_at: "2026-10-18T09:00:00+00:00",
    ...extra,
  };
}

describe("webhooks", () => {
  it("lists endpoints with the event vocabulary", async () => {
    const { fetch, seen } = stubFetch([json({ data: [endpointBody()], events: ["message.completed"] })]);
    const listed = await client(fetch).webhooks.list();
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/org/webhooks`);
    expect(listed.events).toEqual(["message.completed"]);
  });

  it("creates one and returns the secret once", async () => {
    const { fetch, seen } = stubFetch([
      json(endpointBody({ secret: "whsec_x", shown_once: true, verification: { python: "..." } }), 201),
    ]);
    const endpoint = await client(fetch).webhooks.create({
      url: "https://hooks.example.test/mw",
      events: ["message.completed"],
    });
    expect(seen[0]!.body).toEqual({ url: "https://hooks.example.test/mw", events: ["message.completed"] });
    expect(endpoint.secret).toBe("whsec_x");
  });

  it("refuses an endpoint with no events", () => {
    const c = client(stubFetch([json({})]).fetch);
    expect(() => c.webhooks.create({ url: "https://x.test", events: [] })).toThrow(/at least one event/);
  });

  it("gets, updates and deletes", async () => {
    const { fetch, seen } = stubFetch([
      json(endpointBody()),
      json(endpointBody({ enabled: false })),
      new Response(null, { status: 204 }),
    ]);
    const c = client(fetch);
    expect((await c.webhooks.get(ENDPOINT_ID)).id).toBe(ENDPOINT_ID);
    expect((await c.webhooks.update(ENDPOINT_ID, { enabled: false })).enabled).toBe(false);
    await c.webhooks.delete(ENDPOINT_ID);
    expect(seen.map((s) => `${s.method} ${s.url.slice(BASE_URL.length)}`)).toEqual([
      `GET /api/org/webhooks/${ENDPOINT_ID}`,
      `PATCH /api/org/webhooks/${ENDPOINT_ID}`,
      `DELETE /api/org/webhooks/${ENDPOINT_ID}`,
    ]);
    expect(seen[1]!.body).toEqual({ enabled: false });
  });

  it("rotates the secret and sends a test ping", async () => {
    const { fetch, seen } = stubFetch([
      json(endpointBody({ secret: "whsec_y", shown_once: true, verification: {} })),
      json(deliveryBody()),
    ]);
    const c = client(fetch);
    expect((await c.webhooks.rotateSecret(ENDPOINT_ID)).secret).toBe("whsec_y");
    const delivery = await c.webhooks.test(ENDPOINT_ID);
    expect([delivery.event, delivery.status]).toEqual(["ping", "delivered"]);
    expect(seen.map((s) => s.url.slice(BASE_URL.length))).toEqual([
      `/api/org/webhooks/${ENDPOINT_ID}/rotate`,
      `/api/org/webhooks/${ENDPOINT_ID}/test`,
    ]);
  });

  it("filters the delivery log and redelivers", async () => {
    const { fetch, seen } = stubFetch([
      json({ data: [deliveryBody({ status: "failed" })], status: "failed" }),
      json(deliveryBody({ id: "whd-0002", status: "pending" }), 202),
    ]);
    const c = client(fetch);
    const log = await c.webhooks.deliveries(ENDPOINT_ID, { status: "failed" });
    expect(log.data[0]!.status).toBe("failed");
    const again = await c.webhooks.redeliver(ENDPOINT_ID, DELIVERY_ID);
    expect(again.id).toBe("whd-0002");
    expect(seen.map((s) => `${s.method} ${s.url.slice(BASE_URL.length)}`)).toEqual([
      `GET /api/org/webhooks/${ENDPOINT_ID}/deliveries?status=failed`,
      `POST /api/org/webhooks/${ENDPOINT_ID}/deliveries/${DELIVERY_ID}/redeliver`,
    ]);
  });

  it("refuses an unknown delivery status", () => {
    const c = client(stubFetch([json({})]).fetch);
    // @ts-expect-error -- not a status
    expect(() => c.webhooks.deliveries(ENDPOINT_ID, { status: "lost" })).toThrow(/status must be one of/);
  });

  it("a non-admin is PermissionDeniedError", async () => {
    const { fetch } = stubFetch([json({ detail: "Only an owner or admin can do that." }, 403)]);
    await expect(client(fetch).webhooks.list()).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});

// --- attachments ----------------------------------------------------------------

const DOWNLOAD = `/api/attachments/${ATTACHMENT_ID}/content?expires=1790622173&sig=abc_-`;

function attachmentBody(extra: Record<string, unknown> = {}) {
  return {
    id: ATTACHMENT_ID,
    filename: "notes.txt",
    content_type: "text/plain",
    size_bytes: 5,
    scan_status: "clean",
    created_at: "2026-10-18T09:00:00+00:00",
    message_id: null,
    extract_truncated: false,
    download_url: DOWNLOAD,
    ...extra,
  };
}

describe("attachments", () => {
  it("uploads multipart, with the conversation in the query and no JSON content type", async () => {
    const { fetch, seen } = stubFetch([json(attachmentBody(), 201)]);
    const attachment = await client(fetch).attachments.upload({
      file: new TextEncoder().encode("hello"),
      filename: "notes.txt",
      conversation_id: CONV,
    });
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/attachments?conversation_id=${CONV}`);
    expect(seen[0]!.headers["Content-Type"]).toBeUndefined();
    const form = seen[0]!.raw as FormData;
    expect(form).toBeInstanceOf(FormData);
    const file = form.get("file") as File;
    expect(file.name).toBe("notes.txt");
    expect(await file.text()).toBe("hello");
    expect(attachment.scan_status).toBe("clean");
  });

  it("retries an upload with the same form", async () => {
    const { fetch, seen } = stubFetch([json({ detail: "busy" }, 503), json(attachmentBody(), 201)]);
    const c = new MatterWave({ apiKey: API_KEY, baseUrl: BASE_URL, maxRetries: 1, fetch });
    const previous = setSleep(async () => {});
    try {
      await c.attachments.upload({ file: new Blob(["hello"]), filename: "notes.txt" });
    } finally {
      setSleep(previous);
    }
    expect(seen).toHaveLength(2);
    expect(await ((seen[1]!.raw as FormData).get("file") as File).text()).toBe("hello");
  });

  it("gets, deletes and reads the limits", async () => {
    const { fetch, seen } = stubFetch([
      json(attachmentBody()),
      json({ status: "deleted", blob_removed_by: "sweeper" }),
      json({ max_upload_bytes: 10, quota_bytes: 100, quota_used_bytes: 40, quota_remaining_bytes: 60 }),
    ]);
    const c = client(fetch);
    expect((await c.attachments.get(ATTACHMENT_ID)).filename).toBe("notes.txt");
    await expect(c.attachments.delete(ATTACHMENT_ID)).resolves.toBeUndefined();
    expect((await c.attachments.limits()).quota_remaining_bytes).toBe(60);
    expect(seen.map((s) => `${s.method} ${s.url.slice(BASE_URL.length)}`)).toEqual([
      `GET /api/attachments/${ATTACHMENT_ID}`,
      `DELETE /api/attachments/${ATTACHMENT_ID}`,
      "GET /api/attachments/limits/me",
    ]);
  });

  it("downloads from the signed URL with the key", async () => {
    const { fetch, seen } = stubFetch([new Response("hello", { status: 200 })]);
    const bytes = await client(fetch).attachments.download(attachmentBody());
    expect(new TextDecoder().decode(bytes)).toBe("hello");
    expect(seen[0]!.url).toBe(`${BASE_URL}${DOWNLOAD}`);
    expect(seen[0]!.headers.Authorization).toBe(`Bearer ${API_KEY}`);
  });

  it("refuses a URL that is not a download", () => {
    const c = client(stubFetch([json({})]).fetch);
    expect(() => c.attachments.download("/api/keys")).toThrow(/not an attachment download URL/);
  });
});

// --- library --------------------------------------------------------------------

const FOLDER = {
  id: "fld-1",
  name: "Work",
  position: 0,
  created_at: "2026-10-18T09:00:00+00:00",
  updated_at: "2026-10-18T09:00:00+00:00",
};
const TAG = { id: "tag-1", name: "urgent", created_at: "2026-10-18T09:00:00+00:00" };
const CONVERSATION = {
  id: CONV,
  title: "New chat",
  created_at: "2026-10-18T09:00:00+00:00",
  updated_at: "2026-10-18T09:00:00+00:00",
  folder_id: null,
};

describe("library", () => {
  it("gets folders, tags and assignments", async () => {
    const { fetch } = stubFetch([json({ folders: [FOLDER], tags: [TAG], assignments: { [CONV]: ["tag-1"] } })]);
    const library = await client(fetch).library.get();
    expect(library.folders[0]!.name).toBe("Work");
    expect(library.assignments[CONV]).toEqual(["tag-1"]);
  });

  it("searches a page at a time", async () => {
    const { fetch, seen } = stubFetch([
      json({ data: [{ ...CONVERSATION, snippet: "<b>hi</b>", message_id: "m-1" }], query: "hi", next_cursor: "c2" }),
    ]);
    const page = await client(fetch).library.search("hi", { cursor: "c1", limit: 5 });
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/search?q=hi&cursor=c1&limit=5`);
    expect(page.next_cursor).toBe("c2");
  });

  it("creates, updates and deletes folders", async () => {
    const { fetch, seen } = stubFetch([
      json(FOLDER, 201),
      json({ ...FOLDER, position: 2 }),
      new Response(null, { status: 204 }),
    ]);
    const c = client(fetch);
    await c.library.createFolder("Work");
    expect((await c.library.updateFolder("fld-1", { position: 2 })).position).toBe(2);
    await c.library.deleteFolder("fld-1");
    expect(seen.map((s) => [s.method, s.url.slice(BASE_URL.length), s.body])).toEqual([
      ["POST", "/api/library/folders", { name: "Work" }],
      ["PATCH", "/api/library/folders/fld-1", { position: 2 }],
      ["DELETE", "/api/library/folders/fld-1", undefined],
    ]);
  });

  it("moves a conversation, null meaning the main list", async () => {
    const { fetch, seen } = stubFetch([json(CONVERSATION)]);
    const moved = await client(fetch).library.move(CONV, null);
    expect(seen[0]!.method).toBe("PUT");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/library/conversations/${CONV}/folder`);
    expect(seen[0]!.body).toEqual({ folder_id: null });
    expect(moved.folder_id).toBeNull();
  });

  it("creates, sets and deletes tags", async () => {
    const { fetch, seen } = stubFetch([
      json(TAG, 201),
      json({ conversation_id: CONV, tag_ids: ["tag-1"] }),
      new Response(null, { status: 204 }),
    ]);
    const c = client(fetch);
    await c.library.createTag("urgent");
    expect((await c.library.setTags(CONV, ["tag-1"])).tag_ids).toEqual(["tag-1"]);
    await c.library.deleteTag("tag-1");
    expect(seen.map((s) => [s.method, s.url.slice(BASE_URL.length), s.body])).toEqual([
      ["POST", "/api/library/tags", { name: "urgent" }],
      ["PUT", `/api/library/conversations/${CONV}/tags`, { tag_ids: ["tag-1"] }],
      ["DELETE", "/api/library/tags/tag-1", undefined],
    ]);
  });
});

// --- shares ---------------------------------------------------------------------

const SHARE = {
  id: "shr-1",
  conversation_id: CONV,
  title: "New chat",
  message_count: 2,
  created_at: "2026-10-18T09:00:00+00:00",
  expires_at: null,
  revoked_at: null,
  view_count: 0,
  status: "active",
};

describe("shares", () => {
  it("creates a link and returns the token once", async () => {
    const { fetch, seen } = stubFetch([json({ share: SHARE, token: "tok_x", path: "/share/tok_x" }, 201)]);
    const created = await client(fetch).shares.create(CONV, { expires_in_s: 3600 });
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/conversations/${CONV}/share`);
    expect(seen[0]!.body).toEqual({ expires_in_s: 3600 });
    expect([created.token, created.path, created.share.status]).toEqual(["tok_x", "/share/tok_x", "active"]);
  });

  it("creates one that lives until revoked", async () => {
    const { fetch, seen } = stubFetch([json({ share: SHARE, token: "t", path: "/share/t" }, 201)]);
    await client(fetch).shares.create(CONV);
    expect(seen[0]!.body).toEqual({ expires_in_s: null });
  });

  it("lists, lists mine and revokes", async () => {
    const { fetch, seen } = stubFetch([
      json({ data: [SHARE] }),
      json({ data: [SHARE, { ...SHARE, id: "shr-2", status: "revoked" }] }),
      json({ status: "revoked" }),
    ]);
    const c = client(fetch);
    expect((await c.shares.list(CONV)).data).toHaveLength(1);
    expect((await c.shares.listMine()).data.map((s) => s.status)).toEqual(["active", "revoked"]);
    await expect(c.shares.revoke("shr-1")).resolves.toBeUndefined();
    expect(seen.map((s) => `${s.method} ${s.url.slice(BASE_URL.length)}`)).toEqual([
      `GET /api/conversations/${CONV}/shares`,
      "GET /api/me/shares",
      "DELETE /api/shares/shr-1",
    ]);
  });

  it("views a link without a key", async () => {
    const { fetch, seen } = stubFetch([
      json({ title: "New chat", shared_at: null, messages: [{ role: "user", content: "hi" }], org_name: null }),
    ]);
    const shared = await client(fetch, { apiKey: null }).shares.view("tok_x");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/share/tok_x`);
    expect(seen[0]!.headers.Authorization).toBeUndefined();
    expect(shared.messages).toHaveLength(1);
  });
});

// --- notifications --------------------------------------------------------------

const NOTIFICATION_ID = "ntf-0001";

function notificationBody(extra: Record<string, unknown> = {}) {
  return {
    id: NOTIFICATION_ID,
    kind: "budget.warn",
    title: "80% of this period's included tokens used",
    body: "The organisation is approaching the tokens its plan includes.",
    link: "/settings/usage",
    created_at: "2026-10-18T09:00:00+00:00",
    read_at: null,
    ...extra,
  };
}

describe("notifications", () => {
  it("lists newest first with the unread count the bell shows", async () => {
    const { fetch, seen } = stubFetch([json({ data: [notificationBody()], unread_count: 2 })]);
    const listed = await client(fetch).notifications.list();
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/me/notifications`);
    expect(seen[0]!.headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(listed.data[0]!.kind).toBe("budget.warn");
    expect(listed.unread_count).toBe(2);
    expect(listed.requestId).toBe(REQUEST_ID);
  });

  it("sends the unread filter and the page size the way the route reads them", async () => {
    const { fetch, seen } = stubFetch([json({ data: [], unread_count: 0 })]);
    await client(fetch).notifications.list({ unread: true, limit: 10 });
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/me/notifications?unread=1&limit=10`);
  });

  it("marks one read and reads the count that is left", async () => {
    const { fetch, seen } = stubFetch([
      json({ ...notificationBody({ read_at: "2026-10-18T10:00:00+00:00" }), unread_count: 1 }),
    ]);
    const read = await client(fetch).notifications.read(NOTIFICATION_ID);
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/me/notifications/${NOTIFICATION_ID}/read`);
    expect([read.read_at, read.unread_count]).toEqual(["2026-10-18T10:00:00+00:00", 1]);
  });

  it("marks every unread row read", async () => {
    const { fetch, seen } = stubFetch([json({ read: 3, unread_count: 0 })]);
    const all = await client(fetch).notifications.readAll();
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/me/notifications/read-all`);
    expect([all.read, all.unread_count]).toEqual([3, 0]);
  });

  it("someone else's notification is NotFoundError like a missing one", async () => {
    const { fetch } = stubFetch([json({ detail: "No such notification." }, 404)]);
    const error = await client(fetch).notifications.read(NOTIFICATION_ID).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as NotFoundError).message).toBe("No such notification.");
  });

  it("refuses an id that would change the path", () => {
    const c = client(stubFetch([json({})]).fetch);
    expect(() => c.notifications.read("../read-all")).toThrow(MatterWaveConfigError);
  });
});

// --- announcements --------------------------------------------------------------

function announcementBody(extra: Record<string, unknown> = {}) {
  return {
    id: "ann-0001",
    message: "The API is having a bad afternoon.",
    severity: "warning",
    link: null,
    starts_at: "2026-10-18T08:00:00+00:00",
    ends_at: null,
    dismissible: true,
    ...extra,
  };
}

describe("announcements", () => {
  it("lists the ones inside their window, most severe first", async () => {
    const { fetch, seen } = stubFetch([
      json({
        data: [
          announcementBody({ severity: "critical", dismissible: false }),
          announcementBody(),
          announcementBody({ severity: "info", message: "Scheduled maintenance on Sunday." }),
        ],
      }),
    ]);
    const listed = await client(fetch).announcements.list();
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/announcements`);
    expect(listed.data.map((a) => [a.severity, a.dismissible])).toEqual([
      ["critical", false],
      ["warning", true],
      ["info", true],
    ]);
  });
});

// --- entitlements ----------------------------------------------------------------

const ENTITLEMENTS = {
  org_id: "org-1",
  plan: "team",
  plan_name: "Team",
  status: "active",
  seats: 5,
  per_seat: true,
  billed_seats: 5,
  price_cents_monthly: 2500,
  price_cents_annual: 25000,
  implicit: false,
  billing_interval: "monthly",
  current_period_end: "2026-11-01T00:00:00+00:00",
  cancel_at_period_end: false,
  trial_end: null,
  default_overage_cap_micros: 50_000_000,
  limits: {
    included_tokens: 5_000_000,
    included_tokens_per_seat: 1_000_000,
    overage_enabled: true,
    budget_duration: "30d",
    tpm_limit: null,
    rpm_limit: null,
    max_parallel_requests: null,
    max_conversations: null,
    max_seats: 10,
    allowed_models: null,
    features: { api_keys: true, webhooks: true },
  },
  over_capacity: 0,
  writes_blocked: false,
  read_only_reason: null,
  dunning_stage: "clear",
};

describe("entitlements", () => {
  it("reads what the caller's org is allowed to do", async () => {
    const { fetch, seen } = stubFetch([json(ENTITLEMENTS)]);
    const entitlements = await client(fetch).entitlements.get();
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/entitlements`);
    expect([entitlements.plan, entitlements.plan_name, entitlements.billed_seats]).toEqual(["team", "Team", 5]);
    expect(entitlements.limits.included_tokens).toBe(5_000_000);
    expect([entitlements.writes_blocked, entitlements.read_only_reason]).toEqual([false, null]);
    expect(entitlements.requestId).toBe(REQUEST_ID);
  });

  it("an org over its plan's cap reads as blocked, with the reason beside it", async () => {
    const { fetch } = stubFetch([
      json({
        ...ENTITLEMENTS,
        plan: "free",
        plan_name: "Free",
        per_seat: false,
        billed_seats: 1,
        implicit: true,
        over_capacity: 2,
        writes_blocked: true,
        read_only_reason: "This organisation holds 2 conversations more than the Free plan's limit of 5.",
      }),
    ]);
    const entitlements = await client(fetch).entitlements.get();
    expect(entitlements.writes_blocked).toBe(true);
    expect(entitlements.read_only_reason).toMatch(/holds 2 conversations/);
    expect(entitlements.limits.features.api_keys).toBe(true);
  });
});
