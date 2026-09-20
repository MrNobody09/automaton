#!/usr/bin/env node

import { readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const shardIndex = Number.parseInt(process.argv[2] ?? "1", 10);
const shardTotal = Number.parseInt(process.argv[3] ?? "1", 10);
const perFileTimeoutMs = Number.parseInt(
  process.env.TEST_FILE_TIMEOUT_MS ?? "120000",
  10,
);
const excludedDirectories = new Set([
  ".git",
  ".pnpm-store",
  "node_modules",
  "dist",
  "coverage",
]);
const testFilePattern = /\.(?:test|spec)\.(?:ts|tsx|js|jsx|mjs|cjs)$/;

function fail(message) {
  console.error(`[isolated-tests] ${message}`);
  process.exit(1);
}

if (!Number.isInteger(shardIndex) || !Number.isInteger(shardTotal)) {
  fail("Shard index and shard total must be integers.");
}
if (shardTotal < 1 || shardIndex < 1 || shardIndex > shardTotal) {
  fail(`Invalid shard ${shardIndex}/${shardTotal}.`);
}
if (!Number.isInteger(perFileTimeoutMs) || perFileTimeoutMs < 1_000) {
  fail("TEST_FILE_TIMEOUT_MS must be an integer >= 1000.");
}

function collectTests(dir) {
  const result = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;

    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...collectTests(path));
    } else if (entry.isFile() && testFilePattern.test(entry.name)) {
      result.push(path);
    }
  }
  return result;
}

const allTests = collectTests(repoRoot)
  .map((path) => relative(repoRoot, path).replaceAll("\\", "/"))
  .sort((a, b) => a.localeCompare(b));

if (allTests.length === 0) {
  fail("No test/spec files found in the repository.");
}

const selected = allTests.filter((_, index) => index % shardTotal === shardIndex - 1);
if (selected.length === 0) {
  fail(`Shard ${shardIndex}/${shardTotal} has no test files.`);
}

const vitestBin = join(repoRoot, "node_modules", "vitest", "vitest.mjs");
try {
  if (!statSync(vitestBin).isFile()) fail("Vitest executable is unavailable.");
} catch {
  fail("Vitest executable is unavailable. Run pnpm install first.");
}

console.log(
  `[isolated-tests] Running ${selected.length}/${allTests.length} files in shard ${shardIndex}/${shardTotal}; per-file timeout ${perFileTimeoutMs}ms.`,
);

for (const testFile of selected) {
  const startedAt = Date.now();
  console.log(`\n[isolated-tests] START ${testFile}`);

  const result = spawnSync(process.execPath, [vitestBin, "run", testFile], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CI: process.env.CI ?? "true",
    },
    stdio: "inherit",
    timeout: perFileTimeoutMs,
    killSignal: "SIGKILL",
  });

  const durationMs = Date.now() - startedAt;

  if (result.error) {
    if (result.error.code === "ETIMEDOUT") {
      fail(`${testFile} exceeded ${perFileTimeoutMs}ms and was killed.`);
    }
    fail(`${testFile} could not run: ${result.error.message}`);
  }

  if (result.signal) {
    fail(`${testFile} terminated by signal ${result.signal}.`);
  }

  if (result.status !== 0) {
    fail(`${testFile} exited with status ${String(result.status)}.`);
  }

  console.log(`[isolated-tests] PASS ${testFile} (${durationMs}ms)`);
}

console.log(
  `\n[isolated-tests] PASS shard ${shardIndex}/${shardTotal}: ${selected.length} files completed in fresh processes.`,
);
