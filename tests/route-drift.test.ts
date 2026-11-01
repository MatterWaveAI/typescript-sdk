/**
 * The SDK's route table against the platform's whole route document.
 *
 * tests/openapi-full.json is the platform's docs/developers/openapi-full.json
 * at the commit tests/openapi-full.pin.json names, vendored by
 * scripts/refresh-openapi-full.mjs; the pin also carries the routes the
 * platform serves but leaves out of that document. The checks run in every
 * checkout, so a refresh that moves, removes or adds a route fails here:
 *
 * - every route the SDK calls is in the document, or is one the platform
 *   names internal (the operator console's announcements are);
 * - every route in the document is wrapped by the SDK or listed in
 *   tests/routes-not-covered.json with the reason it is not;
 * - nothing listed as not covered is wrapped, or gone from the document;
 * - `CREDENTIALS` names, for each operation, the credential its route's
 *   `security` accepts -- so a route that stops taking a key fails here.
 *
 * The live check (scripts/check-live-routes.mjs, run on a schedule) holds a
 * running deployment's `/openapi.json` to the same pair.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { APP_OPERATIONS, CREDENTIALS, OPERATIONS } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const DOCUMENT_BYTES = readFileSync(resolve(here, "openapi-full.json"));
type Security = Record<string, string[]>[];
const DOCUMENT = JSON.parse(DOCUMENT_BYTES.toString("utf-8")) as {
  paths: Record<string, Record<string, { security?: Security }>>;
};
const PIN = JSON.parse(readFileSync(resolve(here, "openapi-full.pin.json"), "utf-8")) as {
  platform_revision: string;
  sha256: string;
  internal_prefixes: Record<string, string>;
  internal_routes: [string, string, string][];
};
const NOT_COVERED = JSON.parse(readFileSync(resolve(here, "routes-not-covered.json"), "utf-8")) as {
  prefixes: Record<string, string>;
  routes: Record<string, string>;
};
const METHODS = ["get", "post", "put", "patch", "delete"];

function documented(): Set<string> {
  const found = new Set<string>();
  for (const [path, item] of Object.entries(DOCUMENT.paths)) {
    for (const method of Object.keys(item)) if (METHODS.includes(method)) found.add(`${method.toUpperCase()} ${path}`);
  }
  return found;
}

function internal(method: string, path: string): boolean {
  if (PIN.internal_routes.some(([m, p]) => m === method && p === path)) return true;
  return Object.keys(PIN.internal_prefixes).some((prefix) => path.startsWith(prefix));
}

function sdkRoutes(): Map<string, string> {
  const routes = new Map<string, string>();
  for (const [name, op] of Object.entries(OPERATIONS)) routes.set(name, `${op.method} ${op.path}`);
  for (const [name, [method, path]] of Object.entries(APP_OPERATIONS)) routes.set(name, `${method} ${path}`);
  return routes;
}

function under(path: string, prefix: string): boolean {
  const bare = prefix.replace(/\/$/, "");
  return path === bare || path.startsWith(`${bare}/`);
}

/** The document's `security` as `CREDENTIALS` spells it. */
function credentialOf(security: Security | undefined): string {
  if (!security || security.length === 0) return "public";
  const schemes: Record<string, string[]> = Object.assign({}, ...security);
  if (!("apiKey" in schemes)) return "person";
  return schemes.apiKey!.length > 0 ? `key:${schemes.apiKey!.join(",")}` : "key";
}

function listedAsNotCovered(route: string): boolean {
  if (route in NOT_COVERED.routes) return true;
  const path = route.slice(route.indexOf(" ") + 1);
  return Object.keys(NOT_COVERED.prefixes).some((prefix) => under(path, prefix));
}

describe("the route table against the platform's route document", () => {
  it("reads the document the pin names", () => {
    expect(createHash("sha256").update(DOCUMENT_BYTES).digest("hex"), "refresh with scripts/refresh-openapi-full.mjs").toBe(
      PIN.sha256,
    );
    expect(PIN.platform_revision).toHaveLength(40);
  });

  it("calls only routes the platform documents or names internal", () => {
    const known = documented();
    const stray = [...sdkRoutes()]
      .filter(([, route]) => !known.has(route) && !internal(route.split(" ")[0]!, route.split(" ")[1]!))
      .map(([name, route]) => `${name}: ${route}`);
    expect(stray, "the platform no longer serves these routes as the SDK calls them").toEqual([]);
  });

  it("wraps every documented route or lists why not", () => {
    const wrapped = new Set(sdkRoutes().values());
    const unaccounted = [...documented()].filter((route) => !wrapped.has(route) && !listedAsNotCovered(route)).sort();
    expect(unaccounted, "routes the platform added: wrap them, or list them in tests/routes-not-covered.json").toEqual([]);
  });

  it("lists nothing as not covered that is wrapped or gone", () => {
    const wrapped = new Set(sdkRoutes().values());
    const known = documented();
    for (const [route, reason] of Object.entries(NOT_COVERED.routes)) {
      expect(reason.trim(), `${route} needs the reason it is left out`).not.toBe("");
      expect(wrapped.has(route), `${route} is wrapped; drop it from routes-not-covered.json`).toBe(false);
      expect(known.has(route), `${route} is no longer documented; drop it`).toBe(true);
    }
    const paths = [...known].map((route) => route.slice(route.indexOf(" ") + 1));
    const wrappedPaths = [...wrapped].map((route) => route.slice(route.indexOf(" ") + 1));
    for (const [prefix, reason] of Object.entries(NOT_COVERED.prefixes)) {
      expect(reason.trim(), `${prefix} needs the reason it is left out`).not.toBe("");
      expect(paths.some((path) => under(path, prefix)), `nothing under ${prefix}`).toBe(true);
      expect(wrappedPaths.some((path) => under(path, prefix)), prefix).toBe(false);
    }
  });

  it("names for each operation the credential its route accepts", () => {
    const wrong: Record<string, [string | undefined, string]> = {};
    for (const [name, route] of sdkRoutes()) {
      const [method, path] = route.split(" ");
      const operation = DOCUMENT.paths[path!]?.[method!.toLowerCase()];
      let expected: string;
      if (operation) expected = credentialOf(operation.security);
      // The operator console's routes take the operator's own session or token.
      else if (name.startsWith("admin.")) expected = "person";
      // The other internal routes the SDK calls (the enforcement banner, the
      // public policy counts) are not in the document to compare.
      else continue;
      const named = (CREDENTIALS as Record<string, string>)[name];
      if (named !== expected) wrong[name] = [named, expected];
    }
    expect(wrong, "CREDENTIALS [SDK, document] disagree").toEqual({});
  });
});
