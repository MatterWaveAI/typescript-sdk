import { defineConfig } from "tsup";

// Two entries, both module formats, a .d.ts each. The main one runs in Node
// 20+, Bun, Deno and every evergreen browser (ES2020; nothing needs a newer
// target);
// `agent` adds path confinement, which reads the filesystem, so it is
// Node-only and its `node:` imports stay external.
export default defineConfig({
  entry: { index: "src/index.ts", agent: "src/agent/node.ts" },
  external: [/^node:/],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2020",
  platform: "neutral",
});
