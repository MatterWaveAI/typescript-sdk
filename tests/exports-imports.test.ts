/**
 * The export and import job resources: start, poll, download, and the
 * import's file upload. Each test answers with the body the route in
 * api/matterwave sends and checks the request the client made.
 */

import { describe, expect, it } from "vitest";
import { MatterWaveConfigError, NotFoundError } from "../src/index.js";
import { BASE_URL, REQUEST_ID, client, json, stubFetch } from "./helpers.js";

const EXPORT_ID = "exp-0001";
const IMPORT_ID = "imp-0001";

function exportRow(extra: Record<string, unknown> = {}) {
  return {
    id: EXPORT_ID,
    status: "pending",
    size_bytes: null,
    created_at: "2026-10-31T09:00:00+00:00",
    completed_at: null,
    expires_at: null,
    ...extra,
  };
}

function importRow(extra: Record<string, unknown> = {}) {
  return {
    id: IMPORT_ID,
    status: "pending",
    source: "chatgpt",
    filename: "conversations.json",
    size_bytes: 2048,
    conversations_total: 12,
    conversations_done: 0,
    conversations_created: 0,
    conversations_existing: 0,
    conversations_skipped: 0,
    messages_created: 0,
    attachments_skipped: 0,
    branches_dropped: 0,
    error: null,
    created_at: "2026-10-31T09:00:00+00:00",
    started_at: null,
    completed_at: null,
    ...extra,
  };
}

describe("exports", () => {
  it("starts a job and reads the pending row", async () => {
    const { fetch, seen } = stubFetch([json(exportRow(), 202)]);
    const started = await client(fetch).exports.start();
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/me/export`);
    expect(seen[0]!.body).toBeUndefined();
    expect(started.status).toBe("pending");
    expect(started.requestId).toBe(REQUEST_ID);
  });

  it("polls a ready job with a fresh download link", async () => {
    const { fetch, seen } = stubFetch([
      json(
        exportRow({
          status: "ready",
          size_bytes: 4096,
          completed_at: "2026-10-31T09:01:00+00:00",
          expires_at: "2026-11-07T09:01:00+00:00",
          download_url: `/api/me/export/${EXPORT_ID}/download?expires=1794438860&sig=abc123`,
        }),
      ),
    ]);
    const job = await client(fetch).exports.get(EXPORT_ID);
    expect(seen[0]!.method).toBe("GET");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/me/export/${EXPORT_ID}`);
    expect(job.status).toBe("ready");
    expect(job.download_url).toContain("sig=abc123");
  });

  it("downloads the bytes behind the signed link", async () => {
    const body = JSON.stringify({ conversations: [] });
    const { fetch, seen } = stubFetch([
      json(
        exportRow({
          status: "ready",
          download_url: `/api/me/export/${EXPORT_ID}/download?expires=1794438860&sig=abc123`,
        }),
      ),
      new Response(body, {
        status: 200,
        headers: { "Content-Type": "application/json", "X-Request-Id": REQUEST_ID },
      }),
    ]);
    const c = client(fetch);
    const job = await c.exports.get(EXPORT_ID);
    const bytes = await c.exports.download(job);
    expect(new TextDecoder().decode(bytes)).toBe(body);
    expect(seen[1]!.method).toBe("GET");
    expect(seen[1]!.url).toBe(
      `${BASE_URL}/api/me/export/${EXPORT_ID}/download?expires=1794438860&sig=abc123`,
    );
    expect(seen[1]!.headers.Authorization).toBeDefined();
  });

  it("downloads from the URL alone", async () => {
    const { fetch, seen } = stubFetch([
      new Response("{}", { status: 200, headers: { "X-Request-Id": REQUEST_ID } }),
    ]);
    await client(fetch).exports.download(`/api/me/export/${EXPORT_ID}/download?expires=1&sig=s`);
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/me/export/${EXPORT_ID}/download?expires=1&sig=s`);
  });

  it("refuses a URL that is not an export download", () => {
    const { fetch } = stubFetch([json({})]);
    expect(() => client(fetch).exports.download("/api/keys")).toThrow(
      /not an export download URL/,
    );
    expect(() => client(fetch).exports.download({ download_url: null })).toThrow(
      MatterWaveConfigError,
    );
  });

  it("surfaces the 404 for another person's export", async () => {
    const { fetch } = stubFetch([json({ detail: "No such export." }, 404)]);
    await expect(client(fetch).exports.get("nope")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("imports", () => {
  it("uploads the file as multipart and reads the pending row", async () => {
    const { fetch, seen } = stubFetch([json(importRow(), 202)]);
    const started = await client(fetch).imports.start({
      file: new Blob(["{}"], { type: "application/json" }),
      filename: "conversations.json",
    });
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/me/imports`);
    const form = seen[0]!.raw as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("file")).toBeInstanceOf(Blob);
    expect(started.source).toBe("chatgpt");
    expect(started.conversations_total).toBe(12);
    expect(started.requestId).toBe(REQUEST_ID);
  });

  it("refuses an upload without a filename before sending", () => {
    const { fetch, calls } = stubFetch([json({})]);
    expect(() =>
      client(fetch).imports.start({ file: new Blob(["{}"]), filename: "" }),
    ).toThrow(MatterWaveConfigError);
    expect(calls()).toBe(0);
  });

  it("lists the recent imports, newest first", async () => {
    const { fetch, seen } = stubFetch([
      json({ data: [importRow({ status: "done", conversations_created: 12 }), importRow()] }),
    ]);
    const listed = await client(fetch).imports.list();
    expect(seen[0]!.method).toBe("GET");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/me/imports`);
    expect(listed.data).toHaveLength(2);
    expect(listed.data[0]!.conversations_created).toBe(12);
  });

  it("polls a running import's progress", async () => {
    const { fetch, seen } = stubFetch([
      json(
        importRow({
          status: "running",
          started_at: "2026-10-31T09:00:10+00:00",
          conversations_done: 5,
          conversations_created: 5,
          messages_created: 90,
        }),
      ),
    ]);
    const job = await client(fetch).imports.get(IMPORT_ID);
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/me/imports/${IMPORT_ID}`);
    expect(job.status).toBe("running");
    expect(job.conversations_done).toBe(5);
  });

  it("reads a failed import's error", async () => {
    const { fetch } = stubFetch([
      json(importRow({ status: "failed", error: "The file could not be imported. Nothing was changed; try again." })),
    ]);
    const job = await client(fetch).imports.get(IMPORT_ID);
    expect(job.status).toBe("failed");
    expect(job.error).toContain("could not be imported");
  });
});
