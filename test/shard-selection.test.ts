import { describe, expect, it } from "vitest";
import { selectTestShard } from "../scripts/test-discovery.mjs";

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
