#!/usr/bin/env node

import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { discoverTestFiles, selectTestShard } from "./test-discovery.js";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const shardIndex = Number.parseInt(process.argv[2] ?? "1", 10);
const shardTotal = Number.parseInt(process.argv[3] ?? "1", 10);
const perFileTimeoutMs = Number.parseInt(process.env.TEST_FILE_TIMEOUT_MS ?? "120000", 10);

let activeChild: ChildProcess | null = null;
let shuttingDown = false;

function fail(message: string): never {
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

const allTests = await discoverTestFiles(repoRoot);
if (allTests.length === 0) fail("Repository discovery found no test/spec files.");

const selected = selectTestShard(allTests, shardIndex, shardTotal);
if (selected.length === 0) fail(`Shard ${shardIndex}/${shardTotal} has no test files.`);

const vitestBin = join(repoRoot, "node_modules", "vitest", "vitest.mjs");
try {
  if (!statSync(vitestBin).isFile()) fail("Vitest executable is unavailable.");
} catch {
  fail("Vitest executable is unavailable. Run pnpm install first.");
}

function terminateProcessTree(child: ChildProcess): void {
  if (!child.pid) return;

  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }

  // Child processes are spawned as their own process group. Signalling the
  // negative PID terminates Vitest together with workers/grandchildren instead
  // of recreating the historical orphan-worker failure mode.
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // Process already exited.
    }
  }
}

function handleParentSignal(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  if (activeChild) terminateProcessTree(activeChild);
  console.error(`[isolated-tests] Received ${signal}; terminated active test process tree.`);
  process.exit(signal === "SIGINT" ? 130 : 143);
}

process.once("SIGINT", () => handleParentSignal("SIGINT"));
process.once("SIGTERM", () => handleParentSignal("SIGTERM"));

async function runTestFile(testFile: string): Promise<void> {
  const startedAt = Date.now();
  console.log(`\n[isolated-tests] START ${testFile}`);

  await new Promise<void>((resolvePromise, rejectPromise) => {
    let timedOut = false;
    let settled = false;

    const child = spawn(process.execPath, [vitestBin, "run", testFile], {
      cwd: repoRoot,
      env: { ...process.env, CI: process.env.CI ?? "true" },
      stdio: "inherit",
      // On POSIX this creates a process group so timeout cleanup can kill the
      // complete descendant tree. Windows uses taskkill /T instead.
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    activeChild = child;

    const timeout = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child);
    }, perFileTimeoutMs);
    timeout.unref();

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (activeChild === child) activeChild = null;
      if (error) rejectPromise(error);
      else resolvePromise();
    };

    child.once("error", (error) => {
      finish(new Error(`${testFile} could not run: ${error.message}`));
    });

    child.once("close", (code, signal) => {
      if (timedOut) {
        finish(new Error(`${testFile} exceeded ${perFileTimeoutMs}ms; the complete test process tree was killed.`));
        return;
      }
      if (signal) {
        finish(new Error(`${testFile} terminated by signal ${signal}.`));
        return;
      }
      if (code !== 0) {
        finish(new Error(`${testFile} exited with status ${String(code)}.`));
        return;
      }
      finish();
    });
  });

  console.log(`[isolated-tests] PASS ${testFile} (${Date.now() - startedAt}ms)`);
}

console.log(`[isolated-tests] Repository discovery found ${allTests.length} total files.`);
console.log(`[isolated-tests] Running ${selected.length}/${allTests.length} files in shard ${shardIndex}/${shardTotal}; per-file timeout ${perFileTimeoutMs}ms.`);

for (const testFile of selected) {
  try {
    await runTestFile(testFile);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

console.log(`\n[isolated-tests] PASS shard ${shardIndex}/${shardTotal}: ${selected.length} files completed in fresh process groups.`);
