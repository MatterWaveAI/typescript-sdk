/**
 * The package's exports map: each module format resolves to declarations of
 * its own format (ESM `.d.ts` beside `.js`, CommonJS `.d.cts` beside
 * `.cjs`), so a CommonJS consumer never type-checks against ESM types. CI
 * runs `attw --pack` on the built package for the full matrix.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type Condition = { types: string; default: string };
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  license: string;
  files: string[];
  exports: Record<string, string | { import: Condition; require: Condition }>;
};

describe("the exports map", () => {
  const entries = Object.entries(pkg.exports).filter(
    (entry): entry is [string, { import: Condition; require: Condition }] => typeof entry[1] !== "string",
  );

  it("covers the main entry and the agent", () => {
    expect(entries.map(([name]) => name)).toEqual([".", "./agent"]);
  });

  it.each(entries)("%s: import gets ESM declarations, require CommonJS ones", (_name, conditions) => {
    expect(conditions.import.default).toMatch(/\.js$/);
    expect(conditions.import.types).toBe(conditions.import.default.replace(/\.js$/, ".d.ts"));
    expect(conditions.require.default).toMatch(/\.cjs$/);
    expect(conditions.require.types).toBe(conditions.require.default.replace(/\.cjs$/, ".d.cts"));
  });

  it("lists types before the file in each condition, as resolvers read them in order", () => {
    for (const [, conditions] of entries) {
      expect(Object.keys(conditions.import)[0]).toBe("types");
      expect(Object.keys(conditions.require)[0]).toBe("types");
    }
  });
});

describe("the licence", () => {
  it("is Apache-2.0, and the package carries LICENSE and NOTICE", () => {
    expect(pkg.license).toBe("Apache-2.0");
    expect(pkg.files).toEqual(expect.arrayContaining(["LICENSE", "NOTICE"]));
    expect(readFileSync(new URL("../LICENSE", import.meta.url), "utf8")).toMatch(/Apache License\s+Version 2\.0/);
    expect(readFileSync(new URL("../NOTICE", import.meta.url), "utf8")).toContain("MatterWave AI Contributors");
  });
});
