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
function install() { return step("pnpm install --frozen-lockfile"); }

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

const REQUIRED_RELEASE_COMMAND = `set -euo pipefail
printf 'release-validation=%s\\nsecurity-audit=%s\\n' \\
  "$RELEASE_VALIDATION_RESULT" \\
  "$SECURITY_AUDIT_RESULT"
test "$RELEASE_VALIDATION_RESULT" = "success"
test "$SECURITY_AUDIT_RESULT" = "success"`;

function ciFixture() {
  return {
    permissions: { contents: "read" },
    jobs: {
      "validation-contract": {
        "timeout-minutes": 10,
        steps: [checkout(), action(SETUP_NODE), action(SETUP_PNPM), install(), step("pnpm run validation:contract")],
      },
      "build-and-typecheck": {
        "timeout-minutes": 15,
        strategy: { "fail-fast": false, matrix: { "node-version": [20, 22] } },
        steps: [checkout(), action(SETUP_NODE), action(SETUP_PNPM), install(), step("pnpm run typecheck"), step("pnpm run typecheck:tests"), step("pnpm run build"), step("pnpm run validation:artifacts")],
      },
      "isolated-full-suite": {
        "timeout-minutes": 12,
        strategy: { "fail-fast": false, matrix: { "node-version": [20, 22], shard: [1, 2, 3, 4] } },
        steps: [checkout(), action(SETUP_NODE), action(SETUP_PNPM), install(), step("pnpm exec tsx scripts/run-isolated-tests.ts ${{ matrix.shard }} 4")],
      },
      "security-audit": {
        "timeout-minutes": 10,
        steps: [checkout(), action(SETUP_NODE), action(SETUP_PNPM), install(), step("pnpm audit --audit-level=high")],
      },
      "required-ci": {
        "timeout-minutes": 5,
        if: "always()",
        needs: ["validation-contract", "build-and-typecheck", "isolated-full-suite", "security-audit"],
        steps: [step(REQUIRED_CI_COMMAND)],
      },
    },
  };
}

function releaseFixture() {
  return {
    permissions: { contents: "read" },
    jobs: {
      "release-validation": {
        "timeout-minutes": 30,
        strategy: { "fail-fast": false, matrix: { "node-version": [20, 22] } },
        steps: [
          checkout(),
          step('git fetch origin main && git merge-base --is-ancestor "$GITHUB_SHA" origin/main'),
          action(SETUP_NODE),
          action(SETUP_PNPM),
          install(),
          step("pnpm run validation:contract"),
          step("pnpm run typecheck"),
          step("pnpm run typecheck:tests"),
          step("pnpm run build"),
          step("pnpm run validation:artifacts"),
          step("pnpm exec tsx scripts/run-isolated-tests.ts"),
        ],
      },
      "security-audit": {
        "timeout-minutes": 10,
        steps: [checkout(), action(SETUP_NODE), action(SETUP_PNPM), install(), step("pnpm audit --audit-level=high")],
      },
      "required-release": {
        "timeout-minutes": 5,
        if: "always()",
        needs: ["release-validation", "security-audit"],
        steps: [step(REQUIRED_RELEASE_COMMAND)],
      },
    },
  };
}

function packageFixture() {
  return {
    packageManager: "pnpm@10.28.1",
    pnpm: { onlyBuiltDependencies: ["better-sqlite3", "esbuild"] },
    scripts: {
      test: "tsx scripts/run-isolated-tests.ts",
      "test:ci": "tsx scripts/run-isolated-tests.ts",
      "test:isolated": "tsx scripts/run-isolated-tests.ts",
      "typecheck:tests": "tsc -p tsconfig.tests.json --noEmit",
      "validation:contract": "tsx scripts/verify-validation-contract.ts",
      "validation:artifacts": "tsx scripts/verify-package-artifacts.ts",
    },
  };
}

describe("typed validation rules", () => {
  it("accepts the intended CI and release structures", () => {
    expect(() => validateCiWorkflow(ciFixture())).not.toThrow();
    expect(() => validateReleaseWorkflow(releaseFixture())).not.toThrow();
    expect(() => validatePackageScripts(packageFixture())).not.toThrow();
  });

  it("rejects fail-open required commands", () => {
    const workflow = ciFixture();
    const build = workflow.jobs["build-and-typecheck"];
    build.steps[5] = { run: "pnpm run typecheck:tests", "continue-on-error": true } as any;
    expect(() => validateCiWorkflow(workflow)).toThrow("missing blocking command: pnpm run typecheck:tests");
  });

  it("rejects moving GitHub Action tags", () => {
    const workflow = ciFixture();
    workflow.jobs["security-audit"].steps[0] = { uses: "actions/checkout@v7", with: { "persist-credentials": false } } as any;
    expect(() => validateCiWorkflow(workflow)).toThrow("pinned to an exact commit SHA");
  });

  it("rejects an unapproved action even when SHA-pinned", () => {
    const workflow = ciFixture();
    workflow.jobs["security-audit"].steps.splice(1, 0, action(`attacker/untrusted-action@${"a".repeat(40)}`));
    expect(() => validateCiWorkflow(workflow)).toThrow("not in the trusted action allowlist");
  });

  it("rejects a changed SHA for an approved action", () => {
    const workflow = ciFixture();
    workflow.jobs["security-audit"].steps[1] = action(`actions/setup-node@${"a".repeat(40)}`);
    expect(() => validateCiWorkflow(workflow)).toThrow("must use approved SHA");
  });

  it("rejects jobs without bounded timeouts", () => {
    const workflow = ciFixture() as any;
    delete workflow.jobs["security-audit"]["timeout-minutes"];
    expect(() => validateCiWorkflow(workflow)).toThrow("must define a hard timeout");
  });

  it("rejects CI matrix shrinkage", () => {
    const workflow = ciFixture();
    workflow.jobs["build-and-typecheck"].strategy.matrix["node-version"] = [22];
    expect(() => validateCiWorkflow(workflow)).toThrow("exactly Node 20 and 22");
  });

  it("rejects build matrix fail-fast regression", () => {
    const workflow = ciFixture();
    workflow.jobs["build-and-typecheck"].strategy["fail-fast"] = true;
    expect(() => validateCiWorkflow(workflow)).toThrow("build-and-typecheck must keep fail-fast: false");
  });

  it("rejects shard denominator drift", () => {
    const workflow = ciFixture();
    workflow.jobs["isolated-full-suite"].steps[4] = step("pnpm exec tsx scripts/run-isolated-tests.ts ${{ matrix.shard }} 5");
    expect(() => validateCiWorkflow(workflow)).toThrow("shardTotal=4 through pnpm exec");
  });

  it("rejects artifact validation before build", () => {
    const workflow = ciFixture();
    const build = workflow.jobs["build-and-typecheck"];
    [build.steps[6], build.steps[7]] = [build.steps[7], build.steps[6]];
    expect(() => validateCiWorkflow(workflow)).toThrow("validation:artifacts must run after build");
  });

  it("rejects non-frozen dependency installation", () => {
    const workflow = ciFixture();
    workflow.jobs["build-and-typecheck"].steps[3] = step("pnpm install");
    expect(() => validateCiWorkflow(workflow)).toThrow("pnpm install --frozen-lockfile");
  });

  it("rejects a missing required-ci aggregator", () => {
    const workflow = ciFixture() as any;
    delete workflow.jobs["required-ci"];
    expect(() => validateCiWorkflow(workflow)).toThrow("stable aggregate gate");
  });

  it("rejects incomplete required-ci dependencies", () => {
    const workflow = ciFixture();
    workflow.jobs["required-ci"].needs = ["validation-contract", "build-and-typecheck", "isolated-full-suite"];
    expect(() => validateCiWorkflow(workflow)).toThrow("depend on every authoritative job exactly once");
  });

  it("rejects a fail-open required-ci result check", () => {
    const workflow = ciFixture();
    workflow.jobs["required-ci"].steps[0] = step(REQUIRED_CI_COMMAND.replace('test "$SECURITY_AUDIT_RESULT" = "success"', 'echo "$SECURITY_AUDIT_RESULT"'));
    expect(() => validateCiWorkflow(workflow)).toThrow("block unless every authoritative dependency succeeds");
  });

  it("rejects code checkout or third-party actions in aggregate gates", () => {
    const workflow = ciFixture() as any;
    workflow.jobs["required-ci"].steps.unshift(checkout());
    expect(() => validateCiWorkflow(workflow)).toThrow("must not checkout repository code");
  });

  it("rejects missing or weakened required-release", () => {
    const missing = releaseFixture() as any;
    delete missing.jobs["required-release"];
    expect(() => validateReleaseWorkflow(missing)).toThrow("stable aggregate gate");

    const weakened = releaseFixture();
    weakened.jobs["required-release"].steps[0] = step(REQUIRED_RELEASE_COMMAND.replace('test "$SECURITY_AUDIT_RESULT" = "success"', 'echo "$SECURITY_AUDIT_RESULT"'));
    expect(() => validateReleaseWorkflow(weakened)).toThrow("block unless every authoritative dependency succeeds");
  });

  it("rejects release validation that no longer proves tag ancestry", () => {
    const workflow = releaseFixture();
    workflow.jobs["release-validation"].steps[1] = step("echo skip ancestry check");
    expect(() => validateReleaseWorkflow(workflow)).toThrow("tagged commit is contained in main");
  });

  it("rejects repository-mutating sensitivity jobs", () => {
    const workflow = ciFixture() as any;
    workflow.jobs["test-sensitivity"] = { "timeout-minutes": 5, steps: [checkout()] };
    expect(() => validateCiWorkflow(workflow)).toThrow("must not use repository-mutating sensitivity tests");
  });

  it("rejects misleading test aliases and direct Vitest scripts", () => {
    const manifest = packageFixture();
    (manifest.scripts as Record<string, string>)["test:security"] = "tsx scripts/run-isolated-tests.ts";
    expect(() => validatePackageScripts(manifest)).toThrow("test:security must not exist");

    delete (manifest.scripts as Record<string, string>)["test:security"];
    manifest.scripts.test = "vitest run";
    expect(() => validatePackageScripts(manifest)).toThrow("typed process-isolated test runner");
  });

  it("rejects expansion of dependency build-script permissions", () => {
    const manifest = packageFixture();
    manifest.pnpm.onlyBuiltDependencies.push("unexpected-native-package");
    expect(() => validatePackageScripts(manifest)).toThrow("must remain exactly better-sqlite3 and esbuild");
  });

  it("proves the sharding algorithm is an exact partition", () => {
    const files = Array.from({ length: 17 }, (_, index) => `test-${index}.test.ts`);
    expect(() => validateShardPartition(files, 4)).not.toThrow();
    expect(() => validateShardPartition(["a", "b"], 4)).toThrow("must not contain an empty shard");
  });
});
