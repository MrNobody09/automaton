import { selectTestShard } from "./test-discovery.js";

export type WorkflowObject = Record<string, any>;

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

function assertPinnedAction(step: any, label: string): void {
  if (!step || typeof step !== "object" || typeof step.uses !== "string") return;
  if (step.uses.startsWith("./")) return;
  if (!/^[^@]+@[0-9a-f]{40}$/i.test(step.uses)) {
    fail(`${label} action must be pinned to an exact commit SHA: ${step.uses}`);
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
    if (!Array.isArray(job?.steps) || job.steps.length === 0) fail(`${label} job ${jobName} must define non-empty steps.`);
    assertNoNetworkOptOut(job.env, `${label} job ${jobName} env`);
    const checkoutSteps = job.steps.filter((step: any) => typeof step?.uses === "string" && step.uses.startsWith("actions/checkout@"));
    if (checkoutSteps.length !== 1) fail(`${label} job ${jobName} must contain exactly one checkout step.`);
    for (const step of job.steps) {
      assertPinnedAction(step, `${label} job ${jobName}`);
      assertNoNetworkOptOut(step?.env, `${label} job ${jobName} step env`);
      if (typeof step?.uses === "string" && step.uses.startsWith("actions/checkout@") && step.with?.["persist-credentials"] !== false) {
        fail(`${label} checkout in job ${jobName} must set persist-credentials: false.`);
      }
    }
  }
}

export function validatePackageScripts(packageJson: any): void {
  if (packageJson.packageManager !== "pnpm@10.28.1") {
    fail(`packageManager must remain pinned to pnpm@10.28.1; found ${String(packageJson.packageManager)}`);
  }
  const scripts = packageJson.scripts ?? {};
  for (const [name, value] of Object.entries(scripts)) {
    if (name !== "test" && !name.startsWith("test:")) continue;
    if (typeof value !== "string") fail(`package script ${name} must be a string.`);
    if (!value.includes("run-isolated-tests.ts")) fail(`${name} must route through the typed process-isolated test runner; found: ${value}`);
    if (/\bvitest\b/.test(value)) fail(`${name} must not invoke Vitest directly.`);
  }
  for (const requiredName of ["test", "test:ci", "test:isolated"]) {
    if (!(requiredName in scripts)) fail(`missing package script ${requiredName}`);
  }
  for (const misleadingName of ["test:security", "test:financial", "test:regression", "test:coverage"]) {
    if (misleadingName in scripts) fail(`${misleadingName} must not exist unless it has a distinct, implemented contract.`);
  }
  if (scripts["typecheck:tests"] !== "tsc -p tsconfig.tests.json --noEmit") fail("typecheck:tests must typecheck tests and validation tooling.");
  if (scripts["validation:contract"] !== "tsx scripts/verify-validation-contract.ts") fail("validation:contract must execute the typed validation contract.");
  if (scripts["validation:artifacts"] !== "tsx scripts/verify-package-artifacts.ts") fail("validation:artifacts must verify built package entrypoints.");
}

export function validateCiWorkflow(workflow: WorkflowObject): void {
  validateWorkflowSecurity(workflow, "CI");
  const build = workflow.jobs?.["build-and-typecheck"];
  if (!sameScalarSet(build?.strategy?.matrix?.["node-version"], [20, 22])) fail("CI build-and-typecheck matrix must cover exactly Node 20 and 22.");
  const buildCommands = blockingCommandsForJob(build);
  for (const command of ["pnpm run typecheck", "pnpm run typecheck:tests", "pnpm run build", "pnpm run validation:artifacts"]) {
    if (!buildCommands.includes(command)) fail(`CI build-and-typecheck is missing blocking command: ${command}`);
  }
  if (buildCommands.indexOf("pnpm run validation:artifacts") < buildCommands.indexOf("pnpm run build")) fail("CI validation:artifacts must run after build.");

  const full = workflow.jobs?.["isolated-full-suite"];
  if (!sameScalarSet(full?.strategy?.matrix?.["node-version"], [20, 22])) fail("CI isolated-full-suite matrix must cover exactly Node 20 and 22.");
  if (!sameScalarSet(full?.strategy?.matrix?.shard, [1, 2, 3, 4])) fail("CI isolated-full-suite matrix must retain exactly shards 1,2,3,4.");
  if (full?.strategy?.["fail-fast"] !== false) fail("CI isolated-full-suite must keep fail-fast: false.");
  if (!Number.isFinite(full?.["timeout-minutes"]) || full["timeout-minutes"] > 15) fail("CI isolated-full-suite must keep a hard timeout of 15 minutes or less.");
  const fullCommands = blockingCommandsForJob(full);
  if (fullCommands.filter((command) => command.startsWith("pnpm exec tsx scripts/run-isolated-tests.ts")).length !== 1) {
    fail("CI isolated-full-suite must contain exactly one package-manager-resolved isolated-runner command.");
  }
  if (!fullCommands.includes("pnpm exec tsx scripts/run-isolated-tests.ts ${{ matrix.shard }} 4")) {
    fail("CI isolated-full-suite must invoke matrix.shard with shardTotal=4 through pnpm exec.");
  }

  const contract = workflow.jobs?.["validation-contract"];
  if (!blockingCommandsForJob(contract).includes("pnpm run validation:contract")) fail("CI validation-contract job must execute pnpm run validation:contract.");
  const audit = workflow.jobs?.["security-audit"];
  if (!blockingCommandsForJob(audit).includes("pnpm audit --audit-level=high")) fail("CI security-audit must block on pnpm audit --audit-level=high.");
  if (workflow.jobs?.["test-sensitivity"]) fail("CI must not use repository-mutating sensitivity tests as a blocking validation primitive.");
}

export function validateReleaseWorkflow(workflow: WorkflowObject): void {
  validateWorkflowSecurity(workflow, "Release");
  const validation = workflow.jobs?.["release-validation"];
  if (!sameScalarSet(validation?.strategy?.matrix?.["node-version"], [20, 22])) fail("Release validation matrix must cover exactly Node 20 and 22.");
  if (validation?.strategy?.["fail-fast"] !== false) fail("Release validation must keep fail-fast: false.");
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
  if (commands.indexOf("pnpm run validation:artifacts") < commands.indexOf("pnpm run build")) fail("Release validation:artifacts must run after build.");
  const audit = workflow.jobs?.["security-audit"];
  if (!blockingCommandsForJob(audit).includes("pnpm audit --audit-level=high")) fail("Release security-audit must block on pnpm audit --audit-level=high.");
  if (workflow.jobs?.["test-sensitivity"]) fail("Release must not use repository-mutating sensitivity tests as a blocking validation primitive.");
}

export function validateShardPartition(files: readonly string[], shardTotal = 4): void {
  const shards = Array.from({ length: shardTotal }, (_, index) => selectTestShard(files, index + 1, shardTotal));
  if (shards.some((shard) => shard.length === 0)) fail(`${shardTotal}-shard partition must not contain an empty shard.`);
  const flattened = shards.flat();
  if (flattened.length !== files.length || new Set(flattened).size !== files.length) fail(`${shardTotal}-shard partition must cover every discovered test exactly once.`);
  const source = new Set(files);
  if (flattened.some((file) => !source.has(file))) fail("Shard partition contains a file outside canonical discovery.");
}
