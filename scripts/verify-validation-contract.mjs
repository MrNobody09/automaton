#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverTestFiles } from "./test-discovery.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

function fail(message) {
  console.error(`[validation-contract] FAIL: ${message}`);
  process.exit(1);
}

function read(rel) {
  return fs.readFileSync(path.join(repoRoot, rel), "utf8");
}

const packageJson = JSON.parse(read("package.json"));
const scripts = packageJson.scripts ?? {};
for (const name of ["test", "test:ci", "test:isolated", "test:regression", "test:security", "test:financial"]) {
  const value = scripts[name];
  if (typeof value !== "string") fail(`missing package script ${name}`);
  if (!value.includes("run-isolated-tests.mjs") && value !== "pnpm test") {
    fail(`${name} must route through the process-isolated test runner; found: ${value}`);
  }
  if (/\bvitest\b/.test(value)) fail(`${name} must not invoke Vitest directly.`);
}
if (scripts["typecheck:tests"] !== "tsc -p tsconfig.tests.json --noEmit") {
  fail("typecheck:tests must typecheck the dedicated test TypeScript configuration.");
}
if (!fs.existsSync(path.join(repoRoot, "tsconfig.tests.json"))) {
  fail("tsconfig.tests.json is required so test TypeScript cannot escape static checking.");
}

const vitestConfig = read("vitest.config.ts");
if (!vitestConfig.includes('setupFiles: ["./test/setup/network-guard.ts"]')) {
  fail("Vitest must install the external-network guard for every test file.");
}
if (!vitestConfig.includes("allowOnly: false")) {
  fail("Vitest must reject .only tests in CI.");
}

const ci = read(".github/workflows/ci.yml");
const release = read(".github/workflows/release.yml");
for (const [label, workflow] of [["CI", ci], ["Release", release]]) {
  for (const required of [
    "validation:contract",
    "typecheck:tests",
    "run-isolated-tests.mjs",
    "verify-test-sensitivity.mjs",
    "pnpm audit --audit-level=high",
    "permissions:\n  contents: read",
    "persist-credentials: false",
  ]) {
    if (!workflow.includes(required)) fail(`${label} workflow is missing required validation/hardening contract: ${required}`);
  }
  if (/uses:\s+[^\n]+@v\d+\b/.test(workflow)) {
    fail(`${label} workflow uses a moving major-version action tag instead of an immutable commit SHA.`);
  }
}

const probe = "validation-topology-probe.test.mjs";
const probePath = path.join(repoRoot, probe);
fs.writeFileSync(probePath, 'import { test, expect } from "vitest"; test("probe", () => expect(true).toBe(true));\n');
let discovered;
try {
  discovered = await discoverTestFiles(repoRoot);
} finally {
  fs.rmSync(probePath, { force: true });
}
if (!discovered.includes(probe)) {
  fail("Vitest did not discover a root-level test probe; test topology contract is broken.");
}

const forbiddenModifier = /\b(?:describe|suite|test|it)\s*\.\s*(?:skip|todo|only|skipIf|runIf)\s*\(/;
for (const testFile of discovered.filter((file) => file !== probe)) {
  const content = read(testFile);
  if (forbiddenModifier.test(content)) {
    fail(`${testFile} contains a forbidden skipped/todo/only/conditional test modifier.`);
  }
}

console.log(`[validation-contract] PASS: ${discovered.length - 1} repository tests share Vitest discovery; blocking scripts use isolated execution; test TypeScript is statically checked; the network guard and allowOnly protection are mandatory; CI/Release share core gates; workflow credentials/permissions are minimized; actions are SHA-pinned; and no skipped/only/todo tests were found.`);
