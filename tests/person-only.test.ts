/**
 * The methods whose routes refuse every API key: each says so in its doc
 * comment, with the platform's 403 message; a key gets that 403 as a
 * `PermissionDeniedError`; and a person's token reaches the route. Every
 * other person-only method says so in its own doc comment, its class's or
 * its module's.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CREDENTIALS, MatterWave, PERSON_ONLY_DETAIL, PermissionDeniedError } from "../src/index.js";
import { BASE_URL, json, stubFetch, text } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const AUDIT_PAGE = { data: [], actions: [], next_cursor: null };
const BUDGET = { period: "2026-10", overage_micros: 0, overage_cap_micros: 5_000_000, member_default_cap_micros: null };
const MEMBERS = { data: [], member_default_cap_micros: null };
const MEMBER = { subject: "u-2", cap_micros: 1_000_000, spent_micros: 0 };

/** Each person-only method: how to call it, its route, the source class it lives in, and what the route answers. */
const CALLS: Record<string, { call: (c: MatterWave) => Promise<unknown>; method: string; path: string; file: string; cls: string; ok: () => Response }> = {
  "audit.list": { call: (c) => c.audit.list(), method: "GET", path: "/api/org/audit", file: "native.ts", cls: "Audit", ok: () => json(AUDIT_PAGE) },
  "audit.exportCsv": { call: (c) => c.audit.exportCsv(), method: "GET", path: "/api/org/audit.csv", file: "native.ts", cls: "Audit", ok: () => text("id,action\r\n", 200) },
  "instructions.org": { call: (c) => c.instructions.org(), method: "GET", path: "/api/org/instructions", file: "conversations.ts", cls: "Instructions", ok: () => json({ text: "" }) },
  "instructions.updateOrg": {
    call: (c) => c.instructions.updateOrg({ text: "Be brief." }),
    method: "PUT",
    path: "/api/org/instructions",
    file: "conversations.ts",
    cls: "Instructions",
    ok: () => json({ text: "Be brief." }),
  },
  "budget.setOverageCap": {
    call: (c) => c.budget.setOverageCap({ overage_cap_micros: 5_000_000 }),
    method: "PUT",
    path: "/api/budget",
    file: "native.ts",
    cls: "BudgetClient",
    ok: () => json(BUDGET),
  },
  "budget.members": { call: (c) => c.budget.members(), method: "GET", path: "/api/budget/members", file: "native.ts", cls: "BudgetClient", ok: () => json(MEMBERS) },
  "budget.setMemberDefaultCap": {
    call: (c) => c.budget.setMemberDefaultCap({ member_default_cap_micros: null }),
    method: "PUT",
    path: "/api/budget/members",
    file: "native.ts",
    cls: "BudgetClient",
    ok: () => json(MEMBERS),
  },
  "budget.setMemberCap": {
    call: (c) => c.budget.setMemberCap("u-2", { cap_micros: 1_000_000 }),
    method: "PUT",
    path: "/api/budget/members/u-2",
    file: "native.ts",
    cls: "BudgetClient",
    ok: () => json(MEMBER),
  },
};

/** The doc comment directly above `name(` inside `export class <cls>`. */
function docOf(file: string, cls: string, name: string): string {
  const source = readFileSync(resolve(here, "../src", file), "utf-8");
  const start = source.indexOf(`export class ${cls} `);
  const end = source.indexOf("\nexport ", start + 1);
  const body = source.slice(start, end === -1 ? undefined : end);
  const match = new RegExp(`/\\*\\*((?:(?!\\*/)[\\s\\S])*)\\*/\\s*(?:async\\s+)?${name}\\(`).exec(body);
  return flat(match?.[1]);
}

function flat(doc: string | undefined): string {
  return (doc ?? "").replace(/^\s*\*\s?/gm, " ").replace(/\s+/g, " ");
}

/** The file under src/ that declares `export class <cls>`, and its text. */
function sourceOf(cls: string): { file: string; source: string } {
  for (const file of readdirSync(resolve(here, "../src"))) {
    if (!file.endsWith(".ts")) continue;
    const source = readFileSync(resolve(here, "../src", file), "utf-8");
    if (source.includes(`export class ${cls} `)) return { file, source };
  }
  throw new Error(`no file under src/ declares ${cls}`);
}

/** The doc comments of the method `dotted` names, of its class and of its module, as one line. */
function docsOf(dotted: string): string {
  let owner: unknown = new MatterWave({ apiKey: "k", baseUrl: BASE_URL });
  const parts = dotted.split(".");
  for (const part of parts.slice(0, -1)) owner = (owner as Record<string, unknown>)[part];
  const name = parts.at(-1)!;
  expect(typeof (owner as Record<string, unknown>)[name], dotted).toBe("function");
  const cls = (owner as object).constructor.name;
  const { file, source } = sourceOf(cls);
  const classDoc = new RegExp(`/\\*\\*((?:(?!\\*/)[\\s\\S])*)\\*/\\s*export class ${cls} `).exec(source)?.[1];
  const moduleDoc = /^\/\*\*((?:(?!\*\/)[\s\S])*)\*\//.exec(source)?.[1];
  return [docOf(file, cls, name), flat(classDoc), flat(moduleDoc)].join(" ");
}

describe("the person-only methods", () => {
  it("are person credentials", () => {
    for (const name of Object.keys(CALLS)) expect((CREDENTIALS as Record<string, string>)[name], name).toBe("person");
  });

  const personOnly = Object.entries(CREDENTIALS)
    .filter(([name, need]) => need === "person" && !name.startsWith("admin."))
    .map(([name]) => name)
    .sort();
  for (const name of personOnly) {
    it(`${name} says, or its class or module says, that a person's token is what it takes`, () => {
      const docs = docsOf(name);
      expect(docs.includes("person's token") || docs.includes("signed-in person"), name).toBe(true);
    });
  }

  for (const [name, spec] of Object.entries(CALLS)) {
    it(`${name} says it needs a person and quotes the refusal`, () => {
      const doc = docOf(spec.file, spec.cls, name.split(".")[1]!);
      expect(doc).toContain(PERSON_ONLY_DETAIL);
      expect(doc).toContain("person's token");
    });

    it(`${name} answers a key with the documented 403`, async () => {
      const { fetch } = stubFetch([json({ detail: PERSON_ONLY_DETAIL }, 403)]);
      const error = await spec.call(new MatterWave({ apiKey: "mw_key", baseUrl: BASE_URL, fetch })).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PermissionDeniedError);
      expect((error as PermissionDeniedError).message).toBe(PERSON_ONLY_DETAIL);
      expect((error as PermissionDeniedError).status).toBe(403);
    });

    it(`${name} reaches its route with a person's token`, async () => {
      const { fetch, seen } = stubFetch([spec.ok()]);
      await spec.call(new MatterWave({ accessToken: "person-token", baseUrl: BASE_URL, fetch }));
      expect(seen[0]!.method).toBe(spec.method);
      expect(new URL(seen[0]!.url).pathname).toBe(spec.path);
      expect(seen[0]!.headers.Authorization).toBe("Bearer person-token");
    });
  }
});
