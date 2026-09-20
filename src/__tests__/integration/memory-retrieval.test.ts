import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type BetterSqlite3 from "better-sqlite3";
import { createInMemoryDb } from "../orchestration/test-db.js";
import {
  EnhancedRetriever,
  enhanceQuery,
  recordRetrievalFeedback,
  calculateMemoryBudget,
  type ScoredMemoryRetrievalResult,
} from "../../memory/enhanced-retriever.js";
import type { ContextUtilization } from "../../memory/context-manager.js";
import { KnowledgeStore } from "../../memory/knowledge-store.js";

function addKnowledge(
  store: KnowledgeStore,
  category: "market" | "technical" | "social" | "financial" | "operational",
  key: string,
  content: string,
  opts: {
    confidence?: number;
    lastVerified?: string;
    tokenCount?: number;
    accessCount?: number;
  } = {},
): string {
  const id = store.add({
    category,
    key,
    content,
    source: "0xtest",
    confidence: opts.confidence ?? 0.8,
    lastVerified: opts.lastVerified ?? new Date().toISOString(),
    tokenCount: opts.tokenCount ?? Math.max(1, Math.ceil(content.length / 4)),
    expiresAt: null,
  });

  if (opts.accessCount && opts.accessCount > 0) {
    for (let i = 0; i < opts.accessCount; i++) {
      store.get(id);
    }
  }

  return id;
}

function contextUtilization(
  utilizationPercent: number,
  totalTokens: number,
  usedTokens: number,
): ContextUtilization {
  return {
    utilizationPercent,
    totalTokens,
    usedTokens,
    turnsInContext: 0,
    compressedTurns: 0,
    compressionRatio: 1,
    headroomTokens: Math.max(0, totalTokens - usedTokens),
    recommendation: utilizationPercent >= 90 ? "emergency" : utilizationPercent >= 75 ? "compress" : "ok",
  };
}

const NOW = new Date().toISOString();
const RECENT = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
const OLD = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();

describe("integration/memory-retrieval", () => {
  let db: BetterSqlite3.Database;
  let knowledgeStore: KnowledgeStore;
  let retriever: EnhancedRetriever;

  beforeEach(() => {
    db = createInMemoryDb();
    knowledgeStore = new KnowledgeStore(db);
    retriever = new EnhancedRetriever(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("scored retrieval", () => {
    it("returns entries sorted descending by relevance score", () => {
      addKnowledge(knowledgeStore, "technical", "api-gateway", "api gateway configuration for routing requests", {
        confidence: 0.95,
        lastVerified: NOW,
        tokenCount: 20,
      });
      addKnowledge(knowledgeStore, "technical", "api-fallback", "api fallback strategy configuration", {
        confidence: 0.5,
        lastVerified: NOW,
        tokenCount: 20,
      });

      const result: ScoredMemoryRetrievalResult = retriever.retrieveScored({
        sessionId: "sess-1",
        currentInput: "api configuration",
        budgetTokens: 1000,
      });

      expect(result.entries.length).toBeGreaterThanOrEqual(1);
      for (let i = 1; i < result.entries.length; i++) {
        expect(result.entries[i - 1].relevanceScore).toBeGreaterThanOrEqual(result.entries[i].relevanceScore);
      }
    });

    it("higher confidence entries rank above lower confidence entries for the same query", () => {
      addKnowledge(knowledgeStore, "technical", "deploy-high", "deploy pipeline architecture", {
        confidence: 0.95,
        lastVerified: NOW,
        tokenCount: 20,
      });
      addKnowledge(knowledgeStore, "technical", "deploy-low", "deploy pipeline architecture", {
        confidence: 0.4,
        lastVerified: NOW,
        tokenCount: 20,
      });

      const result = retriever.retrieveScored({
        sessionId: "sess-2",
        currentInput: "deploy pipeline",
        budgetTokens: 2000,
      });

      const entries = result.entries;
      const highIdx = entries.findIndex((e) => e.entry.key === "deploy-high");
      const lowIdx = entries.findIndex((e) => e.entry.key === "deploy-low");
      expect(highIdx).not.toBe(-1);
      expect(lowIdx).not.toBe(-1);
      expect(highIdx).toBeLessThan(lowIdx);
    });

    it("more recently verified entries rank higher than stale entries", () => {
      addKnowledge(knowledgeStore, "operational", "runbook-new", "incident runbook for database outages", {
        confidence: 0.8,
        lastVerified: RECENT,
        tokenCount: 20,
      });
      addKnowledge(knowledgeStore, "operational", "runbook-old", "incident runbook for database outages", {
        confidence: 0.8,
        lastVerified: OLD,
        tokenCount: 20,
      });

      const result = retriever.retrieveScored({
        sessionId: "sess-3",
        currentInput: "incident runbook database",
        budgetTokens: 2000,
      });

      const entries = result.entries;
      const newIdx = entries.findIndex((e) => e.entry.key === "runbook-new");
      const oldIdx = entries.findIndex((e) => e.entry.key === "runbook-old");
      expect(newIdx).not.toBe(-1);
      expect(oldIdx).not.toBe(-1);
      expect(newIdx).toBeLessThan(oldIdx);
    });

    it("all returned entries have a relevance score >= 0.3", () => {
      addKnowledge(knowledgeStore, "financial", "revenue-q1", "revenue figures for Q1 budget report", {
        confidence: 0.9,
        lastVerified: NOW,
        tokenCount: 25,
      });
      const result = retriever.retrieveScored({
        sessionId: "sess-4",
        currentInput: "revenue budget",
        budgetTokens: 2000,
      });
      for (const entry of result.entries) {
        expect(entry.relevanceScore).toBeGreaterThanOrEqual(0.3);
      }
    });
  });

  describe("dynamic budget", () => {
    beforeEach(() => {
      for (let i = 0; i < 8; i++) {
        addKnowledge(
          knowledgeStore,
          "technical",
          `database-entry-${i}`,
          `database architecture details number ${i}`,
          { confidence: 0.85, lastVerified: NOW, tokenCount: 100 },
        );
      }
    });

    it("tight budget returns fewer entries than a generous budget", () => {
      const tight = retriever.retrieveScored({
        sessionId: "sess-5",
        currentInput: "database architecture",
        budgetTokens: 150,
      });
      const generous = retriever.retrieveScored({
        sessionId: "sess-5",
        currentInput: "database architecture",
        budgetTokens: 800,
      });
      expect(generous.entries.length).toBeGreaterThan(tight.entries.length);
    });

    it("zero budget returns no entries and marks truncated when candidates exist", () => {
      const result = retriever.retrieveScored({
        sessionId: "sess-6",
        currentInput: "database architecture",
        budgetTokens: 0,
      });
      expect(result.entries).toHaveLength(0);
      expect(result.truncated).toBe(true);
    });

    it("total tokens in result does not exceed the given budget", () => {
      const budgetTokens = 350;
      const result = retriever.retrieveScored({
        sessionId: "sess-7",
        currentInput: "database architecture",
        budgetTokens,
      });
      expect(result.totalTokens).toBeLessThanOrEqual(budgetTokens);
    });
  });

  describe("feedback tracking", () => {
    it("recordRetrievalFeedback stores feedback and rolling precision is returned in subsequent results", () => {
      addKnowledge(knowledgeStore, "technical", "auth-service", "authentication service token validation", {
        confidence: 0.9,
        lastVerified: NOW,
        tokenCount: 30,
      });
      const first = retriever.retrieveScored({
        sessionId: "sess-8",
        currentInput: "auth service token",
        budgetTokens: 2000,
      });
      const retrievedIds = first.entries.map((e) => e.entry.id as string);
      retriever.recordRetrievalFeedback({
        turnId: "turn-1",
        retrieved: retrievedIds,
        matched: retrievedIds,
        retrievalPrecision: 1.0,
        rollingPrecision: 1.0,
      });
      const second = retriever.retrieveScored({
        sessionId: "sess-8",
        currentInput: "auth service token",
        budgetTokens: 2000,
      });
      expect(second.retrievalPrecision).toBeDefined();
      expect(second.retrievalPrecision).toBeGreaterThanOrEqual(0);
      expect(second.retrievalPrecision).toBeLessThanOrEqual(1);
    });

    it("feedback with no matched entries yields lower precision than fully matched feedback", () => {
      addKnowledge(knowledgeStore, "technical", "cache-service", "cache invalidation service architecture", {
        confidence: 0.9,
        lastVerified: NOW,
        tokenCount: 30,
      });
      const result = retriever.retrieveScored({
        sessionId: "sess-9",
        currentInput: "cache service",
        budgetTokens: 2000,
      });
      const retrievedIds = result.entries.map((e) => e.entry.id as string);
      recordRetrievalFeedback({
        turnId: "turn-miss",
        retrieved: retrievedIds,
        matched: [],
        retrievalPrecision: 0,
        rollingPrecision: 0,
      });
      const after = retriever.retrieveScored({
        sessionId: "sess-9",
        currentInput: "cache service",
        budgetTokens: 2000,
      });
      expect(after.retrievalPrecision).toBeDefined();
      expect(after.retrievalPrecision!).toBeLessThan(1);
    });
  });

  describe("enhanceQuery", () => {
    it("removes stop words from extracted terms", () => {
      const query = enhanceQuery({ currentInput: "what is the api for the database" });
      const stopWords = new Set(["what", "is", "the", "for", "a", "an", "and", "are", "to"]);
      for (const term of query.terms) {
        expect(stopWords.has(term)).toBe(false);
      }
      expect(query.terms).toContain("api");
      expect(query.terms).toContain("database");
    });

    it("expands abbreviations in query terms", () => {
      const query = enhanceQuery({ currentInput: "api and llm integration" });
      expect(query.terms).toContain("application programming interface");
      expect(query.terms).toContain("large language model");
    });

    it("infers categories from task spec and agent role", () => {
      const query = enhanceQuery({
        currentInput: "deploy infra runbook",
        agentRole: "engineer",
        taskSpec: "architecture review",
      });
      expect(query.categories).toContain("technical");
    });

    it("includes timeRange when query contains recency keywords", () => {
      const query = enhanceQuery({ currentInput: "latest api changes today" });
      expect(query.timeRange).toBeDefined();
      expect(query.timeRange?.since).toBeTruthy();
    });

    it("deduplicates terms and caps at 25 expanded terms", () => {
      const words = Array.from({ length: 40 }, (_, i) => `term${i}`).join(" ");
      const query = enhanceQuery({ currentInput: words });
      expect(query.terms.length).toBeLessThanOrEqual(25);
      const uniqueTerms = new Set(query.terms);
      expect(uniqueTerms.size).toBe(query.terms.length);
    });
  });

  describe("calculateMemoryBudget", () => {
    it("returns a larger budget when context utilization is low", () => {
      const lowUtilization = contextUtilization(40, 10000, 4000);
      const highUtilization = contextUtilization(80, 10000, 8000);
      const lowBudget = calculateMemoryBudget(lowUtilization, 50000);
      const highBudget = calculateMemoryBudget(highUtilization, 50000);
      expect(lowBudget).toBeGreaterThan(highBudget);
    });

    it("clamps result to the minimum budget of 2000 tokens", () => {
      const utilization = contextUtilization(85, 1000, 850);
      const budget = calculateMemoryBudget(utilization, 100);
      expect(budget).toBeGreaterThanOrEqual(2000);
    });

    it("clamps result to the maximum budget of 20000 tokens", () => {
      const utilization = contextUtilization(10, 1_000_000, 100_000);
      const budget = calculateMemoryBudget(utilization, 1_000_000);
      expect(budget).toBeLessThanOrEqual(20000);
    });
  });
});
