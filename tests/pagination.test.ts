/**
 * Page and item iterators for every cursor-paged list: `audit.pages` /
 * `audit.items`, `library.searchPages` / `library.searchItems`, and the
 * generic `pagesOf` / `itemsOf` they are built on. Each page is fetched only
 * when the previous one has been consumed, and the cursor a page names is
 * the one the next request carries.
 */

import { describe, expect, it } from "vitest";
import { itemsOf, pagesOf } from "../src/index.js";
import { client, json, stubFetch } from "./helpers.js";

function auditPage(ids: string[], nextCursor: string | null) {
  return {
    data: ids.map((id) => ({
      id,
      occurred_at: "2026-10-31T09:00:00+00:00",
      actor: "user-1",
      actor_email: "a@example.test",
      action: "org.sso.enforced",
      target: null,
      detail: {},
    })),
    actions: ["org.sso.enforced"],
    next_cursor: nextCursor,
  };
}

function searchPage(ids: string[], nextCursor: string | null) {
  return {
    data: ids.map((id) => ({ id, title: id, snippet: "<b>hit</b>", message_id: null })),
    query: "hit",
    next_cursor: nextCursor,
  };
}

function params(url: string): Record<string, string> {
  return Object.fromEntries(new URL(url).searchParams);
}

describe("audit.pages and audit.items", () => {
  it("follow next_cursor with the same filters", async () => {
    const { fetch, seen } = stubFetch([json(auditPage(["e-1", "e-2"], "cur-1")), json(auditPage(["e-3"], null))]);
    const sizes: number[] = [];
    for await (const page of client(fetch).audit.pages({ event: "org.sso", limit: 2 })) sizes.push(page.data.length);
    expect(sizes).toEqual([2, 1]);
    expect(params(seen[0]!.url)).toEqual({ event: "org.sso", limit: "2" });
    expect(params(seen[1]!.url)).toEqual({ event: "org.sso", limit: "2", cursor: "cur-1" });
  });

  it("walk every event and fetch the next page only when it is reached", async () => {
    const { fetch, calls } = stubFetch([json(auditPage(["e-1", "e-2"], "cur-1")), json(auditPage(["e-3"], null))]);
    const items = client(fetch).audit.items({ actor: "a@example.test" });
    expect((await items.next()).value?.id).toBe("e-1");
    expect((await items.next()).value?.id).toBe("e-2");
    expect(calls()).toBe(1);
    const rest: string[] = [];
    for await (const event of items) rest.push(event.id);
    expect(rest).toEqual(["e-3"]);
    expect(calls()).toBe(2);
  });

  it("refuse a bad limit before any request", async () => {
    const { fetch, calls } = stubFetch([json(auditPage([], null))]);
    await expect(client(fetch).audit.items({ limit: 0 }).next()).rejects.toThrow(/limit must be 1 to 200/);
    expect(calls()).toBe(0);
  });
});

describe("library.searchPages and library.searchItems", () => {
  it("carry the query and the cursor", async () => {
    const { fetch, seen } = stubFetch([json(searchPage(["c-1"], "s-1")), json(searchPage(["c-2"], null))]);
    const hits: string[] = [];
    for await (const hit of client(fetch).library.searchItems("hit", { limit: 1 })) hits.push(hit.id);
    expect(hits).toEqual(["c-1", "c-2"]);
    expect(params(seen[0]!.url)).toEqual({ q: "hit", limit: "1" });
    expect(params(seen[1]!.url)).toEqual({ q: "hit", limit: "1", cursor: "s-1" });
  });

  it("stop on a page with no cursor", async () => {
    const { fetch, calls } = stubFetch([json(searchPage(["c-1", "c-2"], null))]);
    const pages = [];
    for await (const page of client(fetch).library.searchPages("hit")) pages.push(page);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.query).toBe("hit");
    expect(calls()).toBe(1);
  });
});

describe("pagesOf and itemsOf", () => {
  it("walk any cursor-paged list", async () => {
    const pages: Record<string, ReturnType<typeof auditPage>> = {
      first: auditPage(["e-1"], "a"),
      a: auditPage(["e-2", "e-3"], "b"),
      b: auditPage([], null),
    };
    const asked: (string | undefined)[] = [];
    const ids: string[] = [];
    const walk = pagesOf(async (cursor: string | undefined) => {
      asked.push(cursor);
      return pages[cursor ?? "first"]!;
    });
    for await (const event of itemsOf(walk)) ids.push(event.id);
    expect(ids).toEqual(["e-1", "e-2", "e-3"]);
    expect(asked).toEqual([undefined, "a", "b"]);
  });
});
