/**
 * A grep whose worker thread cannot start, or exits partway, fails at once
 * with the contract's `timeout` (what happened is the error's `cause`)
 * instead of waiting out its deadline, and no worker is started again. The
 * Worker class is wrapped here so a test can break it.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { ToolError, runGrepAsync } from "../src/agent/node.js";

const broken = vi.hoisted(() => ({ how: "no" as "no" | "throws" | "fails" | "exits", started: 0 }));

vi.mock("node:worker_threads", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:worker_threads")>();
  class Worker extends real.Worker {
    constructor(source: string, options: import("node:worker_threads").WorkerOptions) {
      broken.started += 1;
      if (broken.how === "throws") throw new Error("no threads left");
      const program =
        broken.how === "fails"
          ? "throw new Error('the worker could not start')"
          : broken.how === "exits"
            ? // Exits on its second batch, before it answers.
              `let batches = 0;
               import("node:worker_threads").then(({ parentPort }) => parentPort.on("message", () => { if (++batches === 2) process.exit(3); }));
               ${source}`
            : source;
      super(program, options);
    }
  }
  return { ...real, Worker, default: { ...real, Worker } };
});

const scratch: string[] = [];

/** A tree of `count` files, every one with a matching line. */
function treeOf(count: number): string {
  const dir = mkdtempSync(join(tmpdir(), "mw-agent-worker-"));
  scratch.push(dir);
  for (let i = 0; i < count; i++) {
    const target = join(dir, `d${i % 20}`, `f${i}.txt`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "hit\n");
  }
  return dir;
}

afterEach(() => {
  broken.how = "no";
  broken.started = 0;
});

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

async function failure(promise: Promise<unknown>): Promise<{ error: ToolError; ms: number }> {
  const started = performance.now();
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ToolError);
    return { error: error as ToolError, ms: performance.now() - started };
  }
  throw new Error("the search finished");
}

describe("a broken worker", () => {
  it("still searches when nothing is broken", async () => {
    const dir = treeOf(3);
    expect(await runGrepAsync(dir, "hit", { timeoutS: 30 })).toBe("d0/f0.txt:1: hit\nd1/f1.txt:1: hit\nd2/f2.txt:1: hit");
  });

  it("that cannot be made fails the search at once", async () => {
    broken.how = "throws";
    const { error, ms } = await failure(runGrepAsync(treeOf(3), "hit", { timeoutS: 30 }));
    expect(error.reason).toBe("timeout");
    expect(error.message).toMatch(/^The search for hit stopped after [\d.]+ s without finishing\./);
    expect((error.cause as Error).message).toBe("no threads left");
    expect(ms).toBeLessThan(2000);
    expect(broken.started).toBe(1);
  });

  it("that fails as it starts fails the search at once", async () => {
    broken.how = "fails";
    const { error, ms } = await failure(runGrepAsync(treeOf(3), "hit", { timeoutS: 30 }));
    expect(error.reason).toBe("timeout");
    expect((error.cause as Error).message).toBe("the worker could not start");
    expect(ms).toBeLessThan(5000);
    expect(broken.started).toBe(1);
  });

  it("that exits between batches fails the search at once, and none starts again", { timeout: 60_000 }, async () => {
    // Five batches: the first thread's second batch is the third.
    const dir = treeOf(1100);
    broken.how = "exits";
    const { error, ms } = await failure(runGrepAsync(dir, "hit", { timeoutS: 30, limits: { search_max_results: 100000 } }));
    expect(error.reason).toBe("timeout");
    expect((error.cause as Error).message).toBe("grep's worker thread exited with code 3 before the search finished");
    expect(ms).toBeLessThan(10_000);
    expect(broken.started).toBe(2);
  });
});
