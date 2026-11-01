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

import { execFileSync } from "node:child_process";
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
  GlobError,
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
  checkLines,
  confine,
  fill,
  formatReadFile,
  formatShell,
  globMatches,
  globToRegex,
  isProtected,
  limit,
  loadSearchIgnore,
  refusal,
  runGlob,
  runGlobAsync,
  runGrep,
  runGrepAsync,
  runListDir,
  runReadFile,
  systemPrompt,
  toolsForMode,
  utf8Head,
  utf8Tail,
  walk,
  walkAsync,
  windowsAlias,
  type AnyToolKind,
  type ExtraTool,
  type Limits,
  type RefusalCode,
} from "../src/agent/node.js";
import { agent } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));

type Special = "links" | "fifos";

interface ToolCase {
  tool: "read_file" | "list_dir" | "glob" | "grep";
  args: Record<string, string | number | boolean>;
  needs?: Special[];
  limits?: Limits;
  expected?: string;
  error?: string;
  refused?: string;
  message?: string;
  message_prefix?: string;
}

interface Conformance {
  tree: Record<string, string>;
  links: Record<string, string>;
  fifos: string[];
  paths: { path: string; write?: boolean; needs?: Special[]; relative?: string; refused?: string; message?: string }[];
  tools: ToolCase[];
  ignore: { path: string; is_dir?: boolean; ancestors?: boolean; ignored: boolean }[];
  shell: {
    output: string;
    omitted?: number;
    exit_code?: number | null;
    timed_out?: boolean;
    stopped?: boolean;
    timeout_s?: number;
    limits?: Limits;
    expected: string;
  }[];
  alias_roots: { root: string; path: string; refused: string | null }[];
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

/** The conformance `fifos` and `links`, where this platform can make them: the kinds it made. */
function makeSpecials(root: string): Set<Special> {
  const made = new Set<Special>();
  if (process.platform !== "win32") {
    for (const relative of CONFORMANCE.fifos) execFileSync("mkfifo", [join(root, relative)]);
    made.add("fifos");
  }
  try {
    for (const [relative, target] of Object.entries(CONFORMANCE.links)) symlinkSync(target, join(root, relative), "file");
    made.add("links");
  } catch {
    // Windows without Developer Mode cannot make links.
  }
  return made;
}

const MADE = new Set<Special>();

function unmet(c: { needs?: Special[] }): string | null {
  const missing = (c.needs ?? []).filter((n) => !MADE.has(n));
  return missing.length > 0 ? `this platform cannot make ${missing.join(", ")}` : null;
}

type Run<T> = (root: string, c: ToolCase) => T;

function runner(sync: boolean): Run<string | Promise<string>> {
  return (root, c) => {
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
        return (sync ? runGlob : runGlobAsync)(root, a.pattern as string, { path: a.path as string | undefined, limits });
      case "grep":
        return (sync ? runGrep : runGrepAsync)(root, a.pattern as string, {
          path: a.path as string | undefined,
          glob: a.glob as string | undefined,
          ignoreCase: a.ignore_case as boolean | undefined,
          limits,
        });
    }
  };
}

const run = runner(true) as Run<string>;
const runAsync = runner(false);

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
  for (const kind of makeSpecials(tree)) MADE.add(kind);
});

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

// --- the read tools' output ----------------------------------------------------

function expectOutcome(c: ToolCase, got: string | undefined, thrown: unknown): void {
  if (c.expected !== undefined) {
    if (thrown !== undefined) throw thrown;
    expect(got).toBe(c.expected);
    return;
  }
  expect(thrown).toBeInstanceOf(c.refused ? PathRefusedError : ToolError);
  const error = thrown as PathRefusedError | ToolError;
  expect(error.reason).toBe(c.refused ?? c.error);
  if (c.message !== undefined) expect(error.message).toBe(c.message);
  else expect(error.message.startsWith(c.message_prefix!)).toBe(true);
}

const TOOL_CASES = CONFORMANCE.tools.map((c) => [`${c.tool} ${JSON.stringify(c.args)}${c.limits ? " limits" : ""}`, c] as const);

describe("tool output", () => {
  it.for(TOOL_CASES)("%s", ([, c], { skip }) => {
    const why = unmet(c);
    if (why) skip(why);
    let got: string | undefined;
    let thrown: unknown;
    try {
      got = run(tree, c);
    } catch (error) {
      thrown = error;
    }
    expectOutcome(c, got, thrown);
  });

  it.for(TOOL_CASES.filter(([, c]) => c.tool === "glob" || c.tool === "grep"))("async %s", async ([, c], { skip }) => {
    const why = unmet(c);
    if (why) skip(why);
    let got: string | undefined;
    let thrown: unknown;
    try {
      got = await runAsync(tree, c);
    } catch (error) {
      thrown = error;
    }
    expectOutcome(c, got, thrown);
  });

  it("has a case for every tool error", () => {
    // run_shell's bad_timeout is no read tool's, and grep's timeout depends on
    // the machine; both have tests of their own.
    const covered = new Set(CONFORMANCE.tools.flatMap((c) => (c.error ? [c.error] : [])));
    expect([...covered].sort()).toEqual(
      Object.keys(TOOL_ERRORS)
        .filter((k) => k !== "bad_timeout" && k !== "timeout")
        .sort(),
    );
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

// --- what confine makes of a path ---------------------------------------------

describe("confine paths", () => {
  it.for(CONFORMANCE.paths.map((c) => [`${JSON.stringify(c.path)}${c.write ? " (write)" : ""}`, c] as const))(
    "%s",
    ([, c], { skip }) => {
      const why = unmet(c);
      if (why) skip(why);
      if (c.relative !== undefined) {
        expect(confine(tree, c.path, { write: c.write ?? false }).relative).toBe(c.relative);
        return;
      }
      let thrown: unknown;
      try {
        confine(tree, c.path, { write: c.write ?? false });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(PathRefusedError);
      expect((thrown as PathRefusedError).reason).toBe(c.refused);
      expect((thrown as PathRefusedError).message).toBe(c.message);
    },
  );

  it("names the Windows aliases without the filesystem", () => {
    const aliases = new Set(["stream", "trailing", "device", "unc"]);
    for (const c of CONFORMANCE.paths) {
      if (c.refused !== undefined && aliases.has(c.refused)) expect([c.path, windowsAlias(c.path)]).toEqual([c.path, c.refused]);
      else if (c.relative !== undefined) expect([c.path, windowsAlias(c.path)]).toEqual([c.path, null]);
    }
  });

  it("refuses a path the OS cannot follow with its own error", () => {
    const dir = tempDir();
    for (const path of ["nul", "NUL.txt", "con", "COM1", "x:y", "\\\\.\\nul", "src\\aux.txt"]) {
      expect(() => confine(dir, path)).toThrow(PathRefusedError);
    }
    expect(() => confine(dir, "Z:\\elsewhere\\file.txt")).toThrow(PathRefusedError);
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
        omitted: c.omitted,
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
    expect(PROTECTED).toEqual([".matterwaveignore", ".matterwave/", "MATTERWAVE.md", "MATTERWAVE.local.md", "AGENTS.md", ".bashrc", ".bash_profile", ".profile", ".zshrc", ".zprofile", ".ssh/", ".aws/", "**/.config/matterwave"]);
    // The personal file comes last, so it wins where it and a shared one disagree.
    expect(CONTEXT_FILES).toEqual(["MATTERWAVE.md", "AGENTS.md", "MATTERWAVE.local.md"]);
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
    expect([...Object.keys(REFUSALS), ...Object.keys(APPROVAL_REFUSALS)].sort()).toEqual(
      [
        ...["empty", "parent", "outside", "symlink", "loop", "denied", "protected", "stream", "trailing", "device", "unc"],
        ...["mode", "unknown_tool", "rejected", "headless", "needs_approval"],
      ].sort(),
    );
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

  it("refuses a loop of links", ({ skip }) => {
    const dir = tempDir();
    try {
      symlinkSync("loop", join(dir, "loop"), "file");
      symlinkSync("pong", join(dir, "ping"), "file");
      symlinkSync("ping", join(dir, "pong"), "file");
    } catch (error) {
      skip(`symbolic links need admin or Developer Mode on Windows: ${String(error)}`);
    }
    writeFileSync(join(dir, "a.txt"), "x\n");
    for (const path of ["loop", "ping", "pong/x", join(dir, "ping")]) {
      let thrown: unknown;
      try {
        confine(dir, path, { write: true });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(PathRefusedError);
      expect([path, (thrown as PathRefusedError).reason]).toEqual([path, "loop"]);
    }
    expect([...walk(dir)]).toEqual(["a.txt"]);
    expect(runListDir(dir)).toBe("a.txt");
  });
});

// --- 1.1.1 fixes -----------------------------------------------------------------

function reasonOf(call: () => unknown): string | undefined {
  try {
    call();
  } catch (error) {
    return (error as { reason?: string }).reason;
  }
  return undefined;
}

describe("1.1.1 fixes", () => {
  it.each(CONFORMANCE.alias_roots.map((c) => [`${JSON.stringify(c.path)} in ${JSON.stringify(c.root)}`, c] as const))(
    "checks only the names below the root: %s",
    (_, c) => {
      expect(windowsAlias(c.path, c.root)).toBe(c.refused);
    },
  );

  it.skipIf(process.platform === "win32").each(["con", "a:b", "x.", "NUL.d"])(
    "takes absolute paths into a root inside %s",
    (parent) => {
      const root = join(tempDir(), parent, "repo");
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src", "a.py"), "x = 1\n");
      const absolute = join(root, "src", "a.py");
      expect(confine(root, absolute).relative).toBe("src/a.py");
      expect(runReadFile(root, absolute)).toBe("1\tx = 1");
      expect(runGrep(root, "x", { path: root })).toBe("src/a.py:1: x = 1");
      expect(reasonOf(() => confine(root, join(root, "nul.txt")))).toBe("device");
    },
  );

  it("drops a byte-order mark before the first rule", () => {
    expect(new IgnoreFile("\ufeff*.log\n").match("a.log")).toBe(true);
    expect(DenyList.withIgnoreFile("\ufeffsecrets/\n").matches("secrets/x")).toBe(true);
    const files: Record<string, string> = { ".gitignore": "\ufeffbuild/\n" };
    expect(new SearchIgnore((r) => files[r] ?? null).ignored("build/a.txt")).toBe(true);
  });

  it("skips an invalid ignore line", () => {
    const rules = new IgnoreFile("[z-a]\n*.log\n!keep.log\n");
    expect(rules.match("a.log")).toBe(true);
    expect(rules.match("keep.log")).toBe(false);
    expect(rules.match("z")).toBe(null);
    const deny = DenyList.withIgnoreFile("[9-0]*\nprivate/\n");
    expect(deny.matches("private/x")).toBe(true);
    expect(deny.matches("9")).toBe(false);
  });

  it("keeps searching and confining past an invalid ignore file", () => {
    const dir = tempDir();
    writeFileSync(join(dir, ".gitignore"), "[z-a]\n*.log\n");
    writeFileSync(join(dir, ".matterwaveignore"), "[z-a]\nsecret/\n");
    writeFileSync(join(dir, "a.txt"), "hit\n");
    writeFileSync(join(dir, "b.log"), "hit\n");
    expect(runGrep(dir, "hit")).toBe("a.txt:1: hit");
    expect(confine(dir, "a.txt").relative).toBe("a.txt");
    expect(reasonOf(() => confine(dir, "secret/x"))).toBe("denied");
  });

  it("reads glob classes alike in every dialect", () => {
    expect(globMatches("[]x]", "]")).toBe(true);
    expect(globMatches("[!]x]", "a")).toBe(true);
    expect(globMatches("[!]x]", "]")).toBe(false);
    expect(globMatches("[^a]", "b")).toBe(true);
    expect(globMatches("[^a]", "A")).toBe(false);
    expect(globMatches("[a-]", "-")).toBe(true);
    expect(globMatches("[\\]", "\\")).toBe(true);
    expect(globMatches("[!]", "[!]")).toBe(true);
    expect(globMatches("a[b", "a[b")).toBe(true);
    expect(() => globToRegex("[z-a]")).toThrow(GlobError);
    expect(reasonOf(() => globMatches("[z-a]", "x"))).toBe("invalid_glob");
  });

  it("refuses an invalid glob before searching", async () => {
    const dir = tempDir();
    expect(reasonOf(() => runGlob(dir, "[z-a]", { path: "nowhere" }))).toBe("invalid_glob");
    expect(reasonOf(() => runGrep(dir, "x", { path: "nowhere", glob: "[z-a]" }))).toBe("invalid_glob");
    await expect(runGlobAsync(dir, "[z-a]")).rejects.toMatchObject({ reason: "invalid_glob" });
  });

  it.skipIf(process.platform === "win32")("never waits on a named pipe", async () => {
    const dir = tempDir();
    execFileSync("mkfifo", [join(dir, "pipe")]);
    writeFileSync(join(dir, "a.txt"), "x\n");
    for (const call of [
      () => runReadFile(dir, "pipe"),
      () => runGrep(dir, "x", { path: "pipe" }),
      () => runListDir(dir, "pipe"),
      () => [...walk(dir, "pipe")],
    ]) {
      expect(reasonOf(call)).toBe("special_file");
    }
    expect(runGrep(dir, "x")).toBe("a.txt:1: x");
    expect(await runGrepAsync(dir, "x")).toBe("a.txt:1: x");
    expect(runListDir(dir)).toBe("a.txt");
  });

  it("walks alike sync and async", async () => {
    const walked: string[] = [];
    for await (const path of walkAsync(tree)) walked.push(path);
    expect(walked).toEqual([...walk(tree)]);
    const one: string[] = [];
    for await (const path of walkAsync(tree, "src/main.py")) one.push(path);
    expect(one).toEqual(["src/main.py"]);
  });

  it("yields to the event loop while it searches", async () => {
    const dir = tempDir();
    for (let i = 0; i < 300; i++) writeFileSync(join(dir, `f${i}.txt`), "TODO\n".repeat(50));
    let ticks = 0;
    let running = true;
    const tick = () => {
      ticks += 1;
      if (running) setImmediate(tick);
    };
    setImmediate(tick);
    const text = await runGrepAsync(dir, "TODO", { limits: { search_max_results: 100000 } });
    running = false;
    expect(text.split("\n").length).toBe(300 * 50);
    expect(ticks).toBeGreaterThan(0);
  });

  it("stops a runaway pattern at its deadline on a worker thread", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "slow.txt"), "a".repeat(40) + "b\n");
    const started = Date.now();
    await expect(runGrepAsync(dir, "(a+)+$", { timeoutS: 0.3 })).rejects.toMatchObject({
      reason: "timeout",
      message: "The search for (a+)+$ stopped after 0.3 s without finishing. Try a simpler pattern, a narrower path or a glob.",
    });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(await runGrepAsync(dir, "b$", { timeoutS: 30 })).toBe(`slow.txt:1: ${"a".repeat(40)}b`);
    await expect(runGrepAsync(dir, "x", { timeoutS: 0 })).rejects.toThrow(RangeError);
  });

  it("formats a head and tail a client kept", () => {
    const limits = { shell_output_max_bytes: 64 };
    const whole = Array.from({ length: 200 }, (_, n) => `line ${n} é😀\n`).join("");
    const data = Buffer.from(whole, "utf-8");
    for (const keep of [32, 33, 40, 64]) {
      const head = new TextDecoder().decode(data.subarray(0, keep), { stream: true });
      let tail = new TextDecoder().decode(data.subarray(data.length - keep));
      tail = tail.replace(/^\ufffd+/, "");
      const dropped = data.length - Buffer.byteLength(head) - Buffer.byteLength(tail);
      expect([keep, formatShell(head + tail, { exitCode: 0, limits, omitted: dropped })]).toEqual([
        keep,
        formatShell(whole, { exitCode: 0, limits }),
      ]);
    }
    expect(formatShell("", { exitCode: 0, omitted: 4 })).toBe("Exit code 0\n\n[... 4 bytes of output cut from the middle ...]\n");
    expect(() => formatShell("x", { exitCode: 0, omitted: -1 })).toThrow(RangeError);
  });

  it("exports the helpers clients reimplemented", () => {
    expect(fill("{a} {b}", { a: "1" })).toBe("1 {b}");
    expect(limit("read_max_lines")).toBe(LIMITS.read_max_lines);
    expect(limit("read_max_lines", { read_max_lines: 3 })).toBe(3);
    checkLines(1, 1);
    expect(reasonOf(() => checkLines(0))).toBe("bad_line");
    expect(reasonOf(() => checkLines(3, 2))).toBe("end_before_start");
    expect(agent.fill).toBe(fill);
    expect(agent.checkLines).toBe(checkLines);
    expect(agent.limit).toBe(limit);
  });
});
