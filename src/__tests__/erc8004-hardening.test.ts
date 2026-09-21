import { describe, expect, it, vi } from "vitest";
import { ERC8004_CONTRACTS } from "../registry/erc8004-config.js";
import { scanLatestMintEvents } from "../registry/erc8004-event-scan.js";

describe("ERC-8004 deployment configuration", () => {
  it("uses canonical Base mainnet and Base Sepolia registry addresses", () => {
    expect(ERC8004_CONTRACTS.mainnet.identity).toBe("0x8004A169FB4a3325136EB29fA0ceB6D2e539a432");
    expect(ERC8004_CONTRACTS.mainnet.reputation).toBe("0x8004BAa17C55a88189AE136b182e5fdA19dE9b63");
    expect(ERC8004_CONTRACTS.mainnet.chain.id).toBe(8453);
    expect(ERC8004_CONTRACTS.mainnet.deploymentBlock).toBe(41_663_783n);

    expect(ERC8004_CONTRACTS.testnet.identity).toBe("0x8004A818BFB912233c491871b3d84c89A494BD9e");
    expect(ERC8004_CONTRACTS.testnet.reputation).toBe("0x8004B663056A597Dffe9eCcC1965A193B7388713");
    expect(ERC8004_CONTRACTS.testnet.chain.id).toBe(84532);
    expect(ERC8004_CONTRACTS.testnet.deploymentBlock).toBe(36_304_145n);
  });

  it("does not reuse mainnet registry addresses on testnet", () => {
    expect(ERC8004_CONTRACTS.testnet.identity).not.toBe(ERC8004_CONTRACTS.mainnet.identity);
    expect(ERC8004_CONTRACTS.testnet.reputation).not.toBe(ERC8004_CONTRACTS.mainnet.reputation);
  });
});

describe("scanLatestMintEvents", () => {
  it("scans backwards in non-overlapping RPC-safe chunks until enough newest mints exist", async () => {
    const calls: Array<[bigint, bigint]> = [];
    const result = await scanLatestMintEvents({
      currentBlock: 5_999n,
      deploymentBlock: 1_000n,
      limit: 3,
      maxBlockDifference: 1_999n,
      chunkTimeoutMs: 1_000,
      getChunk: async (from, to) => {
        calls.push([from, to]);
        if (from === 4_000n) return [{ tokenId: 9n, owner: "0x9" }];
        if (from === 2_000n) return [
          { tokenId: 8n, owner: "0x8" },
          { tokenId: 7n, owner: "0x7" },
        ];
        return [];
      },
    });

    expect(calls).toEqual([[4_000n, 5_999n], [2_000n, 3_999n]]);
    expect(result.map((event) => event.tokenId)).toEqual([9n, 8n, 7n]);
  });

  it("reaches the verified deployment block when fewer events than requested exist", async () => {
    const calls: Array<[bigint, bigint]> = [];
    const result = await scanLatestMintEvents({
      currentBlock: 3_500n,
      deploymentBlock: 1_000n,
      limit: 5,
      maxBlockDifference: 1_999n,
      getChunk: async (from, to) => {
        calls.push([from, to]);
        return from === 1_501n ? [{ tokenId: 2n, owner: "0x2" }] : [{ tokenId: 1n, owner: "0x1" }];
      },
    });

    expect(calls).toEqual([[1_501n, 3_500n], [1_000n, 1_500n]]);
    expect(result.map((event) => event.tokenId)).toEqual([2n, 1n]);
  });

  it("retries a transient chunk failure but never returns partial results after persistent failure", async () => {
    const transient = vi.fn()
      .mockRejectedValueOnce(new Error("temporary RPC failure"))
      .mockResolvedValueOnce([{ tokenId: 4n, owner: "0x4" }]);

    await expect(scanLatestMintEvents({
      currentBlock: 2_999n,
      deploymentBlock: 1_000n,
      limit: 1,
      maxAttemptsPerChunk: 3,
      sleep: async () => {},
      getChunk: transient,
    })).resolves.toEqual([{ tokenId: 4n, owner: "0x4" }]);
    expect(transient).toHaveBeenCalledTimes(2);

    const persistent = vi.fn().mockRejectedValue(new Error("RPC unavailable"));
    await expect(scanLatestMintEvents({
      currentBlock: 2_999n,
      deploymentBlock: 1_000n,
      limit: 1,
      maxAttemptsPerChunk: 3,
      sleep: async () => {},
      getChunk: persistent,
    })).rejects.toThrow("after 3 attempts");
    expect(persistent).toHaveBeenCalledTimes(3);
  });

  it("deduplicates token IDs before deciding the requested newest set is complete", async () => {
    const result = await scanLatestMintEvents({
      currentBlock: 5_999n,
      deploymentBlock: 1_000n,
      limit: 2,
      maxBlockDifference: 1_999n,
      getChunk: async (from) => from === 4_000n
        ? [
            { tokenId: 3n, owner: "0x3" },
            { tokenId: 3n, owner: "0x3" },
          ]
        : [{ tokenId: 2n, owner: "0x2" }],
    });

    expect(result.map((event) => event.tokenId)).toEqual([3n, 2n]);
  });
});
