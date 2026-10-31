#!/usr/bin/env node
// Refresh tests/openapi.json, the snapshot the contract tests read, from the
// app's exported OpenAPI document.
//
//     node scripts/refresh-openapi.mjs ../matterwave-app/docs/developers/openapi.json
//     node scripts/refresh-openapi.mjs https://<host>/<path>/openapi.json
//     node scripts/refresh-openapi.mjs --check <path-or-url>
//
// The source is a file path or an http(s) URL. Its bytes are written as
// they are, so the snapshot diffs line for line against the app's copy,
// after a check that it is an OpenAPI document with paths and the
// `x-sse-events` the frame tests read. `--check` writes nothing and exits 1
// when the snapshot differs from the source, which is how CI asks "is this
// SDK behind the API?". The same script as the Python SDK's
// scripts/refresh_openapi.py.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SNAPSHOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "tests", "openapi.json");

async function fetchSource(source) {
  if (/^https?:\/\//.test(source)) {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`${source} answered ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }
  return readFileSync(source);
}

function validate(body) {
  let document;
  try {
    document = JSON.parse(body.toString("utf-8"));
  } catch (error) {
    throw new Error(`not JSON: ${error.message}`);
  }
  if (typeof document !== "object" || document === null || !("openapi" in document)) {
    throw new Error("not an OpenAPI document: no top-level `openapi` key");
  }
  for (const key of ["paths", "components", "x-sse-events"]) {
    if (!(key in document)) throw new Error(`the document has no \`${key}\`; is this the app's export?`);
  }
}

async function main(argv) {
  const check = argv.includes("--check");
  const source = argv.find((a) => a !== "--check");
  if (!source) {
    console.error("usage: refresh-openapi.mjs [--check] <path-or-url>");
    return 2;
  }
  const body = await fetchSource(source);
  validate(body);
  const current = existsSync(SNAPSHOT) ? readFileSync(SNAPSHOT) : Buffer.alloc(0);
  if (check) {
    if (!current.equals(body)) {
      console.log(`openapi.json differs from ${source}; run without --check to refresh`);
      return 1;
    }
    console.log(`openapi.json matches ${source}`);
    return 0;
  }
  if (current.equals(body)) {
    console.log(`openapi.json already matches ${source}`);
    return 0;
  }
  writeFileSync(SNAPSHOT, body);
  console.log(`openapi.json refreshed from ${source}`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    console.error(error.message);
    process.exit(1);
  },
);
