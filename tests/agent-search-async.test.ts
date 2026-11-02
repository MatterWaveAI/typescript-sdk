/**
 * The async searches' own behaviour, beyond the conformance cases (which run
 * them too): grep's batches to its worker threads keep runGrep's order and
 * cut, a signal stops a walk, a glob or a grep at once and ends the workers,
 * `timeoutS` is the regex's deadline and `maxDurationS` the whole search's,
 * and both module builds start the workers.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  ToolError,
  loadSearchIgnore,
  runGlobAsync,
  runGrep,
  runGrepAsync,
  walkAsync,
  type Limits,
} from "../src/agent/node.js";

const here = dirname(fileURLToPath(import.meta.url));
const scratch: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mw-agent-async-"));
  scratch.push(dir);
  return dir;
}

function write(root: string, relative: string, content: string | Buffer): void {
  const target = join(root, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** A line the catastrophic pattern `(a+)+$` takes exponential time on. */
const RUNAWAY = "(a+)+$";
function runawayDir(): string {
  const dir = tempDir();
  write(dir, "slow.txt", "a".repeat(40) + "b\n");
  return dir;
}

/** The workers a search started, from the batches it handed them. */
function workersOf(post: { mock: { contexts: unknown[] } }): Worker[] {
  return [...new Set(post.mock.contexts as Worker[])];
}

/** Settles when `promise` does, with the milliseconds it took from `from`. */
async function timed(promise: Promise<unknown>, from: () => number): Promise<{ error: unknown; ms: number }> {
  try {
    await promise;
    return { error: undefined, ms: performance.now() - from() };
  } catch (error) {
    return { error, ms: performance.now() - from() };
  }
}

describe("grep's batches", () => {
  // Far more files than one batch, so batches go to both threads and wait
  // on them; lines that test the text the workers hand back.
  const tree = tempDir();
  let files = 0;
  let seed = 7;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let d = 0; d < 6; d++) {
    for (let f = 0; f < 150; f++) {
      const lines: string[] = [];
      const n = Math.floor(next() * 12);
      for (let i = 0; i < n; i++) lines.push(next() < 0.3 ? `hit ${d}/${f}/${i}` : `miss ${i}`);
      write(tree, `d${d}/${d % 2 ? "sub/" : ""}f${String(f).padStart(3, "0")}.txt`, lines.join("\n") + (n ? "\n" : ""));
      files += 1;
    }
  }
  const long = "hit " + "x".repeat(500);
  const astral = "hit " + "😀".repeat(450);
  const special: Record<string, string | Buffer> = {
    "e/crlf.txt": "hit one\r\nmiss\r\nhit two\r\n",
    "e/bom.txt": "﻿hit with a mark\n",
    "e/invalid.txt": Buffer.from([0x68, 0x69, 0x74, 0x20, 0xff, 0xfe, 0x0a]),
    "e/binary.bin": Buffer.from("hit\0\n"),
    "e/late-nul.txt": Buffer.concat([Buffer.from("hit early\n" + "y".repeat(200) + "\n"), Buffer.from([0])]),
    "e/empty.txt": "",
    "e/blank.txt": "\n\n",
    "e/trailing.txt": "hit with spaces \t \f\v\n",
    "e/long.txt": `${long}   \n${"hit " + "z".repeat(396)}\n${"hit " + "z".repeat(397)}\n`,
    "e/astral.txt": `${astral}\n`,
    "e/no-newline.txt": "miss\nhit at the end",
    "e/big.txt": "hit\n".repeat(1000),
  };
  for (const [relative, content] of Object.entries(special)) write(tree, relative, content);
  files += Object.keys(special).length;
  const base: Limits = { grep_max_file_bytes: 3000, binary_sniff_bytes: 100 };

  it.for([1, 2, 39, 255, 256, 257, 600, 100000])("keeps runGrep's text with search_max_results %i", async (cap) => {
    const limits = { ...base, search_max_results: cap };
    for (const options of [
      { limits },
      { limits, timeoutS: 30 },
      { limits, glob: "*.txt", ignoreCase: true },
      { limits, path: "d1" },
      { limits, path: "e/long.txt" },
    ]) {
      const expected = runGrep(tree, "hit", options);
      expect(await runGrepAsync(tree, "hit", options)).toBe(expected);
    }
  });

  it("hands each thread whole batches, never a file at a time", async () => {
    const post = vi.spyOn(Worker.prototype, "postMessage");
    const text = await runGrepAsync(tree, "hit", { limits: { ...base, search_max_results: 100000 }, timeoutS: 30 });
    expect(text).toBe(runGrep(tree, "hit", { limits: { ...base, search_max_results: 100000 } }));
    expect(post.mock.calls.length).toBe(Math.ceil(files / 256));
    expect(workersOf(post)).toHaveLength(2);
    for (const worker of workersOf(post)) expect(worker.threadId).toBe(-1);
  });

  it("stops handing out batches at the cap", async () => {
    const post = vi.spyOn(Worker.prototype, "postMessage");
    const text = await runGrepAsync(tree, "hit", { limits: { ...base, search_max_results: 3 } });
    expect(text.split("\n")).toHaveLength(4);
    expect(post.mock.calls.length).toBeLessThanOrEqual(5);
  });
});

describe("deadlines", () => {
  it("ends a runaway pattern at timeoutS", async () => {
    const started = performance.now();
    const { error, ms } = await timed(runGrepAsync(runawayDir(), RUNAWAY, { timeoutS: 0.3 }), () => started);
    expect(error).toMatchObject({ reason: "timeout", message: expect.stringContaining("stopped after 0.3 s") });
    expect(ms).toBeLessThan(5000);
  });

  it("does not count the walk and the reads against timeoutS", { timeout: 60_000 }, async () => {
    const dir = tempDir();
    for (let i = 0; i < 300; i++) write(dir, `d${i % 30}/f${i}.txt`, "miss\nhit\nmiss\n");
    const text = await runGrepAsync(dir, "hit", { timeoutS: 0.02, limits: { search_max_results: 100000 } });
    expect(text).toBe(runGrep(dir, "hit", { limits: { search_max_results: 100000 } }));
  });

  it("ends the whole search at maxDurationS", async () => {
    const post = vi.spyOn(Worker.prototype, "postMessage");
    const started = performance.now();
    const { error, ms } = await timed(runGrepAsync(runawayDir(), RUNAWAY, { timeoutS: 60, maxDurationS: 0.2 }), () => started);
    expect(error).toBeInstanceOf(ToolError);
    expect((error as ToolError).message).toBe(
      "The search for (a+)+$ stopped after 0.2 s without finishing. Try a simpler pattern, a narrower path or a glob.",
    );
    expect(ms).toBeLessThan(1000);
    for (const worker of workersOf(post)) expect(worker.threadId).toBe(-1);
    await expect(runGrepAsync(runawayDir(), "x", { maxDurationS: 0 })).rejects.toThrow(RangeError);
  });
});

describe("a signal", () => {
  it("stops a grep within 200 ms and ends its workers", async () => {
    const post = vi.spyOn(Worker.prototype, "postMessage");
    const stop = new AbortController();
    let aborted = 0;
    setTimeout(() => {
      aborted = performance.now();
      stop.abort();
    }, 150);
    const { error, ms } = await timed(runGrepAsync(runawayDir(), RUNAWAY, { timeoutS: 60, signal: stop.signal }), () => aborted);
    expect(error).toMatchObject({ name: "AbortError" });
    expect(error).toBe(stop.signal.reason);
    expect(ms).toBeLessThan(200);
    expect(workersOf(post)).toHaveLength(1);
    for (const worker of workersOf(post)) expect(worker.threadId).toBe(-1);
  });

  it("stops a grep mid-walk", async () => {
    const dir = tempDir();
    for (let i = 0; i < 600; i++) write(dir, `d${i % 30}/f${i}.txt`, "hit\n");
    const stop = new AbortController();
    const rules = loadSearchIgnore(dir);
    const ignored = rules.ignored.bind(rules);
    let seen = 0;
    rules.ignored = (...args: Parameters<typeof ignored>) => {
      if (++seen === 300) stop.abort();
      return ignored(...args);
    };
    await expect(runGrepAsync(dir, "hit", { ignore: rules, signal: stop.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(seen).toBeLessThan(400);
  });

  it("refuses at once when it has already aborted, starting no worker", async () => {
    const post = vi.spyOn(Worker.prototype, "postMessage");
    const reason = new Error("stopped before it began");
    await expect(runGrepAsync(runawayDir(), "x", { signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    await expect(runGlobAsync(runawayDir(), "*", { signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    expect(post).not.toHaveBeenCalled();
  });

  it("that timed out gives the contract's timeout", async () => {
    await expect(runGrepAsync(runawayDir(), RUNAWAY, { timeoutS: 60, signal: AbortSignal.timeout(100) })).rejects.toMatchObject({
      reason: "timeout",
      message: expect.stringMatching(/^The search for \(a\+\)\+\$ stopped after 0\.\d s without finishing\./),
    });
    const dir = tempDir();
    for (let i = 0; i < 400; i++) write(dir, `d${i % 20}/f${i}.txt`, "x\n");
    const stop = new AbortController();
    const rules = loadSearchIgnore(dir);
    const ignored = rules.ignored.bind(rules);
    let seen = 0;
    rules.ignored = (...args: Parameters<typeof ignored>) => {
      if (++seen === 100) stop.abort(new DOMException("too slow", "TimeoutError"));
      return ignored(...args);
    };
    await expect(runGlobAsync(dir, "*.txt", { ignore: rules, signal: stop.signal })).rejects.toMatchObject({
      reason: "timeout",
      message: expect.stringMatching(/^The search for \*\.txt stopped after/),
    });
  });

  it("stops a glob and a walk mid-walk", async () => {
    const dir = tempDir();
    for (let i = 0; i < 400; i++) write(dir, `d${i % 20}/f${i}.txt`, "x\n");
    const stop = new AbortController();
    const rules = loadSearchIgnore(dir);
    const ignored = rules.ignored.bind(rules);
    let seen = 0;
    rules.ignored = (...args: Parameters<typeof ignored>) => {
      if (++seen === 100) stop.abort();
      return ignored(...args);
    };
    await expect(runGlobAsync(dir, "*.txt", { ignore: rules, signal: stop.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(seen).toBeLessThan(150);

    const walking = new AbortController();
    const walked: string[] = [];
    await expect(
      (async () => {
        for await (const path of walkAsync(dir, ".", { signal: walking.signal })) {
          walked.push(path);
          if (walked.length === 5) walking.abort();
        }
      })(),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(walked).toHaveLength(5);
  });
});

describe("the builds", () => {
  it("start grep's workers from the ESM and the CommonJS bundle", { timeout: 120_000 }, async () => {
    const { build } = await import("tsup");
    const out = tempDir();
    await build({
      config: false,
      entry: { agent: resolve(here, "../src/agent/node.ts") },
      outDir: out,
      format: ["esm", "cjs"],
      platform: "neutral",
      target: "es2020",
      external: [/^node:/],
      dts: false,
      sourcemap: false,
      silent: true,
    });
    writeFileSync(join(out, "package.json"), '{ "type": "module" }');
    const dir = tempDir();
    write(dir, "a/one.txt", "miss\nfound it\n");
    write(dir, "b.txt", "found again\n");
    const expected = "b.txt:1: found again\na/one.txt:2: found it";
    const esm = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "const m = await import(process.argv[1]); process.stdout.write(await m.runGrepAsync(process.argv[2], 'found', { timeoutS: 30 }));",
        pathToFileURL(join(out, "agent.js")).href,
        dir,
      ],
      { encoding: "utf-8" },
    );
    expect(esm).toBe(expected);
    const cjs = execFileSync(
      process.execPath,
      [
        "-e",
        "require(process.argv[1]).runGrepAsync(process.argv[2], 'found', { timeoutS: 30 }).then((text) => process.stdout.write(text));",
        join(out, "agent.cjs"),
        dir,
      ],
      { encoding: "utf-8" },
    );
    expect(cjs).toBe(expected);
  });
});
