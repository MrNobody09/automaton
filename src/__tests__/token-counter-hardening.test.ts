import { describe, expect, it } from "vitest";
import { createTokenCounter } from "../memory/context-manager.js";

describe("token counter hardening", () => {
  it("bounds oversized inputs without caching giant keys", () => {
    const counter = createTokenCounter();
    const oversized = "x".repeat(70_000);

    const count = counter.countTokens(oversized);

    expect(count).toBe(Buffer.byteLength(oversized, "utf8"));
    expect(counter.cache.size).toBe(0);
  });

  it("keeps normal inputs cacheable", () => {
    const counter = createTokenCounter();

    const first = counter.countTokens("normal context text");
    const second = counter.countTokens("normal context text");

    expect(first).toBe(second);
    expect(counter.cache.size).toBe(1);
  });
});
