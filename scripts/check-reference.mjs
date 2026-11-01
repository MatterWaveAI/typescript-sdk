#!/usr/bin/env node
// Check a built API reference covers the whole public surface.
//
//     pnpm build
//     pnpm dlx typedoc@0.28.14 --entryPoints src/index.ts src/agent/node.ts \
//       --excludeInternal --treatWarningsAsErrors --out reference --json reference.json
//     node scripts/check-reference.mjs reference.json
//
// typedoc fails on its own when a documented signature names a type the
// reference leaves out (--treatWarningsAsErrors). This adds the other half:
// every value the built package exports from "." and "./agent" -- each
// class, function and constant -- has its entry under that module in the
// reference, so nothing exported goes missing from the published pages.
// Exits 1 and lists what is absent. The same check as the Python SDK's
// scripts/check_reference.py.

import { readFileSync } from "node:fs";

const MODULES = { "@matterwave/sdk": "../dist/index.js", "@matterwave/sdk/agent": "../dist/agent.js" };

async function main(argv) {
  if (argv.length !== 1) {
    console.error("usage: check-reference.mjs <typedoc --json output>");
    return 2;
  }
  const project = JSON.parse(readFileSync(argv[0], "utf-8"));
  const missing = [];
  for (const [name, path] of Object.entries(MODULES)) {
    const documented = project.children?.find((child) => child.name === name);
    if (!documented) {
      missing.push(`${name}: no module in the reference`);
      continue;
    }
    const names = new Set((documented.children ?? []).map((child) => child.name));
    const exported = Object.keys(await import(new URL(path, import.meta.url).href));
    for (const symbol of exported) if (!names.has(symbol)) missing.push(`${name}.${symbol}`);
  }
  if (missing.length > 0) {
    console.log(`The reference is missing:\n${missing.map((m) => `  ${m}`).join("\n")}`);
    return 1;
  }
  console.log(`The reference covers every export of ${Object.keys(MODULES).length} modules.`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(error.message);
    process.exitCode = 1;
  },
);
