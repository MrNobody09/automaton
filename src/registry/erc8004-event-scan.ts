export interface MintEvent {
  tokenId: bigint;
  owner: string;
}

export interface MintEventScanOptions {
  currentBlock: bigint;
  deploymentBlock: bigint;
  limit: number;
  maxBlockDifference?: bigint;
  maxAttemptsPerChunk?: number;
  chunkTimeoutMs?: number;
  getChunk: (fromBlock: bigint, toBlock: bigint) => Promise<MintEvent[]>;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_BLOCK_DIFFERENCE = 1_999n;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_CHUNK_TIMEOUT_MS = 8_000;

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`RPC chunk timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Scan ERC-721 mint events newest-first without silently returning incomplete
 * results. The scan stops only when it has enough newest unique token IDs or
 * when it has reached the verified deployment block.
 *
 * Any chunk that still fails after bounded retries aborts the whole operation;
 * callers never receive a partial result that looks complete.
 */
export async function scanLatestMintEvents(options: MintEventScanOptions): Promise<MintEvent[]> {
  const {
    currentBlock,
    deploymentBlock,
    getChunk,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = options;
  const limit = options.limit;
  const maxBlockDifference = options.maxBlockDifference ?? DEFAULT_MAX_BLOCK_DIFFERENCE;
  const maxAttempts = options.maxAttemptsPerChunk ?? DEFAULT_MAX_ATTEMPTS;
  const chunkTimeoutMs = options.chunkTimeoutMs ?? DEFAULT_CHUNK_TIMEOUT_MS;

  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
    throw new RangeError(`ERC-8004 event scan limit must be an integer from 1 to 1000; received ${String(limit)}.`);
  }
  if (maxBlockDifference < 0n) throw new RangeError("maxBlockDifference must be non-negative.");
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw new RangeError("maxAttemptsPerChunk must be an integer from 1 to 10.");
  }
  if (!Number.isInteger(chunkTimeoutMs) || chunkTimeoutMs < 100) {
    throw new RangeError("chunkTimeoutMs must be an integer >= 100.");
  }
  if (currentBlock < deploymentBlock) return [];

  const byTokenId = new Map<string, MintEvent>();
  let scanTo = currentBlock;

  while (scanTo >= deploymentBlock) {
    const candidateFrom = scanTo > maxBlockDifference ? scanTo - maxBlockDifference : 0n;
    const scanFrom = candidateFrom > deploymentBlock ? candidateFrom : deploymentBlock;

    let chunk: MintEvent[] | null = null;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        chunk = await withTimeout(getChunk(scanFrom, scanTo), chunkTimeoutMs);
        break;
      } catch (error) {
        lastError = error;
        if (attempt < maxAttempts) await sleep(Math.min(1_000, 150 * 2 ** (attempt - 1)));
      }
    }

    if (chunk === null) {
      const detail = lastError instanceof Error ? lastError.message : String(lastError);
      throw new Error(`ERC-8004 mint-event scan failed for blocks ${scanFrom}-${scanTo} after ${maxAttempts} attempts: ${detail}`);
    }

    for (const event of chunk) {
      const id = event.tokenId.toString();
      if (!byTokenId.has(id)) byTokenId.set(id, event);
    }

    if (byTokenId.size >= limit || scanFrom === deploymentBlock) break;
    scanTo = scanFrom - 1n;
  }

  return [...byTokenId.values()]
    .sort((a, b) => (a.tokenId === b.tokenId ? 0 : a.tokenId > b.tokenId ? -1 : 1))
    .slice(0, limit);
}
