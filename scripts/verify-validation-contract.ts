#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  discoverRepositoryTestFiles,
  inspectVitestTopology,
} from "./test-discovery.js";
import {
  validateCiWorkflow,
  validatePackageScripts,
  validateReleaseWorkflow,
  validateShardPartition,
} from "./validation-rules.js";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function fail(message: string): never {
  console.error(`[validation-contract] FAIL: ${message}`);
  process.exit(1);
}

function assertSameTestUniverse(repositoryFiles: string[], vitestFiles: string[]): void {
  const repositorySet = new Set(repositoryFiles);
  const vitestSet = new Set(vitestFiles);
  const missingFromVitest = repositoryFiles.filter((file) => !vitestSet.has(file));
  const unexpectedInVitest = vitestFiles.filter((file) => !repositorySet.has(file));

  if (missingFromVitest.length > 0 || unexpectedInVitest.length > 0) {
    const details = [
      missingFromVitest.length > 0
        ? `missing from Vitest: ${missingFromVitest.join(", ")}`
        : null,
      unexpectedInVitest.length > 0
        ? `unexpected in Vitest: ${unexpectedInVitest.join(", ")}`
        : null,
    ].filter(Boolean).join("; ");
    throw new Error(`Filesystem and Vitest test discovery differ (${details}).`);
  }
}

function assertValidationCodeOwners(): void {
  const codeOwners = read(".github/CODEOWNERS");
  const requiredEntries = [
    "/.github/workflows/ @MrNobody09",
    "/scripts/run-isolated-tests.ts @MrNobody09",
    "/scripts/process-tree.ts @MrNobody09",
    "/scripts/test-discovery.ts @MrNobody09",
    "/scripts/validation-rules.ts @MrNobody09",
    "/scripts/verify-validation-contract.ts @MrNobody09",
    "/scripts/verify-package-artifacts.ts @MrNobody09",
    "/test/process-tree.test.ts @MrNobody09",
    "/test/shard-selection.test.ts @MrNobody09",
    "/test/validation-rules.test.ts @MrNobody09",
    "/test/setup/network-guard.ts @MrNobody09",
    "/src/__tests__/context-token-estimate-regression.test.ts @MrNobody09",
    "/src/__tests__/policy-regression-audit.test.ts @MrNobody09",
    "/vitest.config.ts @MrNobody09",
    "/package.json @MrNobody09",
    "/pnpm-lock.yaml @MrNobody09",
  ];
  const lines = new Set(
    codeOwners
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#")),
  );
  const missing = requiredEntries.filter((entry) => !lines.has(entry));
  if (missing.length > 0) {
    throw new Error(`CODEOWNERS must protect validation controls; missing: ${missing.join(", ")}`);
  }
}

try {
  for (const foreignLock of ["package-lock.json", "yarn.lock", "bun.lock", "bun.lockb"]) {
    if (fs.existsSync(path.join(repoRoot, foreignLock))) {
      throw new Error(`${foreignLock} must not exist: pnpm-lock.yaml is the single dependency lockfile.`);
    }
  }
  if (!fs.existsSync(path.join(repoRoot, "pnpm-lock.yaml"))) {
    throw new Error("pnpm-lock.yaml is required.");
  }

  assertValidationCodeOwners();

  const packageJson = JSON.parse(read("package.json"));
  validatePackageScripts(packageJson);

  const tsconfigTests = JSON.parse(read("tsconfig.tests.json"));
  const includes = tsconfigTests.include ?? [];
  if (!includes.includes("scripts/**/*.ts")) {
    throw new Error("tsconfig.tests.json must typecheck scripts/**/*.ts so validation tooling is statically checked.");
  }

  const ciWorkflow = parseYaml(read(".github/workflows/ci.yml"));
  const releaseWorkflow = parseYaml(read(".github/workflows/release.yml"));
  validateCiWorkflow(ciWorkflow);
  validateReleaseWorkflow(releaseWorkflow);

  const topology = await inspectVitestTopology(repoRoot);
  if (topology.projects.length === 0) throw new Error("Vitest did not load any projects.");
  for (const project of topology.projects) {
    if (project.allowOnly !== false) {
      throw new Error(`Vitest project ${project.name} must set allowOnly=false.`);
    }
    if (!project.setupFiles.includes("test/setup/network-guard.ts")) {
      throw new Error(`Vitest project ${project.name} must load test/setup/network-guard.ts.`);
    }
  }

  // Add a temporary root-level probe so both discovery mechanisms also prove
  // that tests outside today's src/__tests__ and test/ layouts remain covered.
  const probe = "validation-topology-probe.test.mjs";
  const probePath = path.join(repoRoot, probe);
  fs.writeFileSync(
    probePath,
    'import { test, expect } from "vitest"; test("probe", () => expect(true).toBe(true));\n',
  );

  let repositoryDiscovered: string[] = [];
  let vitestDiscovered: string[] = [];
  try {
    repositoryDiscovered = await discoverRepositoryTestFiles(repoRoot);
    vitestDiscovered = (await inspectVitestTopology(repoRoot)).files;
    if (!repositoryDiscovered.includes(probe)) {
      throw new Error("Independent filesystem discovery did not find the root-level test probe.");
    }
    if (!vitestDiscovered.includes(probe)) {
      throw new Error("Vitest did not discover the root-level test probe; its configuration is narrowed.");
    }
    assertSameTestUniverse(repositoryDiscovered, vitestDiscovered);
  } finally {
    fs.rmSync(probePath, { force: true });
  }

  const realTests = repositoryDiscovered.filter((file) => file !== probe);
  validateShardPartition(realTests, 4);

  const forbiddenModifier = /\b(?:describe|suite|test|it)\s*\.\s*(?:skip|todo|only|skipIf|runIf)\s*\(/;
  for (const testFile of realTests) {
    if (forbiddenModifier.test(read(testFile))) {
      throw new Error(`${testFile} contains a forbidden skipped/todo/only/conditional test modifier.`);
    }
  }

  console.log(
    `[validation-contract] PASS: ${realTests.length} repository test files exactly match Vitest discovery; validation controls and their regression tests are CODEOWNED; validation tooling is TypeScript-checked; four CI shards exactly partition discovery; workflow rules are parsed structurally and unit-tested; package scripts are unambiguous; no skipped/only/todo tests were found.`,
  );
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
