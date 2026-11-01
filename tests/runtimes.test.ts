/**
 * What the runtimes differ in: a browser refuses an API key unless the
 * caller opts in; an environment that cannot be read is an unset one; the
 * package needs Node 20+ and no runtime dependency.
 */

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { MatterWave, MatterWaveConfigError } from "../src/index.js";
import { envValue, inBrowser } from "../src/client.js";
import { BASE_URL, json, stubFetch } from "./helpers.js";

const scope = globalThis as Record<string, unknown>;

function pretendBrowser(): void {
  scope.window = { document: {} };
}

afterEach(() => {
  delete scope.window;
});

describe("in a browser", () => {
  it("is detected by a window with a document", () => {
    expect(inBrowser()).toBe(false);
    pretendBrowser();
    expect(inBrowser()).toBe(true);
  });

  it("an API key is refused without the opt-in", () => {
    pretendBrowser();
    expect(() => new MatterWave({ apiKey: "mw_x", baseUrl: BASE_URL })).toThrow(MatterWaveConfigError);
    expect(() => new MatterWave({ apiKey: "mw_x", baseUrl: BASE_URL })).toThrow(/dangerouslyAllowBrowser/);
  });

  it("the opt-in allows it, and a withOptions view keeps it", async () => {
    pretendBrowser();
    const { fetch } = stubFetch([json({ data: [] })]);
    const client = new MatterWave({ apiKey: "mw_x", baseUrl: BASE_URL, fetch, dangerouslyAllowBrowser: true });
    await expect(client.withOptions({ timeoutMs: 1_000 }).keys.list()).resolves.toBeDefined();
  });

  it("a client without a key needs no opt-in", () => {
    pretendBrowser();
    const saved = process.env.MATTERWAVE_API_KEY;
    delete process.env.MATTERWAVE_API_KEY;
    try {
      expect(() => new MatterWave({ baseUrl: BASE_URL })).not.toThrow();
    } finally {
      if (saved !== undefined) process.env.MATTERWAVE_API_KEY = saved;
    }
  });
});

describe("the environment", () => {
  it("a read that throws (Deno without --allow-env) is an unset setting", () => {
    const real = scope.process;
    const env = new Proxy({}, { get: () => { throw new Error("Requires env access"); } });
    Object.defineProperty(globalThis, "process", { value: { env }, configurable: true });
    try {
      expect(envValue("MATTERWAVE_API_KEY")).toBeNull();
    } finally {
      Object.defineProperty(globalThis, "process", { value: real, configurable: true });
    }
  });
});

describe("the package", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    engines: { node: string };
    dependencies?: Record<string, string>;
    peerDependencies: Record<string, string>;
    peerDependenciesMeta: Record<string, { optional: boolean }>;
  };

  it("needs Node 20 or later, the oldest line still maintained", () => {
    expect(pkg.engines.node).toBe(">=20");
  });

  it("installs nothing else: zod is an optional peer, for parse's schemas", () => {
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(pkg.peerDependencies.zod).toBeDefined();
    expect(pkg.peerDependenciesMeta.zod?.optional).toBe(true);
  });

  it("no source file imports zod, or anything but its own modules", () => {
    const index = readFileSync(new URL("../src/client.ts", import.meta.url), "utf8");
    expect(index).not.toMatch(/from "zod"/);
  });
});
