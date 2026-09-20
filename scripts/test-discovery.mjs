#!/usr/bin/env node

import path from "node:path";
import { createVitest } from "vitest/node";

function normalizeRelative(repoRoot, filePath) {
  const absolute = path.resolve(filePath);
  const relative = path.relative(repoRoot, absolute).replaceAll("\\", "/");
  if (!relative || relative === "." || relative.startsWith("../") || path.isAbsolute(relative)) {
    throw new Error(`Vitest discovered a test outside the repository: ${filePath}`);
  }
  return relative;
}

export async function discoverTestFiles(repoRoot) {
  const vitest = await createVitest(
    "test",
    { watch: false, run: false },
    { root: repoRoot },
  );

  try {
    const discovered = [];
    for (const project of vitest.projects) {
      const { testFiles } = await project.globTestFiles();
      for (const testFile of testFiles) {
        discovered.push(normalizeRelative(repoRoot, testFile));
      }
    }

    return [...new Set(discovered)].sort((a, b) => a.localeCompare(b));
  } finally {
    await vitest.close();
  }
}
