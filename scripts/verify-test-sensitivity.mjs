#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const vitestBin = path.join(repoRoot, "node_modules", "vitest", "vitest.mjs");
const isolatedRunner = path.join(repoRoot, "scripts", "run-isolated-tests.mjs");
const validationContract = path.join(repoRoot, "scripts", "verify-validation-contract.mjs");

function fail(message) {
  console.error(`[sensitivity] FAIL: ${message}`);
  process.exit(1);
}

function command(commandName, args, options = {}) {
  return spawnSync(commandName, args, {
    cwd: repoRoot,
    env: { ...process.env, CI: "true", ...(options.env ?? {}) },
    encoding: "utf8",
    timeout: options.timeoutMs ?? 90_000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

function combinedOutput(result) {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

function requireCleanWorkingTree(stage) {
  const result = command("git", ["status", "--porcelain"], { timeoutMs: 10_000 });
  if (result.error || result.status !== 0) fail(`could not inspect git status ${stage}`);
  if ((result.stdout ?? "").trim() !== "") fail(`working tree is not clean ${stage}:\n${result.stdout}`);
}

function expectRejected(label, result, requiredText, { allowTimeout = false } = {}) {
  if (result.error) {
    if (allowTimeout && result.error.code === "ETIMEDOUT") {
      console.log(`[sensitivity] DETECTED: ${label} (execution timeout)`);
      return;
    }
    fail(`${label} did not fail cleanly: ${result.error.message}`);
  }
  if (result.signal) fail(`${label} terminated by signal ${result.signal} instead of producing a controlled test failure.`);
  if (result.status === 0) fail(`${label} unexpectedly passed. The validation suite did not detect the injected defect.`);
  const output = combinedOutput(result);
  if (requiredText && !output.includes(requiredText)) {
    fail(`${label} failed for an unexpected reason; expected output to mention ${requiredText}.\n${output.slice(-4000)}`);
  }
  console.log(`[sensitivity] DETECTED: ${label}`);
}

function replaceOnce(source, search, replacement, label) {
  const first = source.indexOf(search);
  if (first < 0) fail(`${label}: mutation target was not found.`);
  const second = source.indexOf(search, first + search.length);
  if (second >= 0) fail(`${label}: mutation target is ambiguous (found more than once).`);
  return `${source.slice(0, first)}${replacement}${source.slice(first + search.length)}`;
}

function mutateFile(file, replacements, label, action) {
  const absolute = path.join(repoRoot, file);
  const original = fs.readFileSync(absolute, "utf8");
  let mutated = original;
  try {
    for (const [search, replacement] of replacements) mutated = replaceOnce(mutated, search, replacement, label);
    fs.writeFileSync(absolute, mutated);
    action();
  } finally {
    fs.writeFileSync(absolute, original);
  }
}

function runVitest(testFile, timeoutMs = 90_000) {
  return command(process.execPath, [vitestBin, "run", testFile], { timeoutMs });
}

function sourceMutationControl({ label, file, replacements, testFile, timeoutMs, allowTimeout = false }) {
  mutateFile(file, replacements, label, () => {
    const result = runVitest(testFile, timeoutMs);
    expectRejected(label, result, testFile, { allowTimeout });
  });
}

function contractMutationControl({ label, file, replacements, requiredText }) {
  mutateFile(file, replacements, label, () => {
    const result = command(process.execPath, [validationContract], { timeoutMs: 30_000 });
    expectRejected(label, result, requiredText);
  });
}

function runnerAssertionControl() {
  const fixture = "000-ci-negative-assertion.test.mjs";
  const absolute = path.join(repoRoot, fixture);
  fs.writeFileSync(absolute, 'import { expect, test } from "vitest";\ntest("intentional negative control", () => expect("broken").toBe("healthy"));\n');
  try {
    const result = command(process.execPath, [isolatedRunner, "1", "1"], {
      timeoutMs: 30_000,
      env: { TEST_FILE_TIMEOUT_MS: "10000" },
    });
    expectRejected("isolated runner rejects an assertion failure", result, fixture);
  } finally {
    fs.rmSync(absolute, { force: true });
  }
}

function runnerTimeoutControl() {
  const fixture = "000-ci-negative-timeout.test.mjs";
  const absolute = path.join(repoRoot, fixture);
  fs.writeFileSync(absolute, 'import { test } from "vitest";\ntest("intentional timeout control", async () => { await new Promise(() => {}); }, 60000);\n');
  try {
    const result = command(process.execPath, [isolatedRunner, "1", "1"], {
      timeoutMs: 30_000,
      env: { TEST_FILE_TIMEOUT_MS: "4000" },
    });
    expectRejected("isolated runner rejects a hung test process", result, `${fixture} exceeded 4000ms`);
  } finally {
    fs.rmSync(absolute, { force: true });
  }
}

function skippedTestContractControl() {
  const fixture = "validation-negative-skip.test.mjs";
  const absolute = path.join(repoRoot, fixture);
  fs.writeFileSync(absolute, 'import { test } from "vitest";\ntest.skip("must be rejected", () => {});\n');
  try {
    const result = command(process.execPath, [validationContract], { timeoutMs: 30_000 });
    expectRejected("validation contract rejects skipped tests", result, "forbidden skipped/todo/only/conditional test modifier");
  } finally {
    fs.rmSync(absolute, { force: true });
  }
}

function foreignLockfileContractControl() {
  const fixture = path.join(repoRoot, "package-lock.json");
  fs.writeFileSync(fixture, '{"lockfileVersion":3}\n');
  try {
    const result = command(process.execPath, [validationContract], { timeoutMs: 30_000 });
    expectRejected("validation contract rejects foreign dependency lockfiles", result, "package-lock.json must not exist");
  } finally {
    fs.rmSync(fixture, { force: true });
  }
}

requireCleanWorkingTree("before sensitivity checks");
runnerAssertionControl();
runnerTimeoutControl();

const productionControls = [
  {
    label: "PR1 accounting tests reject profit computed by addition",
    file: "src/business/ledger.ts",
    replacements: [["realizedProfitCents: totals.revenueCents - totals.costCents,", "realizedProfitCents: totals.revenueCents + totals.costCents,"]],
    testFile: "src/__tests__/business-runtime.test.ts",
  },
  {
    label: "PR2 intelligence tests reject scoring that ignores success probability",
    file: "src/business/intelligence.ts",
    replacements: [["const expectedRevenueCents = input.successProbability * input.estimatedRevenueCents;", "const expectedRevenueCents = input.estimatedRevenueCents;"]],
    testFile: "src/__tests__/business-intelligence.test.ts",
  },
  {
    label: "PR3 production tests reject secret redaction being disabled",
    file: "src/production/backup.ts",
    replacements: [['if (SECRET_KEY_PATTERN.test(key)) return "[REDACTED]";', 'if (false && SECRET_KEY_PATTERN.test(key)) return "[REDACTED]";']],
    testFile: "src/__tests__/production-runtime.test.ts",
  },
  {
    label: "PR4 policy tests reject owner spending controls being bypassed",
    file: "src/agent/policy-rules/owner-controls.ts",
    replacements: [["if (!isOutboundSpendAction(request)) return null;", "if (isOutboundSpendAction(request)) return null;"]],
    testFile: "src/__tests__/policy-regression-audit.test.ts",
  },
  {
    label: "PR5 acquisition tests reject removal of the GitHub repository allowlist",
    file: "src/business/acquisition.ts",
    replacements: [
      ["const repositories = validateRepositories(config.repositories, !enabled);", "const repositories = validateRepositories(config.repositories, true);"],
      ["if (enabled && repositories.length === 0) {", "if (false && enabled && repositories.length === 0) {"],
    ],
    testFile: "src/__tests__/opportunity-acquisition.test.ts",
  },
  {
    label: "policy regression tests reject fail-open rule exceptions",
    file: "src/agent/policy-engine.ts",
    replacements: [['      } catch (error) {\n        overallAction = "deny";\n        reasonCode = "POLICY_RULE_ERROR";', '      } catch (error) {\n        overallAction = "allow";\n        reasonCode = "POLICY_RULE_ERROR";']],
    testFile: "src/__tests__/policy-regression-audit.test.ts",
  },
  {
    label: "token hardening tests reject unbounded exact tokenization",
    file: "src/memory/context-manager.ts",
    replacements: [["const MAX_EXACT_TOKENIZATION_CHARS = 64 * 1024;", "const MAX_EXACT_TOKENIZATION_CHARS = 1024 * 1024;"]],
    testFile: "src/__tests__/token-counter-hardening.test.ts",
    timeoutMs: 15_000,
    allowTimeout: true,
  },
];

for (const control of productionControls) sourceMutationControl(control);

const contractControls = [
  {
    label: "validation contract rejects test-discovery narrowing",
    file: "vitest.config.ts",
    replacements: [[
      'include: ["**/*.{test,spec}.{ts,tsx,js,jsx,mjs,cjs,mts,cts}"],',
      'include: ["src/__tests__/**/*.test.ts"],',
    ]],
    requiredText: "root-level test probe",
  },
  {
    label: "validation contract rejects direct Vitest blocking scripts",
    file: "package.json",
    replacements: [['"test:security": "pnpm test",', '"test:security": "vitest run",']],
    requiredText: "test:security must route through the process-isolated test runner",
  },
  {
    label: "validation contract rejects missing test typechecking",
    file: "package.json",
    replacements: [['"typecheck:tests": "tsc -p tsconfig.tests.json --noEmit",', '"typecheck:tests": "echo disabled",']],
    requiredText: "typecheck:tests must typecheck",
  },
  {
    label: "validation contract rejects missing network guard",
    file: "vitest.config.ts",
    replacements: [['setupFiles: ["./test/setup/network-guard.ts"],', 'setupFiles: [],']],
    requiredText: "external-network guard",
  },
  {
    label: "validation contract rejects weaker release validation",
    file: ".github/workflows/release.yml",
    replacements: [["run: node scripts/verify-test-sensitivity.mjs", "run: echo sensitivity-disabled"]],
    requiredText: "Release workflow is missing required validation/hardening contract: verify-test-sensitivity.mjs",
  },
  {
    label: "validation contract rejects moving GitHub Action tags",
    file: ".github/workflows/release.yml",
    replacements: [["actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1", "actions/checkout@v7"]],
    requiredText: "moving major-version action tag",
  },
  {
    label: "validation contract rejects persisted checkout credentials",
    file: ".github/workflows/release.yml",
    replacements: [["          persist-credentials: false", "          persist-credentials: true"]],
    requiredText: "Release workflow is missing required validation/hardening contract: persist-credentials: false",
  },
  {
    label: "validation contract rejects broadened workflow permissions",
    file: ".github/workflows/release.yml",
    replacements: [["permissions:\n  contents: read", "permissions:\n  contents: write"]],
    requiredText: "Release workflow is missing required validation/hardening contract: permissions:",
  },
  {
    label: "validation contract rejects globally enabled test network",
    file: ".github/workflows/release.yml",
    replacements: [["jobs:\n  release:", "env:\n  AUTOMATON_TEST_ALLOW_NETWORK: 1\n\njobs:\n  release:"]],
    requiredText: "must not globally enable external network access for tests",
  },
];

for (const control of contractControls) contractMutationControl(control);
skippedTestContractControl();
foreignLockfileContractControl();

requireCleanWorkingTree("after sensitivity checks");
const totalControls = productionControls.length + contractControls.length + 4;
console.log(`[sensitivity] PASS: ${totalControls} negative controls were all detected.`);
