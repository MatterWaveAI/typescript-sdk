// The same two layers web/eslint.config.js uses, minus the React plugins
// this package has no use for.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config([
  { ignores: ["dist"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.ts"],
  },
]);
