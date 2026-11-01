/**
 * The workflows keep what supply-chain and release hygiene asked of them:
 * every action pinned to a commit, a read-only token unless a job needs
 * more, the checks a developer runs locally gating CI on every Node and
 * runtime, and a release that cannot ship a version under another's tag.
 * Read as text: the files are small and no YAML parser is a dependency.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const CI = read(".github/workflows/ci.yml");
const PUBLISH = read(".github/workflows/publish-npm.yml");
const DOCS = read(".github/workflows/docs.yml");
const DRIFT = read(".github/workflows/route-drift.yml");
const ALL = [CI, PUBLISH, DOCS, DRIFT];

describe("the workflows", () => {
  it("pin every action to a commit, its tag beside it", () => {
    for (const text of ALL) {
      const uses = [...text.matchAll(/^\s*-?\s*uses:\s*(\S+)(.*)$/gm)];
      expect(uses.length).toBeGreaterThan(0);
      for (const [, ref, rest] of uses) {
        expect(ref).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
        expect(rest).toMatch(/^\s*#\s*v\d/);
      }
    }
  });

  it("give the token read access unless a job says otherwise", () => {
    for (const text of ALL) expect(text).toMatch(/^permissions:\n {2}contents: read\n(?! )/m);
    const grants = [...ALL.join("").matchAll(/^ {4}permissions:\n((?: {6}.+\n)+)/gm)].flatMap(([, block]) =>
      block!.trim().split("\n").map((line) => line.trim()),
    );
    for (const grant of grants) {
      expect(["id-token: write", "contents: write", "contents: read", "issues: write"]).toContain(grant);
    }
    expect(PUBLISH).toMatch(/^ {2}release:\n(?: {4}.*\n)*? {4}permissions:\n {6}contents: write/m);
    expect(DRIFT).toMatch(/^ {2}live:\n(?: {4}.*\n)*? {4}permissions:\n {6}contents: read\n {6}issues: write/m);
    expect(CI).not.toContain("contents: write");
  });

  it("run every local check, on Node 20, 22 and 24", () => {
    for (const check of ["pnpm lint", "pnpm typecheck", "pnpm test", "pnpm build", "pnpm attw", "sh scripts/check-ticket-ids.sh"]) {
      expect(CI).toContain(check);
    }
    expect(CI).toMatch(/node: \[20, 22, 24\]/);
  });

  it("run the built package in Bun, Deno and a browser", () => {
    expect(CI).toContain("bun scripts/smoke.mjs");
    expect(CI).toContain("deno run scripts/smoke.mjs");
    expect(CI).toContain("scripts/smoke.html");
  });

  it("scan the history with a checksum-verified gitleaks", () => {
    expect(CI).toContain("fetch-depth: 0");
    expect(CI).toContain("sha256sum -c");
    expect(CI).toContain("./gitleaks git");
  });

  it("make a release check its tag and ship an SBOM and notes", () => {
    expect(PUBLISH).toContain("if: github.ref_type == 'tag'");
    expect(PUBLISH).toContain("scripts/release.mjs check-tag");
    expect(PUBLISH).toContain("npm sbom --sbom-format cyclonedx");
    expect(PUBLISH).toContain("scripts/release.mjs notes");
    expect(PUBLISH).toContain("gh release create");
  });
});

describe("the repository", () => {
  it("names a code owner for every path", () => {
    const rules = read(".github/CODEOWNERS")
      .split("\n")
      .filter((line) => line.trim() && !line.startsWith("#"))
      .map((line) => line.trim().split(/\s+/));
    expect(rules[0]![0]).toBe("*");
    for (const rule of rules) expect(rule[1]).toMatch(/^@/);
  });

  it("runs a pinned gitleaks before each commit", () => {
    const config = read(".pre-commit-config.yaml");
    expect(config).toContain("https://github.com/gitleaks/gitleaks");
    expect(config).toMatch(/rev: [0-9a-f]{40}/);
    expect(config).toContain("id: gitleaks");
  });
});
