#!/usr/bin/env node
// Hold a running deployment's routes to the SDK and the vendored document.
//
//     pnpm build && node scripts/check-live-routes.mjs https://<host>/openapi.json
//     node scripts/check-live-routes.mjs saved-openapi.json
//
// The source is the deployment's own `/openapi.json` (every route the app
// serves) or a saved copy of it; the SDK's route table is read from the
// build in dist/. Drift is any of:
//
// * a route the SDK calls that the deployment does not serve as called;
// * a route in tests/openapi-full.json that the deployment no longer serves;
// * a route the deployment serves that is neither in tests/openapi-full.json
//   nor one the pin in tests/openapi-full.pin.json names internal -- a route
//   added since the pin, which a refresh would then classify.
//
// The report is Markdown on stdout, and the exit status is 1 on drift, so
// the scheduled workflow can open an issue with it. Point
// NODE_EXTRA_CA_CERTS at the deployment's CA when its certificate is not
// publicly trusted. The same check as the Python SDK's
// scripts/check_live_routes.py.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_OPERATIONS, OPERATIONS } from "../dist/index.js";

const TESTS = resolve(dirname(fileURLToPath(import.meta.url)), "..", "tests");
const METHODS = ["get", "post", "put", "patch", "delete"];

async function fetchSource(source) {
  const body = /^https?:\/\//.test(source)
    ? await (async () => {
        const response = await fetch(source);
        if (!response.ok) throw new Error(`${source} answered ${response.status}`);
        return response.text();
      })()
    : readFileSync(source, "utf-8");
  const document = JSON.parse(body);
  if (typeof document !== "object" || document === null || typeof document.paths !== "object") {
    throw new Error(`${source} is not an OpenAPI document with paths`);
  }
  return document;
}

function routesOf(document) {
  const found = new Set();
  for (const [path, item] of Object.entries(document.paths)) {
    for (const method of Object.keys(item)) if (METHODS.includes(method)) found.add(`${method.toUpperCase()} ${path}`);
  }
  return found;
}

function internal(pin, route) {
  const [method, path] = route.split(" ");
  if (pin.internal_routes.some(([m, p]) => m === method && p === path)) return true;
  return Object.keys(pin.internal_prefixes).some((prefix) => path.startsWith(prefix));
}

function drift(live) {
  const vendored = routesOf(JSON.parse(readFileSync(resolve(TESTS, "openapi-full.json"), "utf-8")));
  const pin = JSON.parse(readFileSync(resolve(TESTS, "openapi-full.pin.json"), "utf-8"));
  const sdk = new Map();
  for (const [name, op] of Object.entries(OPERATIONS)) sdk.set(name, `${op.method} ${op.path}`);
  for (const [name, [method, path]] of Object.entries(APP_OPERATIONS)) sdk.set(name, `${method} ${path}`);
  return {
    "Routes the SDK calls that the deployment does not serve": [...sdk]
      .filter(([, route]) => !live.has(route))
      .map(([name, route]) => `\`${route}\` (${name})`)
      .sort(),
    [`Routes in the pinned document (${pin.platform_revision.slice(0, 12)}) the deployment no longer serves`]: [
      ...vendored,
    ]
      .filter((route) => !live.has(route))
      .map((route) => `\`${route}\``)
      .sort(),
    "Routes the deployment serves that the pinned document does not know": [...live]
      .filter((route) => !vendored.has(route) && !internal(pin, route))
      .map((route) => `\`${route}\``)
      .sort(),
  };
}

async function main(argv) {
  const source = argv[0];
  if (!source) {
    console.error("usage: check-live-routes.mjs <openapi.json URL or file>");
    return 2;
  }
  const found = drift(routesOf(await fetchSource(source)));
  if (Object.values(found).every((lines) => lines.length === 0)) {
    console.log(`No route drift against ${source}.`);
    return 0;
  }
  console.log(`# Route drift against ${source}\n`);
  for (const [heading, lines] of Object.entries(found)) {
    if (lines.length > 0) console.log(`## ${heading}\n\n${lines.map((line) => `- ${line}`).join("\n")}\n`);
  }
  console.log(
    "Refresh the pin with `scripts/refresh-openapi-full.mjs` from the platform commit the deployment runs, " +
      "then wrap each new route or list it in tests/routes-not-covered.json.",
  );
  return 1;
}

// exitCode rather than exit(): the fetch's sockets close on their own, and
// cutting the event loop short under them aborts Node on Windows.
main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(error.message);
    process.exitCode = 1;
  },
);
