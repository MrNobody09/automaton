import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { terminateProcessTree } from "../scripts/process-tree.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("terminateProcessTree", () => {
  it("prevents a spawned grandchild from surviving parent-tree termination", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "automaton-process-tree-"));
    const marker = path.join(tempDir, "grandchild-survived.txt");

    // The parent launches a grandchild that would create a marker after 900ms.
    // We kill the parent's complete process tree well before that deadline. If
    // cleanup only kills the immediate parent, the marker appears and the test
    // fails, reproducing the class of orphan-worker bug seen in historical CI.
    const grandchildScript = `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'survived'), 900); setTimeout(() => {}, 5000);`;
    const parentScript = `const { spawn } = require('child_process'); spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], { stdio: 'ignore' }); setTimeout(() => {}, 5000);`;

    const child = spawn(process.execPath, ["-e", parentScript], {
      stdio: "ignore",
      detached: process.platform !== "win32",
      windowsHide: true,
    });

    try {
      await sleep(150);
      terminateProcessTree(child);
      await sleep(1_100);
      expect(existsSync(marker)).toBe(false);
    } finally {
      terminateProcessTree(child);
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 5_000);
});
