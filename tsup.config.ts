import { defineConfig } from "tsup";

// One entry, both module formats, one .d.ts. ES2020 is what Node 18 and
// every evergreen browser run; nothing here needs a newer target.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2020",
  platform: "neutral",
});
