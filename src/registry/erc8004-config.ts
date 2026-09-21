import type { Address } from "viem";
import { base, baseSepolia } from "viem/chains";

export type Erc8004Network = "mainnet" | "testnet";

/**
 * Canonical ERC-8004 deployments used by Automaton.
 *
 * Addresses are the canonical mainnet/testnet singleton addresses published by
 * the ERC-8004 contracts project. Deployment blocks are the contract-creation
 * blocks on the corresponding Base explorers and provide an exact lower bound
 * for complete mint-event scans.
 */
export const ERC8004_CONTRACTS = {
  mainnet: {
    identity: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" as Address,
    reputation: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63" as Address,
    chain: base,
    deploymentBlock: 41_663_783n,
  },
  testnet: {
    identity: "0x8004A818BFB912233c491871b3d84c89A494BD9e" as Address,
    reputation: "0x8004B663056A597Dffe9eCcC1965A193B7388713" as Address,
    chain: baseSepolia,
    deploymentBlock: 36_304_145n,
  },
} as const;

export function getErc8004Contracts(network: Erc8004Network) {
  return ERC8004_CONTRACTS[network];
}
