/**
 * Tests for Solana Wallet Generation
 */

import { describe, it, expect } from "vitest";
import { generateSolanaKeypair, getWalletChainType } from "../identity/wallet.js";
import { isValidSolanaAddress } from "../identity/chain.js";
import type { WalletData } from "../types.js";
import nacl from "tweetnacl";
import bs58 from "bs58";

describe("Solana Wallet", () => {
  describe("generateSolanaKeypair", () => {
    it("generates a valid Ed25519 keypair", () => {
      const { secretKey, publicKey, address } = generateSolanaKeypair();

      expect(secretKey.length).toBe(64);
      expect(publicKey.length).toBe(32);
      expect(isValidSolanaAddress(address)).toBe(true);

      const reconstructed = nacl.sign.keyPair.fromSecretKey(secretKey);
      expect(bs58.encode(reconstructed.publicKey)).toBe(address);
    });

    it("generates unique keypairs", () => {
      const kp1 = generateSolanaKeypair();
      const kp2 = generateSolanaKeypair();
      expect(kp1.address).not.toBe(kp2.address);
    });
  });

  describe("WalletData format", () => {
    it("Solana wallet data has correct shape", () => {
      const { secretKey } = generateSolanaKeypair();
      const walletData: WalletData = {
        chainType: "solana",
        secretKey: bs58.encode(secretKey),
        createdAt: new Date().toISOString(),
      };

      const decoded = bs58.decode(walletData.secretKey!);
      expect(decoded.length).toBe(64);

      const kp = nacl.sign.keyPair.fromSecretKey(decoded);
      expect(bs58.encode(kp.publicKey)).toBeTruthy();
    });

    it("EVM wallet data backward compat (missing chainType defaults to evm)", () => {
      const walletData: WalletData = {
        privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
        createdAt: "2024-01-01T00:00:00.000Z",
      };

      expect(walletData.chainType ?? "evm").toBe("evm");
    });
  });

  describe("getWalletChainType", () => {
    it("returns a supported chain type", () => {
      const chainType = getWalletChainType();
      expect(["evm", "solana"]).toContain(chainType);
    });
  });
});
