import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30_000,
    teardownTimeout: 5_000,
    allowOnly: false,
    include: ["**/*.{test,spec}.{ts,tsx,js,jsx,mjs,cjs,mts,cts}"],
    exclude: [
      "**/.git/**",
      "**/.pnpm-store/**",
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
    ],
    setupFiles: ["./test/setup/network-guard.ts"],
  },
});
