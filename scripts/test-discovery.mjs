#!/usr/bin/env node

import path from "node:path";
import { createVitest } from "vitest/node";

function normalizeRelative(repoRoot, filePath) {
  const absolute = path.resolve(filePath);
  const relative = path.relative(repoRoot, absolute).replaceAll("\\", "/");
  if (!relative || relative === "." || relative.startsWith("../") || path.isAbsolute(relative)) {
    throw new Error(`Vitest resolved a path outside the repository: ${filePath}`);
  }
  return relative;
}

export async function inspectVitestTopology(repoRoot) {
  const vitest = await createVitest(
    "test",
    { watch: false, run: false },
    { root: repoRoot },
  );

  try {
    const discovered = [];
    const projects = [];

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

export async function discoverTestFiles(repoRoot) {
  return (await inspectVitestTopology(repoRoot)).files;
}
