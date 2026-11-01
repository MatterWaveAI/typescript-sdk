#!/usr/bin/env node
// Vendor the platform's whole route document, pinned to one platform commit.
//
//     node scripts/refresh-openapi-full.mjs ../matterwave-app
//     node scripts/refresh-openapi-full.mjs ../matterwave-app --ref <branch-or-sha>
//     node scripts/refresh-openapi-full.mjs ../matterwave-app --check
//
// The source is a checkout of the platform repo. At `--ref` (its HEAD when
// omitted) this reads two files with `git show`, so the checkout's working
// tree is never consulted:
//
// * `docs/developers/openapi-full.json`, every route a person or a script
//   may call with the credentials each accepts, written byte for byte to
//   tests/openapi-full.json;
// * `scripts/export_openapi.py`, whose `INTERNAL_PREFIXES` and
//   `INTERNAL_ROUTES` name the routes the platform serves but leaves out of
//   that document, written with the commit and the document's SHA-256 to
//   tests/openapi-full.pin.json.
//
// `--check` writes nothing and exits 1 when the vendored pair differs from
// the ref. The same script as the Python SDK's
// scripts/refresh_openapi_full.py, and the two write the same bytes.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TESTS = resolve(dirname(fileURLToPath(import.meta.url)), "..", "tests");
const DOCUMENT = resolve(TESTS, "openapi-full.json");
const PIN = resolve(TESTS, "openapi-full.pin.json");
const DOCUMENT_SOURCE = "docs/developers/openapi-full.json";
const EXPORTER_SOURCE = "scripts/export_openapi.py";

function git(checkout, ...args) {
  return execFileSync("git", ["-C", checkout, ...args], { maxBuffer: 64 * 1024 * 1024 });
}

/** The text of one `NAME: type = { ... }` literal in the exporter. */
function literalBlock(source, name) {
  const start = source.search(new RegExp(`^${name}\\s*:[^=]*=\\s*\\{`, "m"));
  if (start === -1) throw new Error(`${EXPORTER_SOURCE} has no ${name}`);
  const open = source.indexOf("{", start);
  const close = source.indexOf("\n}", open);
  return source.slice(open + 1, close);
}

/** Python's adjacent string literals, joined; the exporter's reasons have no escapes but `\``. */
function joined(text) {
  return [...text.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\(.)/g, "$1")).join("");
}

/** Each entry of a literal block: its key text and the reason's text, split at top-level commas. */
function entries(block) {
  const found = [];
  let depth = 0;
  let current = "";
  let inString = false;
  for (let i = 0; i < block.length; i += 1) {
    const ch = block[i];
    if (inString) {
      current += ch;
      if (ch === "\\") {
        current += block[i + 1];
        i += 1;
      } else if (ch === '"') inString = false;
      continue;
    }
    if (ch === "#") {
      while (i < block.length && block[i] !== "\n") i += 1;
      continue;
    }
    if (ch === '"') inString = true;
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      if (current.trim()) found.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) found.push(current);
  return found.map((entry) => {
    const colon = entry.search(/\)?\s*:\s*[("]/);
    const keyEnd = entry[colon] === ")" ? colon + 1 : colon;
    return { key: entry.slice(0, keyEnd), reason: joined(entry.slice(entry.indexOf(":", keyEnd) + 1)) };
  });
}

function internalRoutes(exporter) {
  const prefixes = Object.fromEntries(
    entries(literalBlock(exporter, "INTERNAL_PREFIXES"))
      .map(({ key, reason }) => [joined(key), reason])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  const routes = entries(literalBlock(exporter, "INTERNAL_ROUTES"))
    .map(({ key, reason }) => {
      const [method, path] = [...key.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
      return [method, path, reason];
    })
    .sort((a, b) => {
      for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
      return 0;
    });
  return { prefixes, routes };
}

function validate(document) {
  const parsed = JSON.parse(document.toString("utf-8"));
  if (!parsed.paths || !parsed.components?.securitySchemes?.apiKey) {
    throw new Error(`${DOCUMENT_SOURCE} has no paths or no apiKey scheme`);
  }
}

function renderPin(revision, document, exporter) {
  const { prefixes, routes } = internalRoutes(exporter);
  const pin = {
    platform_revision: revision,
    source: DOCUMENT_SOURCE,
    sha256: createHash("sha256").update(document).digest("hex"),
    internal_prefixes: prefixes,
    internal_routes: routes,
  };
  return Buffer.from(`${JSON.stringify(pin, null, 2)}\n`, "utf-8");
}

/** The pin without its commit: the same routes at a later commit are not drift. */
function routesOf(pin) {
  if (pin.length === 0) return null;
  const { platform_revision: _revision, ...rest } = JSON.parse(pin.toString("utf-8"));
  return JSON.stringify(rest);
}

function main(argv) {
  const check = argv.includes("--check");
  const refAt = argv.indexOf("--ref");
  const ref = refAt === -1 ? "HEAD" : argv[refAt + 1];
  const checkout = argv.find((a, i) => !a.startsWith("--") && (refAt === -1 || i !== refAt + 1));
  if (!checkout || !ref) {
    console.error("usage: refresh-openapi-full.mjs <platform-checkout> [--ref <ref>] [--check]");
    return 2;
  }
  const revision = git(checkout, "rev-parse", "--verify", `${ref}^{commit}`).toString().trim();
  const document = git(checkout, "show", `${revision}:${DOCUMENT_SOURCE}`);
  validate(document);
  const exporter = git(checkout, "show", `${revision}:${EXPORTER_SOURCE}`).toString("utf-8");
  const pin = renderPin(revision, document, exporter);
  const current = existsSync(DOCUMENT) ? readFileSync(DOCUMENT) : Buffer.alloc(0);
  const currentPin = existsSync(PIN) ? readFileSync(PIN) : Buffer.alloc(0);
  const same = current.equals(document) && routesOf(currentPin) === routesOf(pin);
  if (check) {
    if (!same) {
      console.log(`the vendored route document differs from ${revision}; run without --check`);
      return 1;
    }
    console.log(`the vendored route document matches ${revision}`);
    return 0;
  }
  if (same) {
    console.log(`the vendored route document already matches ${revision}`);
    return 0;
  }
  writeFileSync(DOCUMENT, document);
  writeFileSync(PIN, pin);
  console.log(`vendored ${DOCUMENT_SOURCE} and its internal routes at ${revision}`);
  return 0;
}

try {
  process.exit(main(process.argv.slice(2)));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
