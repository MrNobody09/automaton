import { selectTestShard } from "./test-discovery.js";

export type WorkflowObject = Record<string, any>;

const TRUSTED_ACTIONS = new Map<string, string>([
  ["actions/checkout", "3d3c42e5aac5ba805825da76410c181273ba90b1"],
  ["actions/setup-node", "820762786026740c76f36085b0efc47a31fe5020"],
  ["pnpm/action-setup", "0977fd99725f1db4007ccb2928dbb4e90d06cc86"],
]);

function fail(message: string): never {
  throw new Error(message);
}

function isEnabled(value: unknown): boolean {
  return value === 1 || value === "1" || value === true || value === "true";
}

function sameScalarSet(actual: unknown, expected: Array<string | number>): boolean {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  const a = actual.map(String).sort();
  const e = expected.map(String).sort();
  return a.every((value, index) => value === e[index]);
}

function commandOf(step: any): string | null {
  return step && typeof step === "object" && typeof step.run === "string" ? step.run.trim() : null;
}

function isBlocking(step: any): boolean {
  return step?.["continue-on-error"] !== true && step?.continueOnError !== true;
}

function assertNoNetworkOptOut(env: any, label: string): void {
  if (env && typeof env === "object" && isEnabled(env.AUTOMATON_TEST_ALLOW_NETWORK)) {
    fail(`${label} must not enable AUTOMATON_TEST_ALLOW_NETWORK.`);
  }
}

function assertTrustedAction(step: any, label: string): void {
  if (!step || typeof step !== "object" || typeof step.uses !== "string") return;
  if (step.uses.startsWith("./")) return;

  const at = step.uses.lastIndexOf("@");
  if (at <= 0) fail(`${label} action must include an exact commit SHA: ${step.uses}`);
  const actionName = step.uses.slice(0, at);
  const revision = step.uses.slice(at + 1);
  if (!/^[0-9a-f]{40}$/i.test(revision)) {
    fail(`${label} action must be pinned to an exact commit SHA: ${step.uses}`);
  }

  const trustedRevision = TRUSTED_ACTIONS.get(actionName);
  if (!trustedRevision) {
    fail(`${label} action is not in the trusted action allowlist: ${actionName}`);
  }
  if (revision.toLowerCase() !== trustedRevision.toLowerCase()) {
    fail(`${label} action ${actionName} must use approved SHA ${trustedRevision}; found ${revision}`);
  }
}

function assertJobTimeout(job: any, label: string, maxMinutes: number): void {
  const timeout = job?.["timeout-minutes"];
  if (!Number.isFinite(timeout) || !Number.isInteger(timeout) || timeout < 1 || timeout > maxMinutes) {
    fail(`${label} must define a hard timeout between 1 and ${maxMinutes} minutes.`);
  }
}

function assertCheckoutPolicy(jobName: string, job: any, label: string): void {
  const checkoutSteps = (job.steps ?? []).filter(
    (step: any) => typeof step?.uses === "string" && step.uses.startsWith("actions/checkout@"),
  );
  const isAggregator = jobName === "required-ci" || jobName === "required-release";

  if (isAggregator) {
    if (checkoutSteps.length !== 0) {
      fail(`${label} aggregator ${jobName} must not checkout repository code.`);
    }
    if ((job.steps ?? []).some((step: any) => typeof step?.uses === "string")) {
      fail(`${label} aggregator ${jobName} must not execute third-party actions.`);
    }
    return;
  }

  if (checkoutSteps.length !== 1) {
    fail(`${label} job ${jobName} must contain exactly one checkout step.`);
  }
}

export function blockingCommandsForJob(job: any): string[] {
  return (job?.steps ?? [])
    .filter(isBlocking)
    .map(commandOf)
    .filter((value: string | null): value is string => typeof value === "string");
}

export function validateWorkflowSecurity(workflow: WorkflowObject, label: string): void {
  if (!workflow || typeof workflow !== "object") fail(`${label} workflow could not be parsed.`);
  const permissionKeys = Object.keys(workflow.permissions ?? {});
  if (permissionKeys.length !== 1 || permissionKeys[0] !== "contents" || workflow.permissions.contents !== "read") {
    fail(`${label} workflow permissions must be exactly contents: read.`);
  }
  assertNoNetworkOptOut(workflow.env, `${label} workflow-level env`);
  const jobs = workflow.jobs ?? {};
  if (Object.keys(jobs).length === 0) fail(`${label} workflow must define jobs.`);

  for (const [jobName, job] of Object.entries<any>(jobs)) {
    if (!Array.isArray(job?.steps) || job.steps.length === 0) {
      fail(`${label} job ${jobName} must define non-empty steps.`);
    }
    assertJobTimeout(job, `${label} job ${jobName}`, label === "CI" ? 15 : 35);
    assertNoNetworkOptOut(job.env, `${label} job ${jobName} env`);
    assertCheckoutPolicy(jobName, job, label);

    for (const step of job.steps) {
      assertTrustedAction(step, `${label} job ${jobName}`);
      assertNoNetworkOptOut(step?.env, `${label} job ${jobName} step env`);
      if (
        typeof step?.uses === "string" &&
        step.uses.startsWith("actions/checkout@") &&
        step.with?.["persist-credentials"] !== false
      ) {
        fail(`${label} checkout in job ${jobName} must set persist-credentials: false.`);
      }
    }
  }
}

export function validatePackageScripts(packageJson: any): void {
  if (packageJson.packageManager !== "pnpm@10.28.1") {
    fail(`packageManager must remain pinned to pnpm@10.28.1; found ${String(packageJson.packageManager)}`);
  }

  if (!sameScalarSet(packageJson.pnpm?.onlyBuiltDependencies, ["better-sqlite3", "esbuild"])) {
    fail("pnpm.onlyBuiltDependencies must remain exactly better-sqlite3 and esbuild.");
  }

  const scripts = packageJson.scripts ?? {};
  for (const [name, value] of Object.entries(scripts)) {
    if (name !== "test" && !name.startsWith("test:")) continue;
    if (typeof value !== "string") fail(`package script ${name} must be a string.`);
    if (!value.includes("run-isolated-tests.ts")) {
      fail(`${name} must route through the typed process-isolated test runner; found: ${value}`);
    }
    if (/\bvitest\b/.test(value)) fail(`${name} must not invoke Vitest directly.`);
  }
  for (const requiredName of ["test", "test:ci", "test:isolated"]) {
    if (!(requiredName in scripts)) fail(`missing package script ${requiredName}`);
  }
  for (const misleadingName of ["test:security", "test:financial", "test:regression", "test:coverage"]) {
    if (misleadingName in scripts) fail(`${misleadingName} must not exist unless it has a distinct, implemented contract.`);
  }
  if (scripts["typecheck:tests"] !== "tsc -p tsconfig.tests.json --noEmit") {
    fail("typecheck:tests must typecheck tests and validation tooling.");
  }
  if (scripts["validation:contract"] !== "tsx scripts/verify-validation-contract.ts") {
    fail("validation:contract must execute the typed validation contract.");
  }
  if (scripts["validation:artifacts"] !== "tsx scripts/verify-package-artifacts.ts") {
    fail("validation:artifacts must verify built package entrypoints.");
  }
}

function assertFrozenInstall(job: any, label: string): void {
  const commands = blockingCommandsForJob(job);
  if (!commands.includes("pnpm install --frozen-lockfile")) {
    fail(`${label} must install dependencies with pnpm install --frozen-lockfile.`);
  }
}

function assertAggregateGate(
  job: any,
  label: string,
  requiredNeeds: string[],
  requiredChecks: Array<{ env: string; needle: string }>,
): void {
  if (!job) fail(`${label} must define a stable aggregate gate.`);
  if (job.if !== "always()") fail(`${label} must use if: always() so failures reach the aggregator.`);
  if (!sameScalarSet(job.needs, requiredNeeds)) {
    fail(`${label} must depend on every authoritative job exactly once.`);
  }
  assertJobTimeout(job, label, 5);
  const commands = blockingCommandsForJob(job);
  if (commands.length !== 1) fail(`${label} must contain exactly one blocking result-check command.`);
  for (const { needle } of requiredChecks) {
    if (!commands[0].includes(needle)) {
      fail(`${label} must block unless every authoritative dependency succeeds.`);
    }
  }
}

export function validateCiWorkflow(workflow: WorkflowObject): void {
  validateWorkflowSecurity(workflow, "CI");

  const contract = workflow.jobs?.["validation-contract"];
  assertFrozenInstall(contract, "CI validation-contract");
  if (!blockingCommandsForJob(contract).includes("pnpm run validation:contract")) {
    fail("CI validation-contract job must execute pnpm run validation:contract.");
  }

  const build = workflow.jobs?.["build-and-typecheck"];
  if (!sameScalarSet(build?.strategy?.matrix?.["node-version"], [20, 22])) {
    fail("CI build-and-typecheck matrix must cover exactly Node 20 and 22.");
  }
  if (build?.strategy?.["fail-fast"] !== false) fail("CI build-and-typecheck must keep fail-fast: false.");
  assertFrozenInstall(build, "CI build-and-typecheck");
  const buildCommands = blockingCommandsForJob(build);
  for (const command of ["pnpm run typecheck", "pnpm run typecheck:tests", "pnpm run build", "pnpm run validation:artifacts"]) {
    if (!buildCommands.includes(command)) fail(`CI build-and-typecheck is missing blocking command: ${command}`);
  }
  if (buildCommands.indexOf("pnpm run validation:artifacts") < buildCommands.indexOf("pnpm run build")) {
    fail("CI validation:artifacts must run after build.");
  }

  const full = workflow.jobs?.["isolated-full-suite"];
  if (!sameScalarSet(full?.strategy?.matrix?.["node-version"], [20, 22])) {
    fail("CI isolated-full-suite matrix must cover exactly Node 20 and 22.");
  }
  if (!sameScalarSet(full?.strategy?.matrix?.shard, [1, 2, 3, 4])) {
    fail("CI isolated-full-suite matrix must retain exactly shards 1,2,3,4.");
  }
  if (full?.strategy?.["fail-fast"] !== false) fail("CI isolated-full-suite must keep fail-fast: false.");
  if (full?.["timeout-minutes"] !== 12) fail("CI isolated-full-suite must keep its 12-minute hard timeout.");
  assertFrozenInstall(full, "CI isolated-full-suite");
  const fullCommands = blockingCommandsForJob(full);
  if (fullCommands.filter((command) => command.startsWith("pnpm exec tsx scripts/run-isolated-tests.ts")).length !== 1) {
    fail("CI isolated-full-suite must contain exactly one package-manager-resolved isolated-runner command.");
  }
  if (!fullCommands.includes("pnpm exec tsx scripts/run-isolated-tests.ts ${{ matrix.shard }} 4")) {
    fail("CI isolated-full-suite must invoke matrix.shard with shardTotal=4 through pnpm exec.");
  }

  const audit = workflow.jobs?.["security-audit"];
  assertFrozenInstall(audit, "CI security-audit");
  if (!blockingCommandsForJob(audit).includes("pnpm audit --audit-level=high")) {
    fail("CI security-audit must block on pnpm audit --audit-level=high.");
  }

  assertAggregateGate(
    workflow.jobs?.["required-ci"],
    "CI required-ci",
    ["validation-contract", "build-and-typecheck", "isolated-full-suite", "security-audit"],
    [
      { env: "VALIDATION_CONTRACT_RESULT", needle: 'test "$VALIDATION_CONTRACT_RESULT" = "success"' },
      { env: "BUILD_AND_TYPECHECK_RESULT", needle: 'test "$BUILD_AND_TYPECHECK_RESULT" = "success"' },
      { env: "ISOLATED_FULL_SUITE_RESULT", needle: 'test "$ISOLATED_FULL_SUITE_RESULT" = "success"' },
      { env: "SECURITY_AUDIT_RESULT", needle: 'test "$SECURITY_AUDIT_RESULT" = "success"' },
    ],
  );

  if (workflow.jobs?.["test-sensitivity"]) {
    fail("CI must not use repository-mutating sensitivity tests as a blocking validation primitive.");
  }
}

export function validateReleaseWorkflow(workflow: WorkflowObject): void {
  validateWorkflowSecurity(workflow, "Release");

  const validation = workflow.jobs?.["release-validation"];
  if (!sameScalarSet(validation?.strategy?.matrix?.["node-version"], [20, 22])) {
    fail("Release validation matrix must cover exactly Node 20 and 22.");
  }
  if (validation?.strategy?.["fail-fast"] !== false) fail("Release validation must keep fail-fast: false.");
  if (validation?.["timeout-minutes"] !== 30) fail("Release validation must keep its 30-minute hard timeout.");
  assertFrozenInstall(validation, "Release validation");
  const commands = blockingCommandsForJob(validation);
  for (const command of [
    "pnpm run validation:contract",
    "pnpm run typecheck",
    "pnpm run typecheck:tests",
    "pnpm run build",
    "pnpm run validation:artifacts",
    "pnpm exec tsx scripts/run-isolated-tests.ts",
  ]) {
    if (!commands.includes(command)) fail(`Release validation is missing blocking command: ${command}`);
  }
  if (!commands.some((command) => command.includes('git merge-base --is-ancestor "$GITHUB_SHA"'))) {
    fail("Release validation must prove the tagged commit is contained in main.");
  }
  if (commands.indexOf("pnpm run validation:artifacts") < commands.indexOf("pnpm run build")) {
    fail("Release validation:artifacts must run after build.");
  }

  const audit = workflow.jobs?.["security-audit"];
  assertFrozenInstall(audit, "Release security-audit");
  if (!blockingCommandsForJob(audit).includes("pnpm audit --audit-level=high")) {
    fail("Release security-audit must block on pnpm audit --audit-level=high.");
  }

  assertAggregateGate(
    workflow.jobs?.["required-release"],
    "Release required-release",
    ["release-validation", "security-audit"],
    [
      { env: "RELEASE_VALIDATION_RESULT", needle: 'test "$RELEASE_VALIDATION_RESULT" = "success"' },
      { env: "SECURITY_AUDIT_RESULT", needle: 'test "$SECURITY_AUDIT_RESULT" = "success"' },
    ],
  );

  if (workflow.jobs?.["test-sensitivity"]) {
    fail("Release must not use repository-mutating sensitivity tests as a blocking validation primitive.");
  }
}

export function validateShardPartition(files: readonly string[], shardTotal = 4): void {
  const shards = Array.from({ length: shardTotal }, (_, index) => selectTestShard(files, index + 1, shardTotal));
  if (shards.some((shard) => shard.length === 0)) fail(`${shardTotal}-shard partition must not contain an empty shard.`);
  const flattened = shards.flat();
  if (flattened.length !== files.length || new Set(flattened).size !== files.length) {
    fail(`${shardTotal}-shard partition must cover every discovered test exactly once.`);
  }
  const source = new Set(files);
  if (flattened.some((file) => !source.has(file))) fail("Shard partition contains a file outside canonical discovery.");
}
