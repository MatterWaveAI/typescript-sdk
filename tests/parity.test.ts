/**
 * TypeScript and Python offer the same client. This SDK's public surface --
 * every method under the client, the streams' methods, the constructor's
 * and `withOptions`' settings, the error classes -- is read off the
 * declarations with the TypeScript compiler (so `private` and `@internal`
 * members stay out), written to `tests/surface.json`, and compared with the
 * Python SDK's own `tests/surface.json` when that checkout is beside this
 * one (CI clones it there; `MATTERWAVE_SIBLING_SDK` names another place).
 * Every name one side has and the other lacks must be listed, with its
 * reason, in `tests/parity.json`, which both SDKs carry word for word.
 *
 * After a change to the surface, `MATTERWAVE_UPDATE_SURFACE=1 pnpm vitest
 * run tests/parity.test.ts` rewrites `tests/surface.json`.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { MatterWave, MatterWaveConfigError, MatterWaveError } from "../src/index.js";
import { chunk, client, completionBody, json, sse, stubFetch } from "./helpers.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SURFACE = join(ROOT, "tests", "surface.json");
const PARITY = join(ROOT, "tests", "parity.json");
const SIBLING = process.env.MATTERWAVE_SIBLING_SDK ?? resolve(ROOT, "..", "python-sdk");

interface Parity {
  python_only: Record<string, string>;
  typescript_only: Record<string, string>;
}

function load<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function surface(): string[] {
  const config = ts.readConfigFile(join(ROOT, "tsconfig.json"), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT);
  const index = join(ROOT, "src", "index.ts");
  const program = ts.createProgram({ rootNames: [index], options: parsed.options });
  const checker = program.getTypeChecker();
  const module = checker.getSymbolAtLocation(program.getSourceFile(index)!)!;
  const exported = new Map(checker.getExportsOfModule(module).map((s) => [s.name, s]));
  const out = new Set<string>();

  const resolved = (symbol: ts.Symbol) =>
    symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const isPublic = (symbol: ts.Symbol): boolean =>
    !symbol.name.startsWith("_") &&
    !symbol.name.startsWith("__@") &&
    (symbol.getDeclarations() ?? []).every(
      (d) =>
        !(ts.getCombinedModifierFlags(d) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) &&
        !ts.getJSDocTags(d).some((tag) => tag.tagName.text === "internal"),
    );
  const ours = (type: ts.Type): boolean => {
    const symbol = type.getSymbol();
    return (
      symbol !== undefined &&
      (symbol.flags & ts.SymbolFlags.Class) !== 0 &&
      (symbol.getDeclarations() ?? []).some((d) => d.getSourceFile().fileName.startsWith(join(ROOT, "src").split("\\").join("/")))
    );
  };
  const walk = (type: ts.Type, prefix: string, depth: number): void => {
    for (const property of checker.getPropertiesOfType(type)) {
      if (!isPublic(property)) continue;
      const path = `${prefix}.${property.name}`;
      const declaration = property.valueDeclaration ?? property.getDeclarations()?.[0];
      const value = declaration ? checker.getTypeOfSymbolAtLocation(property, declaration) : undefined;
      if (value && value.getCallSignatures().length > 0) out.add(path);
      else if (value && depth < 4 && ours(value)) walk(value, path, depth + 1);
      else out.add(path);
    }
  };
  const instance = (name: string) => checker.getDeclaredTypeOfSymbol(resolved(exported.get(name)!));

  walk(instance("MatterWave"), "client", 0);
  for (const name of ["Stream", "ConversationStream"]) {
    for (const property of checker.getPropertiesOfType(instance(name))) {
      if (isPublic(property)) out.add(`${name}.${property.name}`);
    }
  }
  for (const property of checker.getPropertiesOfType(instance("ClientOptions"))) out.add(`options.${property.name}`);
  for (const property of checker.getPropertiesOfType(instance("ClientOverrides"))) out.add(`withOptions.${property.name}`);
  const errorBase = instance("MatterWaveError");
  for (const [name, symbol] of exported) {
    const target = resolved(symbol);
    if (!(target.flags & ts.SymbolFlags.Class)) continue;
    const type = checker.getDeclaredTypeOfSymbol(target);
    if (checker.isTypeAssignableTo(type, errorBase)) out.add(`errors.${name}`);
  }
  return [...out].sort();
}

describe("parity with the Python SDK", () => {
  const current = surface();

  it("tests/surface.json is current", () => {
    if (process.env.MATTERWAVE_UPDATE_SURFACE === "1") writeFileSync(SURFACE, `${JSON.stringify(current, null, 2)}\n`);
    expect(load<string[]>(SURFACE), "the public surface changed: rerun with MATTERWAVE_UPDATE_SURFACE=1 and list any new difference in tests/parity.json").toEqual(current);
  });

  it("every difference listed is still a difference, with a reason", () => {
    const parity = load<Parity>(PARITY);
    const ours = new Set(current);
    expect(Object.keys(parity.typescript_only).filter((name) => !ours.has(name))).toEqual([]);
    expect(Object.keys(parity.python_only).filter((name) => ours.has(name))).toEqual([]);
    for (const reason of [...Object.values(parity.python_only), ...Object.values(parity.typescript_only)]) {
      expect(reason.trim()).not.toBe("");
    }
  });

  it.skipIf(!existsSync(join(SIBLING, "tests", "surface.json")))(
    "the Python SDK differs only where tests/parity.json says",
    () => {
      const parity = load<Parity>(PARITY);
      const ours = new Set(load<string[]>(SURFACE));
      const theirs = new Set(load<string[]>(join(SIBLING, "tests", "surface.json")));
      expect([...ours].filter((name) => !theirs.has(name)).sort()).toEqual(Object.keys(parity.typescript_only).sort());
      expect([...theirs].filter((name) => !ours.has(name)).sort()).toEqual(Object.keys(parity.python_only).sort());
      expect(load<Parity>(join(SIBLING, "tests", "parity.json"))).toEqual(parity);
    },
  );
});

describe("what was aligned", () => {
  it("a config error is a MatterWaveError", () => {
    let caught: unknown;
    try {
      new MatterWave({ apiKey: "k", baseUrl: "ftp://nope" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MatterWaveConfigError);
    expect(caught).toBeInstanceOf(MatterWaveError);
    expect((caught as Error).name).toBe("MatterWaveConfigError");
  });

  it("finalText on both streams, accumulate kept as its alias", async () => {
    const frames = chunk({ role: "assistant", content: "" }) + chunk({ content: "Hello" }) + chunk({}, "stop") + "data: [DONE]\n\n";
    const turn =
      'event: delta\ndata: {"type":"delta","content":"Hi"}\n\n' +
      'event: done\ndata: {"type":"done","message":{"id":"m1","role":"assistant","content":"Hi"}}\n\n';
    const { fetch } = stubFetch([sse([frames]), sse([frames]), sse([turn]), sse([turn])]);
    const c = client(fetch);
    const ask = { messages: [{ role: "user" as const, content: "hi" }], stream: true as const };
    expect(await (await c.chat.completions.create(ask)).finalText()).toBe("Hello");
    expect(await (await c.chat.completions.create(ask)).accumulate()).toBe("Hello");
    expect(await (await c.conversations.send("c-1", { content: "Hi" })).finalText()).toBe("Hi");
    expect(await (await c.conversations.send("c-1", { content: "Hi" })).accumulate()).toBe("Hi");
  });

  it("extraHeaders, extraQuery and extraBody reach the wire; headers stays an alias", async () => {
    const { fetch, seen } = stubFetch([json(completionBody()), json({ data: [] }), json({ id: "k-1" })]);
    const c = client(fetch);
    await c.chat.completions.create(
      { messages: [{ role: "user", content: "hi" }] },
      { headers: { "X-Old": "1", "X-Trace": "old" }, extraHeaders: { "X-Trace": "t-1" }, extraQuery: { beta: "1" }, extraBody: { seed: 7 } },
    );
    await c.conversations.list({ filter: "all" }, { extraQuery: { beta: "2" } });
    await c.keys.rotate("k-1", { extraBody: { reason: "leak" } });
    expect(seen[0]!.headers["X-Trace"]).toBe("t-1");
    expect(seen[0]!.headers["X-Old"]).toBe("1");
    expect(new URL(seen[0]!.url).searchParams.get("beta")).toBe("1");
    expect((seen[0]!.body as { seed: number }).seed).toBe(7);
    const listed = new URL(seen[1]!.url);
    expect(listed.searchParams.get("filter")).toBe("all");
    expect(listed.searchParams.get("beta")).toBe("2");
    expect(seen[2]!.body).toEqual({ reason: "leak" });
    expect(seen[2]!.headers["Content-Type"]).toBe("application/json");
  });

  it("extraBody is refused for a GET and for an upload", async () => {
    const { fetch, calls } = stubFetch([json({})]);
    const c = client(fetch);
    await expect(c.me({ extraBody: { x: 1 } })).rejects.toBeInstanceOf(MatterWaveConfigError);
    await expect(
      c.attachments.upload({ file: new Blob(["hi"]), filename: "a.txt" }, { extraBody: { x: 1 } }),
    ).rejects.toBeInstanceOf(MatterWaveConfigError);
    expect(calls()).toBe(0);
  });
});
