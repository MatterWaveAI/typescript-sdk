import { defineConfig } from "vitest/config";

// Node environment: the client uses only fetch, ReadableStream and
// TextDecoder, all of which Node 18+ has natively, so there is nothing a DOM
// shim would add. The tests stub fetch rather than a server.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
