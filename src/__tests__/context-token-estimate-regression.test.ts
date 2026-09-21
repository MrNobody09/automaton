import { describe, expect, it } from "vitest";
import { estimateTokens } from "../agent/context.js";

describe("oversized context token estimation", () => {
  it("avoids exact-tokenizer work and does not undercount oversized ASCII input", () => {
    const text = "x".repeat(20_000);
    expect(estimateTokens(text)).toBe(Buffer.byteLength(text, "utf8"));
  });

  it("uses UTF-8 byte length for oversized Unicode input", () => {
    const text = "界".repeat(20_000);
    const estimate = estimateTokens(text);
    expect(estimate).toBe(Buffer.byteLength(text, "utf8"));
    expect(estimate).toBeGreaterThan(text.length);
  });
});
