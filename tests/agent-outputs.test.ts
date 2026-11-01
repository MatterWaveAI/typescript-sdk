/**
 * Contract 1.1: the read tools' output, the search rules, run_shell's text,
 * tool kinds, protected files, the refusal sentences and the prompt's
 * extra-tool and context-file slots.
 *
 * The output, ignore and shell cases are the contract's own
 * (`CONTRACT.conformance`), which every client must reproduce; the kind,
 * protected, refusal and prompt-slot cases are in tests/agent-conformance.json.
 * The Python SDK's suite runs the same cases.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  APPROVAL_MODES,
  APPROVAL_REFUSALS,
  CONTEXT_FILES,
  CONTRACT,
  DENY_FILE,
  DenyList,
  EDIT_CRLF_FALLBACK,
  IgnoreFile,
  KIND_DECISIONS,
  LIMITS,
  MODE_NAMES,
  PROTECTED,
  PROTECTED_LIST,
  PathRefusedError,
  READ_ONLY_TOOLS,
  REFUSALS,
  SETTINGS_DIR,
  SearchIgnore,
  TOOL_ERRORS,
  TOOL_KINDS,
  TOOLS,
  ToolError,
  allowed,
  confine,
  formatReadFile,
  formatShell,
  globMatches,
  isProtected,
  loadSearchIgnore,
  refusal,
  runGlob,
  runGrep,
  runListDir,
  runReadFile,
  systemPrompt,
  toolsForMode,
  utf8Head,
  utf8Tail,
  walk,
  type AnyToolKind,
  type ExtraTool,
  type Limits,
  type RefusalCode,
} from "../src/agent/node.js";
import { agent } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));

interface ToolCase {
  tool: "read_file" | "list_dir" | "glob" | "grep";
  args: Record<string, string | number | boolean>;
  limits?: Limits;
  expected?: string;
  error?: string;
  refused?: string;
  message?: string;
  message_prefix?: string;
}

interface Conformance {
  tree: Record<string, string>;
  tools: ToolCase[];
  ignore: { path: string; is_dir?: boolean; ancestors?: boolean; ignored: boolean }[];
  shell: {
    output: string;
    exit_code?: number | null;
    timed_out?: boolean;
    stopped?: boolean;
    timeout_s?: number;
    limits?: Limits;
    expected: string;
  }[];
}

interface Cases {
  prompts: { mode: string; root: string; platform: string; expected: string }[];
  kinds: { tool: string; kind?: AnyToolKind; read_only?: boolean; decisions: Record<string, string> }[];
  protected: { path: string; protected: boolean; decisions: Record<string, string> }[];
  refusals: { code: RefusalCode; values: { tool?: string; mode?: string; path?: string }; expected: string }[];
  prompt_slots: {
    name: string;
    mode: string;
    root: string;
    platform: string;
    extra_tools: { name: string; description: string }[];
    context_files: { path: string; content: string; trusted: boolean }[];
    expected: string;
  }[];
}

const CONFORMANCE = CONTRACT.conformance as unknown as Conformance;
const CASES = JSON.parse(readFileSync(resolve(here, "agent-conformance.json"), "utf-8")) as Cases;

function writeTree(root: string, tree: Record<string, string>): void {
  for (const [relative, content] of Object.entries(tree)) {
    const target = join(root, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf-8");
  }
}

function run(root: string, c: ToolCase): string {
  const a = c.args;
  const limits = c.limits;
  switch (c.tool) {
    case "read_file":
      return runReadFile(root, a.path as string, {
        startLine: a.start_line as number | undefined,
        endLine: a.end_line as number | undefined,
        limits,
      });
    case "list_dir":
      return runListDir(root, (a.path as string | undefined) ?? ".", { limits });
    case "glob":
      return runGlob(root, a.pattern as string, { path: a.path as string | undefined, limits });
    case "grep":
      return runGrep(root, a.pattern as string, {
        path: a.path as string | undefined,
        glob: a.glob as string | undefined,
        ignoreCase: a.ignore_case as boolean | undefined,
        limits,
      });
  }
}

let tree = "";
const scratch: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mw-agent-out-"));
  scratch.push(dir);
  return dir;
}

beforeAll(() => {
  tree = tempDir();
  writeTree(tree, CONFORMANCE.tree);
});

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

// --- the read tools' output ----------------------------------------------------

describe("tool output", () => {
  it.each(CONFORMANCE.tools.map((c) => [`${c.tool} ${JSON.stringify(c.args)}${c.limits ? " limits" : ""}`, c] as const))(
    "%s",
    (_, c) => {
      if (c.expected !== undefined) {
        expect(run(tree, c)).toBe(c.expected);
        return;
      }
      let thrown: unknown;
      try {
        run(tree, c);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(c.refused ? PathRefusedError : ToolError);
      const error = thrown as PathRefusedError | ToolError;
      expect(error.reason).toBe(c.refused ?? c.error);
      if (c.message !== undefined) expect(error.message).toBe(c.message);
      else expect(error.message.startsWith(c.message_prefix!)).toBe(true);
    },
  );

  it("has a case for every tool error", () => {
    const covered = new Set(CONFORMANCE.tools.flatMap((c) => (c.error ? [c.error] : [])));
    expect([...covered].sort()).toEqual(Object.keys(TOOL_ERRORS).filter((k) => k !== "bad_timeout").sort());
  });

  it("walks past what search ignores", () => {
    const walked = [...walk(tree)];
    expect(walked).toContain("src/main.py");
    expect(walked).toContain("keep.log");
    expect(walked.some((p) => /^(build|\.git|private|src\/generated)\//.test(p))).toBe(false);
    expect(walked).not.toContain(".env");
    expect(walked).not.toContain("app.log");
    expect([...walk(tree, "build")]).toEqual(["build/a.txt", "build/keep.txt"]);
    expect([...walk(tree, "src/main.py")]).toEqual(["src/main.py"]);
    expect(() => [...walk(tree, "nowhere")]).toThrow(ToolError);
  });

  it("cuts a long read at the line limit", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "big.txt"), Array.from({ length: 2500 }, (_, i) => `line ${i + 1}\n`).join(""));
    const lines = runReadFile(dir, "big.txt").split("\n");
    expect(lines.length).toBe(LIMITS.read_max_lines + 1);
    expect(lines[lines.length - 1]).toBe(
      "[Cut off at the read limit: showing lines 1-2000 of 2500. Pass start_line=2001 to read on.]",
    );
    expect(runReadFile(dir, "big.txt", { startLine: 2001 }).endsWith("2500\tline 2500")).toBe(true);
  });

  it("cuts bytes at whole characters", () => {
    expect(utf8Head("aé€😀", 4)).toBe("aé");
    expect(utf8Tail("aé€😀", 5)).toBe("😀");
    expect(utf8Head("abc", 9)).toBe("abc");
    expect(formatReadFile("é".repeat(10), "x", { limits: { read_max_bytes: 6 } }).startsWith("1\téé\n")).toBe(true);
  });
});

// --- the search rules ----------------------------------------------------------

function ignoreRules(): SearchIgnore {
  const files = CONFORMANCE.tree;
  return new SearchIgnore((relative) => files[relative] ?? null, { deny: DenyList.withIgnoreFile(files[DENY_FILE]!) });
}

describe("search ignore", () => {
  it.each(CONFORMANCE.ignore.map((c) => [`${c.path}${c.is_dir ? "/" : ""}${c.ancestors === false ? " alone" : ""}`, c] as const))(
    "%s",
    (_, c) => {
      expect(ignoreRules().ignored(c.path, { isDir: c.is_dir ?? false, ancestors: c.ancestors ?? true })).toBe(c.ignored);
    },
  );

  it("reads the files from disk", () => {
    const rules = loadSearchIgnore(tree);
    for (const c of CONFORMANCE.ignore) {
      expect([c.path, rules.ignored(c.path, { isDir: c.is_dir ?? false, ancestors: c.ancestors ?? true })]).toEqual([
        c.path,
        c.ignored,
      ]);
    }
  });

  it("reads one ignore file on its own", () => {
    const rules = new IgnoreFile("*.log\n!keep.log\n/out/\n", "pkg");
    expect(rules.match("pkg/a.log")).toBe(true);
    expect(rules.match("pkg/keep.log")).toBe(false);
    expect(rules.match("pkg/out", { isDir: true })).toBe(true);
    expect(rules.match("pkg/sub/out", { isDir: true })).toBe(null);
    expect(rules.match("other/a.log")).toBe(null);
    expect(rules.match("pkg/a.txt")).toBe(null);
  });

  it.each([
    ["*.py", "a.py", true],
    ["*.py", "deep/er/a.PY", true],
    ["src/*.py", "src/a.py", true],
    ["src/*.py", "src/x/a.py", false],
    ["/a.py", "x/a.py", false],
    ["./src/**", "src/x/y.ts", true],
    ["**/test_*.py", "test_a.py", true],
  ] as const)("glob %s against %s", (pattern, path, hit) => {
    expect(globMatches(pattern, path)).toBe(hit);
  });
});

// --- run_shell's text ------------------------------------------------------------

describe("shell output", () => {
  it.each(CONFORMANCE.shell.map((c) => [JSON.stringify(c).slice(0, 60), c] as const))("%s", (_, c) => {
    expect(
      formatShell(c.output, {
        exitCode: c.exit_code ?? null,
        timedOut: c.timed_out ?? false,
        stopped: c.stopped ?? false,
        timeoutS: c.timeout_s,
        limits: c.limits,
      }),
    ).toBe(c.expected);
  });
});

// --- kinds, protected files and refusals ----------------------------------------

describe("tool kinds", () => {
  it.each(CASES.kinds.map((c) => [c.tool, c] as const))("decides %s", (_, c) => {
    for (const [mode, decision] of Object.entries(c.decisions)) {
      expect([mode, allowed(c.tool, mode, c.kind, { readOnly: c.read_only ?? false })]).toEqual([mode, decision]);
    }
  });

  it("the contract's tools follow their kinds", () => {
    for (const m of APPROVAL_MODES) {
      for (const t of TOOLS) expect(allowed(t.name, m.name)).toBe(KIND_DECISIONS[m.name][t.kind]);
    }
  });

  it("each mode allows at least what plan does", () => {
    const rank = { deny: 0, ask: 1, allow: 2 } as const;
    for (const kind of TOOL_KINDS) {
      for (const readOnly of [false, true]) {
        const ranks = MODE_NAMES.map((m) => rank[allowed("own_tool", m, kind, { readOnly })]);
        expect(ranks).toEqual([...ranks].sort());
      }
    }
  });

  it("knows its kinds", () => {
    expect(TOOL_KINDS).toEqual(["read", "write", "shell", "network", "mcp", "meta"]);
    for (const decisions of Object.values(KIND_DECISIONS)) expect(Object.keys(decisions).sort()).toEqual([...TOOL_KINDS].sort());
    expect(() => allowed("own_tool", "ask", "telepathy" as AnyToolKind)).toThrow(/unknown tool kind/);
  });

  it("adds a client's own tools to the mode's", () => {
    const fetch: ExtraTool = { name: "web_fetch", kind: "network", description: "Fetch a URL." };
    const todo: ExtraTool = { name: "todo_write", kind: "meta", description: "Keep a to-do list." };
    const search: ExtraTool = { name: "mcp__gh__search", kind: "mcp", description: "Search code.", read_only: true };
    expect(toolsForMode("plan", [fetch, todo, search]).map((t) => t.function.name)).toEqual([
      ...READ_ONLY_TOOLS,
      "todo_write",
      "mcp__gh__search",
    ]);
    const yolo = toolsForMode("yolo", [fetch]);
    expect(yolo[yolo.length - 1]).toEqual({
      type: "function",
      function: {
        name: "web_fetch",
        description: "Fetch a URL.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    });
    expect(() => toolsForMode("ask", [{ name: "edit", kind: "read", description: "A fake edit." }])).toThrow(/contract tool/);
  });
});

describe("protected files", () => {
  it.each(CASES.protected.map((c) => [c.path, c] as const))("%s", (_, c) => {
    expect(isProtected(c.path)).toBe(c.protected);
    for (const [key, decision] of Object.entries(c.decisions)) {
      const [tool, mode] = key.split(" ") as [string, string];
      expect([key, allowed(tool, mode, null, { path: c.path })]).toEqual([key, decision]);
    }
  });

  it("lists them, and the agent index exports the matcher and the CRLF flag", () => {
    expect(PROTECTED).toEqual([".matterwaveignore", ".matterwave/", "MATTERWAVE.md", "MATTERWAVE.local.md", "AGENTS.md"]);
    expect(CONTEXT_FILES).toEqual(["MATTERWAVE.md", "MATTERWAVE.local.md", "AGENTS.md"]);
    expect(SETTINGS_DIR).toBe(".matterwave/");
    expect(PROTECTED_LIST.patterns).toEqual(PROTECTED);
    expect(EDIT_CRLF_FALLBACK).toBe(true);
    expect(agent.PROTECTED_LIST).toBe(PROTECTED_LIST);
    expect(agent.EDIT_CRLF_FALLBACK).toBe(true);
  });

  it("refuses a protected write until it is approved", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "AGENTS.md"), "x");
    mkdirSync(join(dir, ".matterwave"));
    for (const path of ["AGENTS.md", ".matterwave/settings.json", ".matterwaveignore"]) {
      expect(() => confine(dir, path, { write: true })).toThrow(PathRefusedError);
      expect(confine(dir, path, { write: true, approved: true }).relative).toBe(path);
      expect(confine(dir, path).relative).toBe(path);
    }
    expect(() => confine(dir, ".env", { write: true, approved: true })).toThrow(PathRefusedError);
  });
});

describe("refusals", () => {
  it.each(CASES.refusals.map((c) => [c.code, c] as const))("words %s", (_, c) => {
    expect(refusal(c.code, c.values)).toBe(c.expected);
  });

  it("words every code", () => {
    expect(new Set(CASES.refusals.map((c) => c.code))).toEqual(
      new Set([...Object.keys(APPROVAL_REFUSALS), "outside", "denied"]),
    );
    expect(Object.keys(REFUSALS).length + Object.keys(APPROVAL_REFUSALS).length).toBe(11);
    expect(() => refusal("nope" as RefusalCode)).toThrow(RangeError);
  });
});

// --- the prompt's slots --------------------------------------------------------

describe("prompt slots", () => {
  it.each(CASES.prompt_slots.map((c) => [c.name, c] as const))("renders %s", (_, c) => {
    expect(
      systemPrompt(c.mode, c.root, { platform: c.platform, extraTools: c.extra_tools, contextFiles: c.context_files }),
    ).toBe(c.expected);
  });

  it("names an extra tool in the tool list", () => {
    const fetch: ExtraTool = { name: "web_fetch", kind: "network", description: "Fetch a URL." };
    const text = systemPrompt("ask", "/r", { platform: "linux", extraTools: [fetch] });
    expect(text).toContain("Tools in this mode: read_file, list_dir, glob, grep, edit, write_file, run_shell, web_fetch.");
    expect(text.endsWith("- web_fetch: Fetch a URL.")).toBe(true);
  });

  it("leaves the prompt as it was when the slots are empty", () => {
    for (const c of CASES.prompts) {
      expect(systemPrompt(c.mode, c.root, { platform: c.platform, extraTools: [], contextFiles: [] })).toBe(c.expected);
    }
  });

  it("cuts a long context file", () => {
    const max = CONTRACT.system_prompt.context_files.max_chars;
    const content = "ab".repeat(max);
    const text = systemPrompt("ask", "/r", {
      platform: "linux",
      contextFiles: [{ path: "AGENTS.md", content, trusted: true }],
    });
    const block = text.split('<project-instructions path="AGENTS.md">\n')[1]!;
    const at = block.indexOf("\n[AGENTS.md is cut off here");
    expect(block.slice(0, at)).toBe(content.slice(0, max));
    expect(block.slice(at)).toBe(`\n[AGENTS.md is cut off here: it is longer than ${max} characters.]\n</project-instructions>`);
  });
});

// --- links ---------------------------------------------------------------------

describe("links", () => {
  it("a walk does not follow a link out of the root", ({ skip }) => {
    const base = tempDir();
    const root = join(base, "root");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.py"), "x\n");
    mkdirSync(join(base, "outside"));
    writeFileSync(join(base, "outside", "b.py"), "y\n");
    try {
      symlinkSync(join(base, "outside"), join(root, "escape"), "dir");
      symlinkSync(join(base, "outside", "b.py"), join(root, "b.py"), "file");
      symlinkSync(join(root, "src"), join(root, "again"), "dir");
    } catch (error) {
      skip(`symbolic links need admin or Developer Mode on Windows: ${String(error)}`);
    }
    expect([...walk(root)]).toEqual(["src/a.py"]);
    expect(runListDir(root)).toBe("again/\nsrc/");
  });
});
