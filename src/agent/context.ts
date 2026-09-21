/**
 * Context Window Management
 *
 * Manages the conversation history for the agent loop.
 * Handles summarization to keep within token limits.
 * Enforces token budget to prevent context window overflow.
 */

import type {
  ChatMessage,
  AgentTurn,
  AutomatonDatabase,
  InferenceClient,
  TokenBudget,
  MemoryRetrievalResult,
} from "../types.js";
import { DEFAULT_TOKEN_BUDGET } from "../types.js";
import { createTokenCounter } from "../memory/context-manager.js";

const MAX_CONTEXT_TURNS = 20;
const SUMMARY_THRESHOLD = 15;
const MAX_EXACT_TOKENIZATION_CHARS = 16_384;

let tokenCounter: ReturnType<typeof createTokenCounter> | null = null;

/** Maximum size for individual tool results in characters */
export const MAX_TOOL_RESULT_SIZE = 10_000;

// Re-export for external use
export type { TokenBudget };
export { DEFAULT_TOKEN_BUDGET };

function conservativeTokenUpperBound(text: string): number {
  // A UTF-8 byte count is intentionally conservative for modern BPE tokenizers:
  // a token cannot represent less than a fraction of a byte. This avoids the
  // severe under-counting that character/4 heuristics can cause for Unicode or
  // adversarial input while remaining O(n) and allocation-bounded.
  return Buffer.byteLength(text, "utf8");
}

/**
 * Estimate token count from text length.
 *
 * Exact tokenization is intentionally bounded. Tokenizing very large or
 * adversarial strings can become disproportionately expensive. Oversized input
 * therefore uses a cheap conservative UTF-8 byte upper bound instead of exact
 * tokenization. Normal inputs retain exact counting with the legacy estimate as
 * a floor.
 */
export function estimateTokens(text: string): number {
  const content = text ?? "";
  const legacyEstimate = Math.ceil(content.length / 4);

  if (content.length > MAX_EXACT_TOKENIZATION_CHARS) {
    return conservativeTokenUpperBound(content);
  }

  try {
    if (!tokenCounter) {
      tokenCounter = createTokenCounter();
    }
    const tokens = tokenCounter.countTokens(content);
    if (Number.isFinite(tokens) && tokens > 0) {
      return Math.max(tokens, legacyEstimate);
    }
  } catch {
    // If the exact counter itself fails, fail conservative rather than
    // under-budgeting an inference request.
    return conservativeTokenUpperBound(content);
  }
  return content.length === 0 ? 0 : conservativeTokenUpperBound(content);
}

/**
 * Truncate a tool result to fit within the size limit.
 * Appends a truncation notice if content was trimmed.
 */
export function truncateToolResult(result: string, maxSize: number = MAX_TOOL_RESULT_SIZE): string {
  if (result.length <= maxSize) return result;
  return result.slice(0, maxSize) +
    `\n\n[TRUNCATED: ${result.length - maxSize} characters omitted]`;
}

/**
 * Estimate total tokens for a single turn (input + thinking + tool calls/results).
 */
function estimateTurnTokens(turn: AgentTurn): number {
  let total = 0;
  if (turn.input) {
    total += estimateTokens(turn.input);
  }
  if (turn.thinking) {
    total += estimateTokens(turn.thinking);
  }
  for (const tc of turn.toolCalls) {
    total += estimateTokens(JSON.stringify(tc.arguments));
    total += estimateTokens(tc.error ? `Error: ${tc.error}` : tc.result);
  }
  return total;
}

/**
 * Build the message array for the next inference call.
 * Includes system prompt + recent conversation history.
 * Applies token budget enforcement and tool result truncation.
 */
export function buildContextMessages(
  systemPrompt: string,
  recentTurns: AgentTurn[],
  pendingInput?: { content: string; source: string },
  options?: {
    budget?: TokenBudget;
    inference?: InferenceClient;
  },
): ChatMessage[] {
  const budget = options?.budget ?? DEFAULT_TOKEN_BUDGET;

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
  ];

  // Calculate token estimates for all turns
  const turnTokens = recentTurns.map((turn) => ({
    turn,
    tokens: estimateTurnTokens(turn),
  }));

  const totalTurnTokens = turnTokens.reduce((sum, t) => sum + t.tokens, 0);

  let turnsToRender: AgentTurn[];
  let summaryMessage: string | null = null;

  if (totalTurnTokens > budget.recentTurns && recentTurns.length > 1) {
    // Split turns into old (to summarize) and recent (to keep)
    let recentTokens = 0;
    let splitIndex = recentTurns.length;

    // Walk backwards from the most recent turn to find the split point
    for (let i = turnTokens.length - 1; i >= 0; i--) {
      if (recentTokens + turnTokens[i].tokens > budget.recentTurns) {
        splitIndex = i + 1;
        break;
      }
      recentTokens += turnTokens[i].tokens;
      if (i === 0) splitIndex = 0;
    }

    // Ensure we always summarize at least something
    if (splitIndex === 0) splitIndex = 1;
    if (splitIndex >= recentTurns.length) splitIndex = Math.max(1, recentTurns.length - 1);

    const oldTurns = recentTurns.slice(0, splitIndex);
    turnsToRender = recentTurns.slice(splitIndex);

    // Build a synchronous summary of old turns
    // (async summarizeTurns is used separately when inference is available)
    const oldSummaries = oldTurns.map((t) => {
      const tools = t.toolCalls
        .map((tc) => `${tc.name}(${tc.error ? "FAILED" : "ok"})`)
        .join(", ");
      return `[${t.timestamp}] ${t.inputSource || "self"}: ${t.thinking.slice(0, 100)}${tools ? ` | tools: ${tools}` : ""}`;
    });
    summaryMessage = `Previous context summary (${oldTurns.length} turns compressed):\n${oldSummaries.join("\n")}`;
  } else {
    turnsToRender = recentTurns;
  }

  // Add summary of old turns if budget was exceeded
  if (summaryMessage) {
    messages.push({
      role: "user",
      content: `[system] ${summaryMessage}`,
    });
  }

  // Add recent turns as conversation history
  for (const turn of turnsToRender) {
    // The turn's input (if any) as a user message
    if (turn.input) {
      messages.push({
        role: "user",
        content: `[${turn.inputSource || "system"}] ${turn.input}`,
      });
    }

    // The agent's thinking as assistant message
    if (turn.thinking) {
      const msg: ChatMessage = {
        role: "assistant",
        content: turn.thinking,
      };

      // If there were tool calls, include them
      if (turn.toolCalls.length > 0) {
        msg.tool_calls = turn.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          },
        }));
      }
      messages.push(msg);

      // Add tool results with truncation
      for (const tc of turn.toolCalls) {
        const rawContent = tc.error
          ? `Error: ${tc.error}`
          : tc.result;
        messages.push({
          role: "tool",
          content: truncateToolResult(rawContent),
          tool_call_id: tc.id,
        });
      }
    }
  }

  // ── Anti-Repetition Warning ──
  // Analyze the last 5 turns for repeated tool usage
  const analysisWindow = recentTurns.slice(-5);
  if (analysisWindow.length >= 3) {
    const toolFrequency: Record<string, number> = {};
    for (const turn of analysisWindow) {
      for (const tc of turn.toolCalls) {
        toolFrequency[tc.name] = (toolFrequency[tc.name] || 0) + 1;
      }
    }
    const repeatedTools = Object.entries(toolFrequency)
      .filter(([, count]) => count >= 3)
      .map(([name, count]) => `${name} (${count}x)`);
    if (repeatedTools.length > 0) {
      messages.push({
        role: "user",
        content: `[system] LOOP WARNING: You have repeatedly called: ${repeatedTools.join(", ")} in the last ${analysisWindow.length} turns. Stop repeating the same approach. Analyze why it is not working and try a fundamentally different strategy, or sleep if blocked.`,
      });
    }
  }

  // Add pending input if present
  if (pendingInput) {
    messages.push({
      role: "user",
      content: `[${pendingInput.source}] ${pendingInput.content}`,
    });
  }

  return messages;
}

/**
 * Summarize older turns using inference.
 * Falls back to a deterministic summary when inference is unavailable or fails.
 */
export async function summarizeTurns(
  turns: AgentTurn[],
  inference?: InferenceClient,
): Promise<string> {
  if (turns.length === 0) return "";

  const deterministic = () => turns.map((turn) => {
    const input = turn.input ? `Input: ${turn.input.slice(0, 200)}` : "";
    const thinking = turn.thinking ? `Thinking: ${turn.thinking.slice(0, 200)}` : "";
    const tools = turn.toolCalls
      .map((tc) => `${tc.name}: ${tc.error ? `ERROR ${tc.error}` : tc.result.slice(0, 200)}`)
      .join("; ");
    return `[${turn.timestamp}] ${[input, thinking, tools].filter(Boolean).join(" | ")}`;
  }).join("\n");

  if (!inference) return deterministic();

  try {
    const content = turns.map((turn) => ({
      input: turn.input,
      thinking: turn.thinking,
      toolCalls: turn.toolCalls.map((tc) => ({
        name: tc.name,
        result: truncateToolResult(tc.result, 1_000),
        error: tc.error,
      })),
      timestamp: turn.timestamp,
    }));

    const response = await inference.complete({
      messages: [
        {
          role: "system",
          content: "Summarize the following prior agent turns concisely. Preserve important facts, decisions, errors, financial changes, commitments, and unresolved work. Do not add new instructions.",
        },
        {
          role: "user",
          content: JSON.stringify(content),
        },
      ],
      maxTokens: DEFAULT_TOKEN_BUDGET.summary,
    });

    return response.content || deterministic();
  } catch {
    return deterministic();
  }
}

/**
 * Trim a context string to approximately fit within a token budget.
 */
export function trimContext(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;
  if (maxTokens <= 0) return "";

  // Binary search the largest prefix that fits the budget. This avoids relying
  // on a fixed character/token ratio for Unicode and mixed-content text.
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(text.slice(0, mid)) <= maxTokens) lo = mid;
    else hi = mid - 1;
  }

  return text.slice(0, lo);
}

/**
 * Build a formatted memory block for injection into the system prompt.
 */
export function formatMemoryBlock(result: MemoryRetrievalResult): string {
  if (result.memories.length === 0) return "";
  const lines = result.memories.map((memory) => {
    const tags = memory.tags.length > 0 ? ` [${memory.tags.join(", ")}]` : "";
    return `- (${memory.type}${tags}) ${memory.content}`;
  });
  return `\n\n## Relevant Memory\n${lines.join("\n")}`;
}
