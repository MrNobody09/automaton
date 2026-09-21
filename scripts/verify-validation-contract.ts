#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { inspectVitestTopology } from "./test-discovery.js";
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

try {
  for (const foreignLock of ["package-lock.json", "yarn.lock", "bun.lock", "bun.lockb"]) {
    if (fs.existsSync(path.join(repoRoot, foreignLock))) {
      throw new Error(`${foreignLock} must not exist: pnpm-lock.yaml is the single dependency lockfile.`);
    }
  }
  if (!fs.existsSync(path.join(repoRoot, "pnpm-lock.yaml"))) {
    throw new Error("pnpm-lock.yaml is required.");
  }

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

  const probe = "validation-topology-probe.test.mjs";
  const probePath = path.join(repoRoot, probe);
  fs.writeFileSync(
    probePath,
    'import { test, expect } from "vitest"; test("probe", () => expect(true).toBe(true));\n',
  );
  let discovered: string[];
  try {
    discovered = (await inspectVitestTopology(repoRoot)).files;
  } finally {
    fs.rmSync(probePath, { force: true });
  }
  if (!discovered.includes(probe)) {
    throw new Error("Vitest did not discover a root-level test probe; canonical discovery is narrowed.");
  }

  const realTests = discovered.filter((file) => file !== probe);
  validateShardPartition(realTests, 4);

  const forbiddenModifier = /\b(?:describe|suite|test|it)\s*\.\s*(?:skip|todo|only|skipIf|runIf)\s*\(/;
  for (const testFile of realTests) {
    if (forbiddenModifier.test(read(testFile))) {
      throw new Error(`${testFile} contains a forbidden skipped/todo/only/conditional test modifier.`);
    }
  }

  console.log(
    `[validation-contract] PASS: ${realTests.length} tests use canonical Vitest discovery; validation tooling is TypeScript-checked; four CI shards exactly partition discovery; workflow rules are parsed structurally and unit-tested; package scripts are unambiguous; no skipped/only/todo tests were found.`,
  );
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
