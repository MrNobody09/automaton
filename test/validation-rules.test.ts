import { describe, expect, it } from "vitest";
import {
  validateCiWorkflow,
  validatePackageScripts,
  validateReleaseWorkflow,
  validateShardPartition,
} from "../scripts/validation-rules.js";

const CHECKOUT = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const SETUP_NODE = "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020";
const SETUP_PNPM = "pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86";

function step(run: string) { return { run }; }
function checkout() { return { uses: CHECKOUT, with: { "persist-credentials": false } }; }
function action(uses: string) { return { uses }; }

const REQUIRED_CI_COMMAND = `set -euo pipefail
printf 'validation-contract=%s\\nbuild-and-typecheck=%s\\nisolated-full-suite=%s\\nsecurity-audit=%s\\n' \\
  "$VALIDATION_CONTRACT_RESULT" \\
  "$BUILD_AND_TYPECHECK_RESULT" \\
  "$ISOLATED_FULL_SUITE_RESULT" \\
  "$SECURITY_AUDIT_RESULT"
test "$VALIDATION_CONTRACT_RESULT" = "success"
test "$BUILD_AND_TYPECHECK_RESULT" = "success"
test "$ISOLATED_FULL_SUITE_RESULT" = "success"
test "$SECURITY_AUDIT_RESULT" = "success"`;

function ciFixture() {
  return {
    permissions: { contents: "read" },
    jobs: {
      "validation-contract": { steps: [checkout(), action(SETUP_NODE), action(SETUP_PNPM), step("pnpm run validation:contract")] },
      "build-and-typecheck": {
        strategy: { matrix: { "node-version": [20, 22] } },
        steps: [checkout(), action(SETUP_NODE), action(SETUP_PNPM), step("pnpm run typecheck"), step("pnpm run typecheck:tests"), step("pnpm run build"), step("pnpm run validation:artifacts")],
      },
      "isolated-full-suite": {
        "timeout-minutes": 12,
        strategy: { "fail-fast": false, matrix: { "node-version": [20, 22], shard: [1, 2, 3, 4] } },
        steps: [checkout(), action(SETUP_NODE), action(SETUP_PNPM), step("pnpm exec tsx scripts/run-isolated-tests.ts ${{ matrix.shard }} 4")],
      },
      "security-audit": { steps: [checkout(), action(SETUP_NODE), action(SETUP_PNPM), step("pnpm audit --audit-level=high")] },
      "required-ci": {
        if: "always()",
        needs: ["validation-contract", "build-and-typecheck", "isolated-full-suite", "security-audit"],
        steps: [checkout(), step(REQUIRED_CI_COMMAND)],
      },
    },
  };
}

function releaseFixture() {
  return {
    permissions: { contents: "read" },
    jobs: {
      "release-validation": {
        strategy: { "fail-fast": false, matrix: { "node-version": [20, 22] } },
        steps: [checkout(), action(SETUP_NODE), action(SETUP_PNPM), step("pnpm run validation:contract"), step("pnpm run typecheck"), step("pnpm run typecheck:tests"), step("pnpm run build"), step("pnpm run validation:artifacts"), step("pnpm exec tsx scripts/run-isolated-tests.ts")],
      },
      "security-audit": { steps: [checkout(), action(SETUP_NODE), action(SETUP_PNPM), step("pnpm audit --audit-level=high")] },
    },
  };
}

describe("typed validation rules", () => {
  it("accepts the intended CI and release structures", () => {
    expect(() => validateCiWorkflow(ciFixture())).not.toThrow();
    expect(() => validateReleaseWorkflow(releaseFixture())).not.toThrow();
  });

  it("rejects fail-open required commands", () => {
    const workflow = ciFixture();
    const build = workflow.jobs["build-and-typecheck"];
    build.steps[4] = { run: "pnpm run typecheck:tests", "continue-on-error": true } as any;
    expect(() => validateCiWorkflow(workflow)).toThrow("missing blocking command: pnpm run typecheck:tests");
  });

  it("rejects moving GitHub Action tags", () => {
    const workflow = ciFixture();
    workflow.jobs["security-audit"].steps[0] = { uses: "actions/checkout@v7", with: { "persist-credentials": false } } as any;
    expect(() => validateCiWorkflow(workflow)).toThrow("pinned to an exact commit SHA");
  });

  it("rejects CI matrix shrinkage", () => {
    const workflow = ciFixture();
    workflow.jobs["build-and-typecheck"].strategy.matrix["node-version"] = [22];
    expect(() => validateCiWorkflow(workflow)).toThrow("exactly Node 20 and 22");
  });

  it("rejects shard denominator drift", () => {
    const workflow = ciFixture();
    workflow.jobs["isolated-full-suite"].steps[3] = step("pnpm exec tsx scripts/run-isolated-tests.ts ${{ matrix.shard }} 5");
    expect(() => validateCiWorkflow(workflow)).toThrow("shardTotal=4 through pnpm exec");
  });

  it("rejects artifact validation before build", () => {
    const workflow = ciFixture();
    const build = workflow.jobs["build-and-typecheck"];
    [build.steps[5], build.steps[6]] = [build.steps[6], build.steps[5]];
    expect(() => validateCiWorkflow(workflow)).toThrow("validation:artifacts must run after build");
  });

  it("rejects a missing required-ci aggregator", () => {
    const workflow = ciFixture() as any;
    delete workflow.jobs["required-ci"];
    expect(() => validateCiWorkflow(workflow)).toThrow("stable required-ci aggregation job");
  });

  it("rejects incomplete required-ci dependencies", () => {
    const workflow = ciFixture();
    workflow.jobs["required-ci"].needs = ["validation-contract", "build-and-typecheck", "isolated-full-suite"];
    expect(() => validateCiWorkflow(workflow)).toThrow("depend on every authoritative CI job exactly once");
  });

  it("rejects a fail-open required-ci result check", () => {
    const workflow = ciFixture();
    workflow.jobs["required-ci"].steps[1] = step(REQUIRED_CI_COMMAND.replace('test "$SECURITY_AUDIT_RESULT" = "success"', 'echo "$SECURITY_AUDIT_RESULT"'));
    expect(() => validateCiWorkflow(workflow)).toThrow("block unless every authoritative CI dependency succeeds");
  });

  it("rejects repository-mutating sensitivity jobs", () => {
    const workflow = ciFixture() as any;
    workflow.jobs["test-sensitivity"] = { steps: [checkout()] };
    expect(() => validateCiWorkflow(workflow)).toThrow("must not use repository-mutating sensitivity tests");
  });

  it("rejects misleading test aliases and direct Vitest scripts", () => {
    const scripts: Record<string, string> = {
      test: "tsx scripts/run-isolated-tests.ts",
      "test:ci": "tsx scripts/run-isolated-tests.ts",
      "test:isolated": "tsx scripts/run-isolated-tests.ts",
      "test:security": "tsx scripts/run-isolated-tests.ts",
      "typecheck:tests": "tsc -p tsconfig.tests.json --noEmit",
      "validation:contract": "tsx scripts/verify-validation-contract.ts",
      "validation:artifacts": "tsx scripts/verify-package-artifacts.ts",
    };
    const manifest = { packageManager: "pnpm@10.28.1", scripts };
    expect(() => validatePackageScripts(manifest)).toThrow("test:security must not exist");

    delete scripts["test:security"];
    scripts.test = "vitest run";
    expect(() => validatePackageScripts(manifest)).toThrow("typed process-isolated test runner");
  });

  it("proves the sharding algorithm is an exact partition", () => {
    const files = Array.from({ length: 17 }, (_, index) => `test-${index}.test.ts`);
    expect(() => validateShardPartition(files, 4)).not.toThrow();
    expect(() => validateShardPartition(["a", "b"], 4)).toThrow("must not contain an empty shard");
  });
});
