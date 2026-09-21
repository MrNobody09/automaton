import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  parseAbiItem,
  type Address,
  type PrivateKeyAccount,
  type PublicClient,
  type WalletClient,
} from "viem";
import type { AutomatonDatabase, OnchainTransactionRow } from "../types.js";
import {
  getOnchainTransactionByRequestId,
  insertOnchainTransaction,
  updateOnchainTransactionStatus,
} from "../state/database.js";
import { createLogger } from "../observability/logger.js";
import { getErc8004Contracts, type Erc8004Network } from "./erc8004-config.js";
import { scanLatestMintEvents } from "./erc8004-event-scan.js";

const logger = createLogger("erc8004");

const IDENTITY_ABI = parseAbi([
  "function register(string agentURI) external returns (uint256)",
  "function register(string agentURI, tuple(string key, bytes value)[] metadata) external returns (uint256)",
  "function tokenURI(uint256 tokenId) external view returns (string)",
  "function ownerOf(uint256 tokenId) external view returns (address)",
  "function getAgentWallet(uint256 tokenId) external view returns (address)",
  "function setAgentWallet(uint256 tokenId, address newWallet, uint256 deadline, bytes signature) external",
  "function setAgentURI(uint256 tokenId, string newURI) external",
  "function totalSupply() external view returns (uint256)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
]);

const REPUTATION_ABI = parseAbi([
  "function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash) external",
  "function getSummary(uint256 agentId, address[] clientAddresses, string tag1, string tag2) external view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)",
]);

const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
);

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

type Network = Erc8004Network;

function buildPublicClient(network: Network, rpcUrl?: string): PublicClient {
  const contracts = getErc8004Contracts(network);
  return createPublicClient({
    chain: contracts.chain,
    transport: http(rpcUrl),
  });
}

function buildWalletClient(
  account: PrivateKeyAccount,
  network: Network,
  rpcUrl?: string,
): WalletClient {
  const contracts = getErc8004Contracts(network);
  return createWalletClient({
    account,
    chain: contracts.chain,
    transport: http(rpcUrl),
  });
}

function normalizeHash(hash: unknown): string {
  return typeof hash === "string" ? hash : String(hash);
}

function extractTokenIdFromReceipt(receipt: any): string | null {
  for (const log of receipt?.logs ?? []) {
    if (!Array.isArray(log?.topics) || log.topics.length < 4) continue;
    const [topic0, fromTopic, , tokenTopic] = log.topics;
    if (typeof topic0 !== "string" || typeof fromTopic !== "string" || typeof tokenTopic !== "string") continue;
    const transferSelector = "0xddf252ad";
    if (!topic0.toLowerCase().startsWith(transferSelector)) continue;
    if (!fromTopic.toLowerCase().endsWith("0000000000000000000000000000000000000000")) continue;
    try {
      return BigInt(tokenTopic).toString();
    } catch {
      continue;
    }
  }
  return null;
}

async function recordOnchainRequest(
  db: AutomatonDatabase | undefined,
  row: OnchainTransactionRow,
): Promise<void> {
  if (!db) return;
  insertOnchainTransaction(db.raw, row);
}

function markOnchainRequest(
  db: AutomatonDatabase | undefined,
  requestId: string,
  status: "submitted" | "confirmed" | "failed",
  txHash?: string | null,
  error?: string | null,
): void {
  if (!db) return;
  updateOnchainTransactionStatus(db.raw, requestId, status, txHash, error);
}

function existingConfirmedHash(db: AutomatonDatabase | undefined, requestId: string): string | null {
  if (!db) return null;
  const existing = getOnchainTransactionByRequestId(db.raw, requestId);
  if (!existing) return null;
  if (existing.status === "confirmed" && existing.txHash) return existing.txHash;
  if (existing.status === "submitted") {
    throw new Error(`On-chain request ${requestId} is already submitted and awaiting confirmation.`);
  }
  if (existing.status === "failed") {
    throw new Error(`On-chain request ${requestId} previously failed and must use a new request id.`);
  }
  return null;
}

export interface RegisteredAgent {
  tokenId: string;
  owner: string;
}

export interface AgentRegistrationResult {
  txHash: string;
  tokenId: string | null;
}

export interface ReputationSummary {
  count: number;
  summaryValue: bigint;
  decimals: number;
}

export async function registerAgent(
  account: PrivateKeyAccount,
  agentURI: string,
  options: {
    network?: Network;
    rpcUrl?: string;
    requestId?: string;
    db?: AutomatonDatabase;
  } = {},
): Promise<AgentRegistrationResult> {
  const network = options.network ?? "mainnet";
  const requestId = options.requestId ?? `register-agent:${account.address}:${agentURI}`;
  const priorHash = existingConfirmedHash(options.db, requestId);
  if (priorHash) return { txHash: priorHash, tokenId: null };

  const contracts = getErc8004Contracts(network);
  const publicClient = buildPublicClient(network, options.rpcUrl);
  const walletClient = buildWalletClient(account, network, options.rpcUrl);

  await recordOnchainRequest(options.db, {
    requestId,
    operation: "erc8004.register_agent",
    network,
    status: "prepared",
    txHash: null,
    error: null,
    metadataJson: JSON.stringify({ agentURI }),
  });

  try {
    const hash = await walletClient.writeContract({
      account,
      chain: contracts.chain,
      address: contracts.identity,
      abi: IDENTITY_ABI,
      functionName: "register",
      args: [agentURI],
    });
    const txHash = normalizeHash(hash);
    markOnchainRequest(options.db, requestId, "submitted", txHash);

    const receipt = await publicClient.waitForTransactionReceipt({ hash: hash as `0x${string}` });
    if (receipt.status !== "success") {
      throw new Error(`Registration transaction ${txHash} reverted.`);
    }

    const tokenId = extractTokenIdFromReceipt(receipt);
    markOnchainRequest(options.db, requestId, "confirmed", txHash);
    return { txHash, tokenId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    markOnchainRequest(options.db, requestId, "failed", null, message);
    throw error;
  }
}

export async function setAgentURI(
  account: PrivateKeyAccount,
  tokenId: string,
  agentURI: string,
  options: {
    network?: Network;
    rpcUrl?: string;
    requestId?: string;
    db?: AutomatonDatabase;
  } = {},
): Promise<string> {
  const network = options.network ?? "mainnet";
  const requestId = options.requestId ?? `set-agent-uri:${tokenId}:${agentURI}`;
  const priorHash = existingConfirmedHash(options.db, requestId);
  if (priorHash) return priorHash;

  const contracts = getErc8004Contracts(network);
  const publicClient = buildPublicClient(network, options.rpcUrl);
  const walletClient = buildWalletClient(account, network, options.rpcUrl);

  await recordOnchainRequest(options.db, {
    requestId,
    operation: "erc8004.set_agent_uri",
    network,
    status: "prepared",
    txHash: null,
    error: null,
    metadataJson: JSON.stringify({ tokenId, agentURI }),
  });

  try {
    const hash = await walletClient.writeContract({
      account,
      chain: contracts.chain,
      address: contracts.identity,
      abi: IDENTITY_ABI,
      functionName: "setAgentURI",
      args: [BigInt(tokenId), agentURI],
    });
    const txHash = normalizeHash(hash);
    markOnchainRequest(options.db, requestId, "submitted", txHash);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: hash as `0x${string}` });
    if (receipt.status !== "success") throw new Error(`setAgentURI transaction ${txHash} reverted.`);
    markOnchainRequest(options.db, requestId, "confirmed", txHash);
    return txHash;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    markOnchainRequest(options.db, requestId, "failed", null, message);
    throw error;
  }
}

export async function setAgentWallet(
  account: PrivateKeyAccount,
  tokenId: string,
  newWallet: Address,
  deadline: bigint,
  signature: `0x${string}`,
  options: {
    network?: Network;
    rpcUrl?: string;
    requestId?: string;
    db?: AutomatonDatabase;
  } = {},
): Promise<string> {
  const network = options.network ?? "mainnet";
  const requestId = options.requestId ?? `set-agent-wallet:${tokenId}:${newWallet}:${deadline.toString()}`;
  const priorHash = existingConfirmedHash(options.db, requestId);
  if (priorHash) return priorHash;

  const contracts = getErc8004Contracts(network);
  const publicClient = buildPublicClient(network, options.rpcUrl);
  const walletClient = buildWalletClient(account, network, options.rpcUrl);

  await recordOnchainRequest(options.db, {
    requestId,
    operation: "erc8004.set_agent_wallet",
    network,
    status: "prepared",
    txHash: null,
    error: null,
    metadataJson: JSON.stringify({ tokenId, newWallet, deadline: deadline.toString() }),
  });

  try {
    const hash = await walletClient.writeContract({
      account,
      chain: contracts.chain,
      address: contracts.identity,
      abi: IDENTITY_ABI,
      functionName: "setAgentWallet",
      args: [BigInt(tokenId), newWallet, deadline, signature],
    });
    const txHash = normalizeHash(hash);
    markOnchainRequest(options.db, requestId, "submitted", txHash);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: hash as `0x${string}` });
    if (receipt.status !== "success") throw new Error(`setAgentWallet transaction ${txHash} reverted.`);
    markOnchainRequest(options.db, requestId, "confirmed", txHash);
    return txHash;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    markOnchainRequest(options.db, requestId, "failed", null, message);
    throw error;
  }
}

export async function giveFeedback(
  account: PrivateKeyAccount,
  agentId: string,
  params: {
    value: bigint;
    valueDecimals?: number;
    tag1?: string;
    tag2?: string;
    endpoint?: string;
    feedbackURI?: string;
    feedbackHash?: `0x${string}`;
  },
  options: {
    network?: Network;
    rpcUrl?: string;
    requestId?: string;
    db?: AutomatonDatabase;
  } = {},
): Promise<string> {
  const network = options.network ?? "mainnet";
  const requestId = options.requestId ?? `feedback:${account.address}:${agentId}:${params.value.toString()}:${params.tag1 ?? ""}:${params.tag2 ?? ""}`;
  const priorHash = existingConfirmedHash(options.db, requestId);
  if (priorHash) return priorHash;

  const contracts = getErc8004Contracts(network);
  const publicClient = buildPublicClient(network, options.rpcUrl);
  const walletClient = buildWalletClient(account, network, options.rpcUrl);
  const feedbackHash = params.feedbackHash ?? `0x${"00".repeat(32)}`;

  await recordOnchainRequest(options.db, {
    requestId,
    operation: "erc8004.give_feedback",
    network,
    status: "prepared",
    txHash: null,
    error: null,
    metadataJson: JSON.stringify({
      agentId,
      value: params.value.toString(),
      valueDecimals: params.valueDecimals ?? 0,
      tag1: params.tag1 ?? "",
      tag2: params.tag2 ?? "",
      endpoint: params.endpoint ?? "",
      feedbackURI: params.feedbackURI ?? "",
      feedbackHash,
    }),
  });

  try {
    const hash = await walletClient.writeContract({
      account,
      chain: contracts.chain,
      address: contracts.reputation,
      abi: REPUTATION_ABI,
      functionName: "giveFeedback",
      args: [
        BigInt(agentId),
        params.value,
        params.valueDecimals ?? 0,
        params.tag1 ?? "",
        params.tag2 ?? "",
        params.endpoint ?? "",
        params.feedbackURI ?? "",
        feedbackHash,
      ],
    });
    const txHash = normalizeHash(hash);
    markOnchainRequest(options.db, requestId, "submitted", txHash);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: hash as `0x${string}` });
    if (receipt.status !== "success") throw new Error(`Feedback transaction ${txHash} reverted.`);
    markOnchainRequest(options.db, requestId, "confirmed", txHash);
    return txHash;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    markOnchainRequest(options.db, requestId, "failed", null, message);
    throw error;
  }
}

export async function getReputationSummary(
  agentId: string,
  options: {
    network?: Network;
    rpcUrl?: string;
    clientAddresses?: Address[];
    tag1?: string;
    tag2?: string;
  } = {},
): Promise<ReputationSummary> {
  const network = options.network ?? "mainnet";
  const contracts = getErc8004Contracts(network);
  const publicClient = buildPublicClient(network, options.rpcUrl);
  const result = await publicClient.readContract({
    address: contracts.reputation,
    abi: REPUTATION_ABI,
    functionName: "getSummary",
    args: [
      BigInt(agentId),
      options.clientAddresses ?? [],
      options.tag1 ?? "",
      options.tag2 ?? "",
    ],
  });
  const [count, summaryValue, summaryValueDecimals] = result as readonly [bigint, bigint, number];
  return {
    count: Number(count),
    summaryValue,
    decimals: Number(summaryValueDecimals),
  };
}

export async function queryAgent(
  agentId: string,
  network: Network = "mainnet",
  rpcUrl?: string,
): Promise<{ agentId: string; owner: string; agentURI: string } | null> {
  const contracts = getErc8004Contracts(network);
  const publicClient = buildPublicClient(network, rpcUrl);

  try {
    const agentURI = await publicClient.readContract({
      address: contracts.identity,
      abi: IDENTITY_ABI,
      functionName: "tokenURI",
      args: [BigInt(agentId)],
    }) as string;

    let owner = "";
    try {
      owner = await publicClient.readContract({
        address: contracts.identity,
        abi: IDENTITY_ABI,
        functionName: "ownerOf",
        args: [BigInt(agentId)],
      }) as string;
    } catch {
      // ownerOf can fail for burned/nonstandard tokens while tokenURI remains useful.
    }

    return { agentId, owner, agentURI };
  } catch {
    return null;
  }
}

/**
 * Return totalSupply when the registry exposes it. Some deployed registries do
 * not support enumerable supply; in that case return 0 so callers use the
 * complete Transfer-event fallback. We intentionally do not guess supply via
 * ownerOf binary search because transport failures are indistinguishable from
 * token absence and can silently undercount.
 */
export async function getTotalAgents(
  network: Network = "mainnet",
  rpcUrl?: string,
): Promise<number> {
  const contracts = getErc8004Contracts(network);
  const publicClient = buildPublicClient(network, rpcUrl);

  try {
    const total = await publicClient.readContract({
      address: contracts.identity,
      abi: IDENTITY_ABI,
      functionName: "totalSupply",
    });
    const value = Number(total);
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Invalid ERC-8004 totalSupply value: ${String(total)}`);
    }
    return value;
  } catch (error) {
    logger.debug("ERC-8004 totalSupply unavailable; using event fallback", {
      network,
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}

/**
 * Discover the newest registered agent IDs from ERC-721 mint events.
 *
 * This scan is fail-closed for completeness: it stops only after it has found
 * enough newest unique mints or reached the verified deployment block. RPC
 * chunks are retried; a persistent chunk failure rejects instead of returning
 * a partial list that looks complete.
 */
export async function getRegisteredAgentsByEvents(
  network: Network = "mainnet",
  limit = 20,
  rpcUrl?: string,
): Promise<RegisteredAgent[]> {
  const contracts = getErc8004Contracts(network);
  const publicClient = buildPublicClient(network, rpcUrl);
  const currentBlock = await publicClient.getBlockNumber();

  const events = await scanLatestMintEvents({
    currentBlock,
    deploymentBlock: contracts.deploymentBlock,
    limit,
    maxBlockDifference: 1_999n,
    getChunk: async (fromBlock, toBlock) => {
      const logs = await publicClient.getLogs({
        address: contracts.identity,
        event: TRANSFER_EVENT,
        args: { from: ZERO_ADDRESS },
        fromBlock,
        toBlock,
      });

      return logs.map((log: any) => {
        const tokenId = log?.args?.tokenId;
        const owner = log?.args?.to;
        if (typeof tokenId !== "bigint" || typeof owner !== "string" || owner.length === 0) {
          throw new Error(`Malformed ERC-8004 mint event in blocks ${fromBlock}-${toBlock}.`);
        }
        return { tokenId, owner };
      });
    },
  });

  return events.map((event) => ({
    tokenId: event.tokenId.toString(),
    owner: event.owner,
  }));
}

/** Check whether an address owns at least one ERC-8004 agent token. */
export async function hasRegisteredAgent(
  address: Address,
  network: Network = "mainnet",
  rpcUrl?: string,
): Promise<boolean> {
  const contracts = getErc8004Contracts(network);
  const publicClient = buildPublicClient(network, rpcUrl);
  const balanceOfAbi = parseAbi(["function balanceOf(address owner) external view returns (uint256)"]);
  const balance = await publicClient.readContract({
    address: contracts.identity,
    abi: balanceOfAbi,
    functionName: "balanceOf",
    args: [address],
  });
  return BigInt(balance as bigint) > 0n;
}
