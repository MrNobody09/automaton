#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const vitestBin = path.join(repoRoot, "node_modules", "vitest", "vitest.mjs");
const isolatedRunner = path.join(repoRoot, "scripts", "run-isolated-tests.mjs");

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
  if (result.error || result.status !== 0) {
    fail(`could not inspect git status ${stage}`);
  }
  if ((result.stdout ?? "").trim() !== "") {
    fail(`working tree is not clean ${stage}:\n${result.stdout}`);
  }
}

function expectRejected(label, result, requiredText) {
  if (result.error) {
    fail(`${label} did not fail cleanly: ${result.error.message}`);
  }
  if (result.signal) {
    fail(`${label} terminated by signal ${result.signal} instead of producing a controlled test failure.`);
  }
  if (result.status === 0) {
    fail(`${label} unexpectedly passed. The validation suite did not detect the injected defect.`);
  }
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

function runVitest(testFile) {
  return command(process.execPath, [vitestBin, "run", testFile], { timeoutMs: 90_000 });
}

function sourceMutationControl({ label, file, replacements, testFile }) {
  const absolute = path.join(repoRoot, file);
  const original = fs.readFileSync(absolute, "utf8");
  let mutated = original;
  try {
    for (const [search, replacement] of replacements) {
      mutated = replaceOnce(mutated, search, replacement, label);
    }
    fs.writeFileSync(absolute, mutated);
    const result = runVitest(testFile);
    expectRejected(label, result, testFile);
  } finally {
    fs.writeFileSync(absolute, original);
  }
}

function runnerAssertionControl() {
  const fixture = "000-ci-negative-assertion.test.mjs";
  const absolute = path.join(repoRoot, fixture);
  fs.writeFileSync(
    absolute,
    'import { expect, test } from "vitest";\ntest("intentional negative control", () => expect("broken").toBe("healthy"));\n',
  );
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
  fs.writeFileSync(
    absolute,
    'import { test } from "vitest";\ntest("intentional timeout control", async () => { await new Promise(() => {}); }, 60000);\n',
  );
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

requireCleanWorkingTree("before sensitivity checks");

runnerAssertionControl();
runnerTimeoutControl();

const controls = [
  {
    label: "PR1 accounting tests reject profit computed by addition",
    file: "src/business/ledger.ts",
    replacements: [[
      "realizedProfitCents: totals.revenueCents - totals.costCents,",
      "realizedProfitCents: totals.revenueCents + totals.costCents,",
    ]],
    testFile: "src/__tests__/business-runtime.test.ts",
  },
  {
    label: "PR2 intelligence tests reject scoring that ignores success probability",
    file: "src/business/intelligence.ts",
    replacements: [[
      "const expectedRevenueCents = input.successProbability * input.estimatedRevenueCents;",
      "const expectedRevenueCents = input.estimatedRevenueCents;",
    ]],
    testFile: "src/__tests__/business-intelligence.test.ts",
  },
  {
    label: "PR3 production tests reject secret redaction being disabled",
    file: "src/production/backup.ts",
    replacements: [[
      'if (SECRET_KEY_PATTERN.test(key)) return "[REDACTED]";',
      'if (false && SECRET_KEY_PATTERN.test(key)) return "[REDACTED]";',
    ]],
    testFile: "src/__tests__/production-runtime.test.ts",
  },
  {
    label: "PR4 policy tests reject owner spending controls being bypassed",
    file: "src/agent/policy-rules/owner-controls.ts",
    replacements: [[
      "if (!isOutboundSpendAction(request)) return null;",
      "if (isOutboundSpendAction(request)) return null;",
    ]],
    testFile: "src/__tests__/policy-regression-audit.test.ts",
  },
  {
    label: "PR5 acquisition tests reject removal of the GitHub repository allowlist",
    file: "src/business/acquisition.ts",
    replacements: [
      [
        "const repositories = validateRepositories(config.repositories, !enabled);",
        "const repositories = validateRepositories(config.repositories, true);",
      ],
      [
        "if (enabled && repositories.length === 0) {",
        "if (false && enabled && repositories.length === 0) {",
      ],
    ],
    testFile: "src/__tests__/opportunity-acquisition.test.ts",
  },
  {
    label: "policy regression tests reject fail-open rule exceptions",
    file: "src/agent/policy-engine.ts",
    replacements: [[
      '      } catch (error) {\n        overallAction = "deny";\n        reasonCode = "POLICY_RULE_ERROR";',
      '      } catch (error) {\n        overallAction = "allow";\n        reasonCode = "POLICY_RULE_ERROR";',
    ]],
    testFile: "src/__tests__/policy-regression-audit.test.ts",
  },
  {
    label: "token hardening tests reject unbounded exact tokenization",
    file: "src/memory/context-manager.ts",
    replacements: [[
      "const MAX_EXACT_TOKENIZATION_CHARS = 64 * 1024;",
      "const MAX_EXACT_TOKENIZATION_CHARS = 1024 * 1024;",
    ]],
    testFile: "src/__tests__/token-counter-hardening.test.ts",
  },
];

for (const control of controls) {
  sourceMutationControl(control);
}

requireCleanWorkingTree("after sensitivity checks");
console.log(`[sensitivity] PASS: ${controls.length + 2} negative controls were all detected.`);
