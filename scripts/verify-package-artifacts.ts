#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

function fail(message: string): never {
  console.error(`[artifact-contract] FAIL: ${message}`);
  process.exit(1);
}

function collectExportTargets(value: unknown, targets = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    targets.add(value);
    return targets;
  }
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) {
      collectExportTargets(child, targets);
    }
  }
  return targets;
}

function verifyPackage(packageDir: string): void {
  const manifestPath = path.join(repoRoot, packageDir, "package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const targets = new Set<string>();

  for (const field of ["main", "types"] as const) {
    if (typeof manifest[field] === "string") targets.add(manifest[field]);
  }
  if (manifest.exports) collectExportTargets(manifest.exports, targets);
  for (const target of Object.values(manifest.bin ?? {})) {
    if (typeof target === "string") targets.add(target);
  }

  for (const target of targets) {
    const normalized = target.replace(/^\.\//, "");
    const absolute = path.join(repoRoot, packageDir, normalized);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      throw new Error(`${path.join(packageDir, "package.json")} declares missing artifact: ${target}`);
    }
  }

  for (const [name, target] of Object.entries<string>(manifest.bin ?? {})) {
    const absolute = path.join(repoRoot, packageDir, target.replace(/^\.\//, ""));
    const firstLine = fs.readFileSync(absolute, "utf8").split(/\r?\n/, 1)[0];
    if (firstLine !== "#!/usr/bin/env node") {
      throw new Error(`${packageDir || "."} bin ${name} is missing the Node shebang: ${target}`);
    }
  }
}

try {
  verifyPackage("");
  verifyPackage("packages/cli");
  console.log("[artifact-contract] PASS: package entrypoints, exports, types, and bins exist after build.");
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
