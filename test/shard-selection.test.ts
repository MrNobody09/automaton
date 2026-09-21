import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  discoverRepositoryTestFiles,
  selectTestShard,
} from "../scripts/test-discovery.js";

describe("selectTestShard", () => {
  it("partitions a file list exactly once across four shards", () => {
    const files = Array.from({ length: 17 }, (_, index) => `test-${index}.test.ts`);
    const shards = [1, 2, 3, 4].map((index) => selectTestShard(files, index, 4));
    const flattened = shards.flat();

    expect(shards.every((shard) => shard.length > 0)).toBe(true);
    expect(flattened).toHaveLength(files.length);
    expect(new Set(flattened).size).toBe(files.length);
    expect(new Set(flattened)).toEqual(new Set(files));
  });

  it("uses one-based shard indexes deterministically", () => {
    const files = ["a", "b", "c", "d", "e", "f"];
    expect(selectTestShard(files, 1, 4)).toEqual(["a", "e"]);
    expect(selectTestShard(files, 2, 4)).toEqual(["b", "f"]);
    expect(selectTestShard(files, 3, 4)).toEqual(["c"]);
    expect(selectTestShard(files, 4, 4)).toEqual(["d"]);
  });

  it("rejects invalid shard coordinates", () => {
    expect(() => selectTestShard([], 0, 4)).toThrow("Invalid shard 0/4");
    expect(() => selectTestShard([], 5, 4)).toThrow("Invalid shard 5/4");
    expect(() => selectTestShard([], 1, 0)).toThrow("Invalid shard 1/0");
  });
});

describe("discoverRepositoryTestFiles", () => {
  it("finds nested test/spec files independently and ignores generated/vendor trees", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "automaton-test-discovery-"));
    try {
      await mkdir(path.join(root, "src", "nested"), { recursive: true });
      await mkdir(path.join(root, "node_modules", "vendor"), { recursive: true });
      await mkdir(path.join(root, "dist"), { recursive: true });
      await mkdir(path.join(root, "coverage"), { recursive: true });

      await writeFile(path.join(root, "root.test.ts"), "export {};\n");
      await writeFile(path.join(root, "src", "nested", "feature.spec.mjs"), "export {};\n");
      await writeFile(path.join(root, "src", "nested", "not-a-test.ts"), "export {};\n");
      await writeFile(path.join(root, "node_modules", "vendor", "hidden.test.ts"), "export {};\n");
      await writeFile(path.join(root, "dist", "generated.test.js"), "export {};\n");
      await writeFile(path.join(root, "coverage", "report.spec.js"), "export {};\n");

      expect(await discoverRepositoryTestFiles(root)).toEqual([
        "root.test.ts",
        "src/nested/feature.spec.mjs",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not follow directory symlinks outside the repository", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "automaton-test-discovery-root-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "automaton-test-discovery-outside-"));
    try {
      await writeFile(path.join(outside, "external.test.ts"), "export {};\n");
      try {
        await symlink(outside, path.join(root, "external-link"), "dir");
      } catch (error: any) {
        // Some Windows environments restrict symlink creation for unprivileged
        // users. The production implementation still ignores symlink entries;
        // skip only this environment-dependent assertion when creation fails.
        if (process.platform === "win32" && (error?.code === "EPERM" || error?.code === "EACCES")) return;
        throw error;
      }
      expect(await discoverRepositoryTestFiles(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
