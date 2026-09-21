#!/usr/bin/env node

import path from "node:path";
import { createVitest } from "vitest/node";

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
    throw new Error(`Vitest resolved a path outside the repository: ${filePath}`);
  }
  return relative;
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

export async function discoverTestFiles(repoRoot: string): Promise<string[]> {
  return (await inspectVitestTopology(repoRoot)).files;
}
