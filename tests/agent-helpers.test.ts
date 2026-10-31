/**
 * The agent helpers: the mode check, the tools each mode offers, the deny
 * list, path confinement, `edit`'s exact replace, the unified diff and the
 * rendered prompt.
 *
 * Most cases come from tests/agent-conformance.json, generated from the
 * Python SDK's tests/agent_conformance.json, which its suite runs too, so
 * the two clients answer the same way. The link cases are here because they
 * need the filesystem's permission to make links.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DENY,
  DenyList,
  EditError,
  PathRefusedError,
  READ_ONLY_TOOLS,
  TOOLS_BY_NAME,
  allowed,
  applyEdit,
  confine,
  globToRegex,
  isAbsolute,
  loadDenyList,
  resolveLinks,
  splitLines,
  systemPrompt,
  toolsForMode,
  unifiedDiff,
  type ToolName,
} from "../src/agent/node.js";
import { diffSettings } from "../src/agent/diff.js";

const here = dirname(fileURLToPath(import.meta.url));

interface Cases {
  decisions: Record<string, Record<string, string>>;
  tools_for_mode: Record<string, string[]>;
  deny: { extra_patterns: string[]; cases: { path: string; is_dir?: boolean; denied: boolean }[] };
  edits: {
    name: string;
    path?: string;
    text: string;
    old: string;
    new: string;
    result?: string;
    error?: string;
    count?: number;
    message?: string;
  }[];
  diffs: { name: string; old: string; new: string; path?: string; context?: number; expected: string }[];
  prompts: { mode: string; root: string; platform: string; expected: string }[];
  confinement: {
    tree: Record<string, string>;
    cases: { path: string; write?: boolean; relative?: string; refused?: string; message?: string }[];
  };
}

const CASES = JSON.parse(readFileSync(resolve(here, "agent-conformance.json"), "utf-8")) as Cases;

// --- modes -------------------------------------------------------------------

describe("modes", () => {
  it.each(Object.keys(CASES.decisions))("decides every tool in %s", (mode) => {
    for (const [tool, decision] of Object.entries(CASES.decisions[mode]!)) {
      expect([tool, allowed(tool, mode)]).toEqual([tool, decision]);
    }
  });

  it.each(Object.keys(CASES.tools_for_mode))("offers %s its tools", (mode) => {
    expect(toolsForMode(mode).map((t) => t.function.name)).toEqual(CASES.tools_for_mode[mode]);
  });

  it("plan mode offers the model only read tools", () => {
    const names = toolsForMode("plan").map((t) => t.function.name);
    expect(names.sort()).toEqual([...READ_ONLY_TOOLS].sort());
    for (const name of names) expect(TOOLS_BY_NAME[name as ToolName].read_only).toBe(true);
    expect(names).not.toContain("edit");
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("run_shell");
  });

  it("an unknown mode throws rather than guessing", () => {
    expect(() => allowed("read_file", "trusted")).toThrow(/unknown approval mode/);
    expect(() => toolsForMode("YOLO")).toThrow(RangeError);
  });

  it("gives /v1 plain mutable JSON", () => {
    const tool = toolsForMode("ask").find((t) => t.function.name === "edit")!;
    (tool.function.parameters as Record<string, unknown>).type = "changed";
    expect(TOOLS_BY_NAME.edit.parameters.type).toBe("object");
  });

  it.each(CASES.prompts.map((c) => [c.mode, c] as const))("renders the %s prompt as the Python SDK does", (_, c) => {
    expect(systemPrompt(c.mode, c.root, { platform: c.platform })).toBe(c.expected);
  });
});

// --- deny list ---------------------------------------------------------------

describe("the deny list", () => {
  const deny = new DenyList([...DEFAULT_DENY, ...CASES.deny.extra_patterns]);
  it.each(CASES.deny.cases.map((c) => [c.path, c] as const))("%s", (_, c) => {
    expect(deny.matches(c.path, { isDir: c.is_dir ?? false })).toBe(c.denied);
  });

  it.each([
    ["*.py", "a.py", true],
    ["*.py", "a/b.py", false],
    ["src/**/*.ts", "src/a/b/c.ts", true],
    ["src/**/*.ts", "src/c.ts", true],
    ["**", "anything/at/all", true],
    ["file?.txt", "file1.txt", true],
    ["file?.txt", "file10.txt", false],
    ["[!a]bc", "xbc", true],
    ["[!a]bc", "abc", false],
    ["a+b(c).txt", "a+b(c).txt", true],
  ] as const)("glob %s against %s", (glob, path, hit) => {
    expect(new RegExp(`^(?:${globToRegex(glob)})$`).test(path)).toBe(hit);
  });

  it("drive and root-relative paths are absolute everywhere", () => {
    for (const p of ["/etc/passwd", "\\Windows\\win.ini", "C:\\Windows", "c:relative", "D:/x"]) expect(isAbsolute(p)).toBe(true);
    for (const p of ["src/a.py", "./a", ".env"]) expect(isAbsolute(p)).toBe(false);
  });
});

// --- confinement -------------------------------------------------------------

describe("confinement", () => {
  let base: string;
  let root: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "mw-agent-"));
    root = join(base, "root");
    for (const [relative, content] of Object.entries(CASES.confinement.tree)) {
      const target = join(root, relative);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    mkdirSync(join(base, "outside"));
    writeFileSync(join(base, "outside", "secret.txt"), "not yours\n");
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  function refusal(path: string, options: { write?: boolean } = {}, at = root): PathRefusedError {
    try {
      confine(at, path, options);
    } catch (error) {
      if (error instanceof PathRefusedError) return error;
      throw error;
    }
    throw new Error(`${path} was not refused`);
  }

  /** Make a link, or skip: Windows wants admin or Developer Mode for a symbolic link. */
  function link(target: string, path: string, type: "file" | "dir", skip: (reason: string) => void): void {
    try {
      symlinkSync(target, path, type);
    } catch (error) {
      if (process.platform === "win32") skip(`symbolic links need admin or Developer Mode on Windows: ${String(error)}`);
      else throw error;
    }
  }

  it.each(CASES.confinement.cases.map((c) => [`${c.path || "<empty>"}${c.write ? " (write)" : ""}`, c] as const))(
    "%s",
    (_, c) => {
      if (c.refused) {
        const refused = refusal(c.path, { write: c.write });
        expect(refused.reason).toBe(c.refused);
        if (c.message) expect(refused.message).toBe(c.message);
        return;
      }
      const confined = confine(root, c.path, { write: c.write });
      expect(confined.relative).toBe(c.relative);
      expect(confined.absolute).toBe(resolveLinks(join(root, c.relative!)));
    },
  );

  it("refuses a path through .. even when it lands inside", () => {
    expect(refusal("src/../README.md").reason).toBe("parent");
    expect(refusal("src\\..\\..\\outside\\secret.txt").reason).toBe("parent");
  });

  it("refuses an absolute path outside the root and allows one inside", () => {
    expect(refusal(join(base, "outside", "secret.txt")).reason).toBe("outside");
    expect(confine(root, join(root, "src", "app.py")).relative).toBe("src/app.py");
  });

  it("refuses a read of .env before anything is read", () => {
    const refused = refusal(".env");
    expect(refused.reason).toBe("denied");
    expect(refused.message).toContain(".env");
  });

  it("reads .matterwaveignore into the deny list", () => {
    const deny = loadDenyList(root);
    expect(deny.patterns.slice(0, DEFAULT_DENY.length)).toEqual([...DEFAULT_DENY]);
    expect(deny.matches("private/notes.md")).toBe(true);
    expect(loadDenyList(join(base, "missing")).patterns).toEqual([...DEFAULT_DENY]);
  });

  it("refuses a symlinked directory out of the root", ({ skip }) => {
    link(join(base, "outside"), join(root, "escape"), "dir", skip);
    for (const path of ["escape/secret.txt", "escape/new.txt", "escape"]) expect(refusal(path).reason).toBe("symlink");
  });

  it("refuses a symlinked file out of the root", ({ skip }) => {
    link(join(base, "outside", "secret.txt"), join(root, "notes.txt"), "file", skip);
    expect(refusal("notes.txt").reason).toBe("symlink");
  });

  it("refuses a write through a dangling symlink out of the root", ({ skip }) => {
    link(join(base, "outside", "planted.txt"), join(root, "planted.txt"), "file", skip);
    expect(refusal("planted.txt", { write: true }).reason).toBe("symlink");
  });

  it("refuses a symlink inside the root that leads to a denied file", ({ skip }) => {
    link(join(root, ".env"), join(root, "harmless.txt"), "file", skip);
    expect(refusal("harmless.txt").reason).toBe("denied");
  });

  it("follows a symlink that stays inside the root", ({ skip }) => {
    link(join(root, "src"), join(root, "source"), "dir", skip);
    expect(confine(root, "source/app.py").relative).toBe("src/app.py");
  });

  it.runIf(process.platform === "win32")("refuses a junction out of the root (no privilege needed)", () => {
    symlinkSync(join(base, "outside"), join(root, "escape"), "junction");
    for (const path of ["escape/secret.txt", "escape/new.txt"]) expect(refusal(path).reason).toBe("symlink");
  });

  it("still confines under a linked root", ({ skip }) => {
    const linked = join(base, "root-link");
    link(root, linked, "dir", skip);
    expect(confine(linked, "src/app.py").relative).toBe("src/app.py");
    expect(confine(linked, join(linked, "src", "app.py")).relative).toBe("src/app.py");
    expect(refusal(".env", {}, linked).reason).toBe("denied");
  });
});

// --- edit --------------------------------------------------------------------

describe("edit", () => {
  it.each(CASES.edits.map((c) => [c.name, c] as const))("%s", (_, c) => {
    const options = { path: c.path ?? "" };
    if (c.error) {
      let failed: EditError | null = null;
      try {
        applyEdit(c.text, c.old, c.new, options);
      } catch (error) {
        if (error instanceof EditError) failed = error;
        else throw error;
      }
      expect(failed?.reason).toBe(c.error);
      if (c.count !== undefined) expect(failed?.count).toBe(c.count);
      if (c.message) expect(failed?.message).toBe(c.message);
      return;
    }
    expect(applyEdit(c.text, c.old, c.new, options)).toBe(c.result);
  });

  it("takes `$&` in the new text literally", () => {
    expect(applyEdit("price: X", "X", "$& and $1")).toBe("price: $& and $1");
  });
});

// --- diff --------------------------------------------------------------------

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Apply a unified diff of ours to `old`, to prove it says what changed. */
function apply(old: string, patch: string): string {
  const lines = splitLines(old);
  const out: string[] = [];
  const rows = patch.split(/(?<=\n)/).slice(2);
  let pos = 0;
  let i = 0;
  while (i < rows.length) {
    const match = HUNK.exec(rows[i]!);
    if (!match) throw new Error(`not a hunk header: ${rows[i]}`);
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    const begin = count ? start - 1 : start;
    out.push(...lines.slice(pos, begin));
    pos = begin;
    i += 1;
    while (i < rows.length && !rows[i]!.startsWith("@@")) {
      const row = rows[i]!;
      i += 1;
      let body = row.slice(1);
      if (i < rows.length && rows[i]!.startsWith("\\ No newline")) {
        body = body.slice(0, -1);
        i += 1;
      }
      if (row[0] === " ") {
        out.push(body);
        pos += 1;
      } else if (row[0] === "-") {
        pos += 1;
      } else {
        out.push(body);
      }
    }
  }
  out.push(...lines.slice(pos));
  return out.join("");
}

describe("unified diff", () => {
  it.each(CASES.diffs.map((c) => [c.name, c] as const))("%s, as the Python SDK prints it", (_, c) => {
    const options = c.context === undefined ? {} : { context: c.context };
    expect(unifiedDiff(c.old, c.new, c.path ?? "file", options)).toBe(c.expected);
  });

  it("applies back to the new text for random changes", () => {
    let seed = 1501;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const text = (n: number) => Array.from({ length: n }, () => "abcde"[Math.floor(rand() * 5)] + "\n").join("");
    for (let round = 0; round < 400; round++) {
      let oldText = text(Math.floor(rand() * 26));
      let newText = text(Math.floor(rand() * 26));
      if (oldText && rand() < 0.3) oldText = oldText.slice(0, -1);
      if (newText && rand() < 0.3) newText = newText.slice(0, -1);
      for (const context of [0, 1, 3]) {
        const patch = unifiedDiff(oldText, newText, "f", { context });
        expect(patch === "").toBe(oldText === newText);
        if (patch) expect(apply(oldText, patch)).toBe(newText);
      }
    }
  });

  it("prints a change past the edit-distance cap as one block", () => {
    const saved = diffSettings.maxEditDistance;
    diffSettings.maxEditDistance = 2;
    try {
      const oldText = "keep\na\nb\nc\nkeep2\n";
      const newText = "keep\nx\nb\ny\nkeep2\n";
      const patch = unifiedDiff(oldText, newText, "f");
      expect(patch.split("\n").slice(3, -1)).toEqual([" keep", "-a", "-b", "-c", "+x", "+b", "+y", " keep2"]);
      expect(apply(oldText, patch)).toBe(newText);
    } finally {
      diffSettings.maxEditDistance = saved;
    }
  });
});
