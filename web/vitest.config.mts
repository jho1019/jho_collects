import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Unit tests — no network. eBay and Supabase are always mocked (injected
// fetch / fake stores). Mirrors tsconfig's `@/*` path alias. The one
// exception, lib/ebay-api/__tests__/live/, is skipped unless EBAY_LIVE=1
// (`npm run test:live`): read-only production Browse with an app token.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
      "server-only": fileURLToPath(new URL("./test/server-only-stub.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**", ".next/**"],
  },
});
