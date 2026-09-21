import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { terminateProcessTree } from "../scripts/process-tree.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForFile(filePath: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) return true;
    await sleep(25);
  }
  return existsSync(filePath);
}

describe("terminateProcessTree", () => {
  it("prevents an already-started grandchild from surviving parent-tree termination", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "automaton-process-tree-"));
    const readyMarker = path.join(tempDir, "grandchild-ready.txt");
    const survivalMarker = path.join(tempDir, "grandchild-survived.txt");

    // The grandchild first proves that it is alive, then waits before writing a
    // survival marker. We do not kill the tree until the ready marker exists;
    // this prevents a false pass where the grandchild simply never started.
    const grandchildScript = `const fs = require('fs'); fs.writeFileSync(${JSON.stringify(readyMarker)}, 'ready'); setTimeout(() => fs.writeFileSync(${JSON.stringify(survivalMarker)}, 'survived'), 900); setTimeout(() => {}, 5000);`;
    const parentScript = `const { spawn } = require('child_process'); spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], { stdio: 'ignore' }); setTimeout(() => {}, 5000);`;

    const child = spawn(process.execPath, ["-e", parentScript], {
      stdio: "ignore",
      detached: process.platform !== "win32",
      windowsHide: true,
    });

    try {
      expect(await waitForFile(readyMarker, 2_000)).toBe(true);
      terminateProcessTree(child);
      await sleep(1_100);
      expect(existsSync(survivalMarker)).toBe(false);
    } finally {
      terminateProcessTree(child);
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 6_000);
});
