#!/usr/bin/env node

import { readdir } from "node:fs/promises";
import path from "node:path";
import { createVitest } from "vitest/node";

const TEST_FILE_PATTERN = /\.(?:test|spec)\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/i;
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".pnpm-store",
  "node_modules",
  "dist",
  "coverage",
]);

export interface VitestProjectTopology {
  name: string;
  allowOnly: boolean | undefined;
  setupFiles: string[];
}

export interface VitestTopology {
  files: string[];
  projects: VitestProjectTopology[];
}

function normalizeRelative(repoRoot: string, filePath: string): string {
  const absolute = path.resolve(filePath);
  const relative = path.relative(repoRoot, absolute).replaceAll("\\", "/");
  if (!relative || relative === "." || relative.startsWith("../") || path.isAbsolute(relative)) {
    throw new Error(`Resolved a path outside the repository: ${filePath}`);
  }
  return relative;
}

/**
 * Discover repository test/spec files without consulting Vitest configuration.
 *
 * This is deliberately independent from Vitest. If a future config change
 * accidentally narrows Vitest's include/exclude patterns, validation can
 * compare the two universes and fail instead of silently accepting fewer tests.
 * Symlinks are ignored so discovery cannot escape the checked-out repository.
 */
export async function discoverRepositoryTestFiles(repoRoot: string): Promise<string[]> {
  const root = path.resolve(repoRoot);
  const discovered: string[] = [];

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue;
        await walk(absolute);
        continue;
      }

      if (!entry.isFile() || !TEST_FILE_PATTERN.test(entry.name)) continue;
      discovered.push(normalizeRelative(root, absolute));
    }
  }

  await walk(root);
  return [...new Set(discovered)].sort((a, b) => a.localeCompare(b));
}

export function selectTestShard(
  files: readonly string[],
  shardIndex: number,
  shardTotal: number,
): string[] {
  if (!Number.isInteger(shardIndex) || !Number.isInteger(shardTotal)) {
    throw new TypeError("Shard index and shard total must be integers.");
  }
  if (shardTotal < 1 || shardIndex < 1 || shardIndex > shardTotal) {
    throw new RangeError(`Invalid shard ${shardIndex}/${shardTotal}.`);
  }
  return files.filter((_, index) => index % shardTotal === shardIndex - 1);
}

/** Inspect what Vitest itself currently believes the test topology to be. */
export async function inspectVitestTopology(repoRoot: string): Promise<VitestTopology> {
  const vitest = await createVitest(
    "test",
    { watch: false, run: false },
    { root: repoRoot },
  );

  try {
    const discovered: string[] = [];
    const projects: VitestProjectTopology[] = [];

    for (const project of vitest.projects) {
      const { testFiles } = await project.globTestFiles();
      for (const testFile of testFiles) {
        discovered.push(normalizeRelative(repoRoot, testFile));
      }

      projects.push({
        name: project.name || "default",
        allowOnly: project.config.allowOnly,
        setupFiles: (project.config.setupFiles ?? []).map((setupFile) =>
          normalizeRelative(repoRoot, setupFile),
        ),
      });
    }

    return {
      files: [...new Set(discovered)].sort((a, b) => a.localeCompare(b)),
      projects,
    };
  } finally {
    await vitest.close();
  }
}

/** Canonical runner discovery is filesystem-based, not configuration-based. */
export async function discoverTestFiles(repoRoot: string): Promise<string[]> {
  return discoverRepositoryTestFiles(repoRoot);
}
