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
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/__tests__/**",
        "src/types.ts",
        "node_modules/**",
      ],
      thresholds: {
        statements: 60,
        branches: 50,
        functions: 55,
        lines: 60,
      },
      reporter: ["text", "text-summary", "json-summary"],
    },
  },
});
