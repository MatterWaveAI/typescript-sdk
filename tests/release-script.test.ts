/**
 * scripts/release.mjs: the tag gate and the release notes it hands the
 * GitHub release, run the way the workflow runs it.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/index.js";

const SCRIPT = fileURLToPath(new URL("../scripts/release.mjs", import.meta.url));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

function run(...args: string[]) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  return { status: result.status, out: result.stdout, err: result.stderr };
}

describe("the release script", () => {
  it("passes the tag that names the package version", () => {
    expect(run("check-tag", `v${pkg.version}`).status).toBe(0);
  });

  it("refuses any other tag, saying which it expected", () => {
    const result = run("check-tag", "v0.0.0-not-it");
    expect(result.status).toBe(1);
    expect(result.err).toContain(`expected v${pkg.version}`);
  });

  it("the client's VERSION is the package's", () => {
    expect(VERSION).toBe(pkg.version);
  });

  it("prints the version's CHANGELOG section and nothing after it", () => {
    const result = run("notes", pkg.version);
    expect(result.status).toBe(0);
    expect(result.out.trim()).not.toBe("");
    expect(result.out).not.toMatch(/^## \[/m);
  });

  it("refuses a version with no section", () => {
    const result = run("notes", "0.0.0");
    expect(result.status).toBe(1);
    expect(result.err).toContain("no section for 0.0.0");
  });
});
