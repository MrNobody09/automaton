#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { inspectVitestTopology } from "./test-discovery.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

function fail(message) {
  console.error(`[validation-contract] FAIL: ${message}`);
  process.exit(1);
}

function read(rel) {
  return fs.readFileSync(path.join(repoRoot, rel), "utf8");
}

function isEnabled(value) {
  return value === 1 || value === "1" || value === true || value === "true";
}

function sameScalarSet(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  const normalizedActual = actual.map(String).sort();
  const normalizedExpected = expected.map(String).sort();
  return normalizedActual.every((value, index) => value === normalizedExpected[index]);
}

for (const foreignLock of ["package-lock.json", "yarn.lock", "bun.lock", "bun.lockb"]) {
  if (fs.existsSync(path.join(repoRoot, foreignLock))) {
    fail(`${foreignLock} must not exist: pnpm-lock.yaml is the repository's single dependency lockfile.`);
  }
}
if (!fs.existsSync(path.join(repoRoot, "pnpm-lock.yaml"))) {
  fail("pnpm-lock.yaml is required as the repository's dependency lockfile.");
}

const packageJson = JSON.parse(read("package.json"));
if (packageJson.packageManager !== "pnpm@10.28.1") {
  fail(`packageManager must remain pinned to pnpm@10.28.1; found ${String(packageJson.packageManager)}`);
}
const scripts = packageJson.scripts ?? {};
for (const [name, value] of Object.entries(scripts)) {
  if (name !== "test" && !name.startsWith("test:")) continue;
  if (typeof value !== "string") fail(`package script ${name} must be a string`);
  if (!value.includes("run-isolated-tests.mjs") && value !== "pnpm test") {
    fail(`${name} must route through the process-isolated test runner; found: ${value}`);
  }
  if (/\bvitest\b/.test(value)) fail(`${name} must not invoke Vitest directly.`);
}
for (const requiredName of ["test", "test:ci", "test:isolated", "test:regression", "test:security", "test:financial"]) {
  if (!(requiredName in scripts)) fail(`missing package script ${requiredName}`);
}
if (scripts["typecheck:tests"] !== "tsc -p tsconfig.tests.json --noEmit") {
  fail("typecheck:tests must typecheck the dedicated test TypeScript configuration.");
}
if (!fs.existsSync(path.join(repoRoot, "tsconfig.tests.json"))) {
  fail("tsconfig.tests.json is required so test TypeScript cannot escape static checking.");
}

const topology = await inspectVitestTopology(repoRoot);
if (topology.projects.length === 0) fail("Vitest did not load any projects.");
for (const project of topology.projects) {
  if (project.allowOnly !== false) fail(`Vitest project ${project.name} must set allowOnly=false.`);
  if (!project.setupFiles.includes("test/setup/network-guard.ts")) {
    fail(`Vitest project ${project.name} must load test/setup/network-guard.ts.`);
  }
}

function assertNoExternalTestNetworkEnv(env, label) {
  if (env && typeof env === "object" && isEnabled(env.AUTOMATON_TEST_ALLOW_NETWORK)) {
    fail(`${label} must not enable AUTOMATON_TEST_ALLOW_NETWORK.`);
  }
}

function assertPinnedAction(step, label) {
  if (!step || typeof step !== "object" || typeof step.uses !== "string") return;
  const uses = step.uses;
  if (uses.startsWith("./")) return;
  if (!/^[^@]+@[0-9a-f]{40}$/i.test(uses)) fail(`${label} action must be pinned to an exact commit SHA: ${uses}`);
}

function commandOf(step) {
  return step && typeof step === "object" && typeof step.run === "string" ? step.run.trim() : null;
}

function isBlocking(step) {
  return step?.["continue-on-error"] !== true && step?.continueOnError !== true;
}

function workflowHasBlockingCommand(workflow, predicate) {
  return Object.values(workflow.jobs ?? {}).some((job) =>
    (job?.steps ?? []).some((step) => {
      const command = commandOf(step);
      return isBlocking(step) && typeof command === "string" && predicate(command);
    }),
  );
}

function validateWorkflow(file, label) {
  const workflow = parseYaml(read(file));
  if (!workflow || typeof workflow !== "object") fail(`${label} workflow could not be parsed.`);

  const permissionKeys = Object.keys(workflow.permissions ?? {});
  if (permissionKeys.length !== 1 || permissionKeys[0] !== "contents" || workflow.permissions.contents !== "read") {
    fail(`${label} workflow permissions must be exactly contents: read.`);
  }
  assertNoExternalTestNetworkEnv(workflow.env, `${label} workflow-level env`);

  const jobs = workflow.jobs ?? {};
  if (Object.keys(jobs).length === 0) fail(`${label} workflow must define jobs.`);

  for (const [jobName, job] of Object.entries(jobs)) {
    if (!Array.isArray(job?.steps) || job.steps.length === 0) fail(`${label} job ${jobName} must define non-empty steps.`);
    assertNoExternalTestNetworkEnv(job.env, `${label} job ${jobName} env`);

    const checkoutSteps = job.steps.filter((step) => typeof step?.uses === "string" && step.uses.startsWith("actions/checkout@"));
    if (checkoutSteps.length !== 1) fail(`${label} job ${jobName} must contain exactly one checkout step.`);

    for (const step of job.steps) {
      assertPinnedAction(step, `${label} job ${jobName}`);
      assertNoExternalTestNetworkEnv(step?.env, `${label} job ${jobName} step env`);
      if (typeof step?.uses === "string" && step.uses.startsWith("actions/checkout@") && step.with?.["persist-credentials"] !== false) {
        fail(`${label} checkout in job ${jobName} must set persist-credentials: false.`);
      }
    }
  }

  for (const requiredCommand of [
    "pnpm run validation:contract",
    "pnpm run typecheck:tests",
    "node scripts/verify-test-sensitivity.mjs",
    "pnpm audit --audit-level=high",
    "pnpm run typecheck",
    "pnpm run build",
  ]) {
    if (!workflowHasBlockingCommand(workflow, (command) => command === requiredCommand)) {
      fail(`${label} workflow is missing blocking command: ${requiredCommand}`);
    }
  }
  if (!workflowHasBlockingCommand(workflow, (command) => command.startsWith("node scripts/run-isolated-tests.mjs"))) {
    fail(`${label} workflow is missing a blocking isolated full-suite command.`);
  }

  return workflow;
}

const ciWorkflow = validateWorkflow(".github/workflows/ci.yml", "CI");
const releaseWorkflow = validateWorkflow(".github/workflows/release.yml", "Release");

const ciBuild = ciWorkflow.jobs?.["build-and-typecheck"];
if (!sameScalarSet(ciBuild?.strategy?.matrix?.["node-version"], [20, 22])) {
  fail("CI build-and-typecheck matrix must cover exactly Node 20 and 22.");
}
const ciFull = ciWorkflow.jobs?.["isolated-full-suite"];
if (!sameScalarSet(ciFull?.strategy?.matrix?.["node-version"], [20, 22])) {
  fail("CI isolated-full-suite matrix must cover exactly Node 20 and 22.");
}
if (!sameScalarSet(ciFull?.strategy?.matrix?.shard, [1, 2, 3, 4])) {
  fail("CI isolated-full-suite matrix must retain exactly shards 1,2,3,4.");
}
if (ciFull?.strategy?.["fail-fast"] !== false) {
  fail("CI isolated-full-suite must keep fail-fast: false so every shard reports independently.");
}
if (!Number.isFinite(ciFull?.["timeout-minutes"]) || ciFull["timeout-minutes"] > 15) {
  fail("CI isolated-full-suite must keep a hard timeout of 15 minutes or less.");
}

const releaseValidation = releaseWorkflow.jobs?.["release-validation"];
if (!sameScalarSet(releaseValidation?.strategy?.matrix?.["node-version"], [20, 22])) {
  fail("Release validation matrix must cover exactly Node 20 and 22.");
}
if (releaseValidation?.strategy?.["fail-fast"] !== false) {
  fail("Release validation must keep fail-fast: false so both supported Node versions report independently.");
}
if (!workflowHasBlockingCommand({ jobs: { "release-validation": releaseValidation } }, (command) => command === "node scripts/run-isolated-tests.mjs")) {
  fail("Release validation matrix must run the complete process-isolated suite on each supported Node version.");
}

const probe = "validation-topology-probe.test.mjs";
const probePath = path.join(repoRoot, probe);
fs.writeFileSync(probePath, 'import { test, expect } from "vitest"; test("probe", () => expect(true).toBe(true));\n');
let discovered;
try {
  discovered = (await inspectVitestTopology(repoRoot)).files;
} finally {
  fs.rmSync(probePath, { force: true });
}
if (!discovered.includes(probe)) fail("Vitest did not discover a root-level test probe; test topology contract is broken.");

const forbiddenModifier = /\b(?:describe|suite|test|it)\s*\.\s*(?:skip|todo|only|skipIf|runIf)\s*\(/;
for (const testFile of discovered.filter((file) => file !== probe)) {
  const content = read(testFile);
  if (forbiddenModifier.test(content)) fail(`${testFile} contains a forbidden skipped/todo/only/conditional test modifier.`);
}

console.log(`[validation-contract] PASS: ${discovered.length - 1} repository tests share loaded Vitest topology; pnpm has the only lockfile; every test script uses isolated execution; test TypeScript is statically checked; loaded Vitest projects enforce network setup and allowOnly=false; CI keeps Node 20/22 plus four independent shards; Release independently validates Node 20/22; workflows are structurally fail-closed with minimized permissions, checkout credentials and SHA-pinned actions; no skipped/only/todo tests were found.`);
