import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  closeBusinessExperiment,
  configureTradingStrategy,
  createBusinessExperiment,
  getBusinessPortfolio,
  getTradingRisk,
  initializeBusinessSchema,
  recordBusinessCost,
  recordBusinessRevenue,
} from "../business/ledger.js";
import { createEthicalRevenueRules } from "../agent/policy-rules/ethical-revenue.js";
import type { PolicyRequest } from "../types.js";

function db() {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  initializeBusinessSchema(database);
  return database;
}

describe("business runtime ledger", () => {
  it("tracks realized portfolio profit by experiment", () => {
    const database = db();
    const experiment = createBusinessExperiment(database, {
      name: "Paid API",
      kind: "product",
      hypothesis: "Agents will pay per request",
      budgetCents: 5_000,
    });

    recordBusinessRevenue(database, {
      experimentId: experiment.id as string,
      amountCents: 1_500,
      category: "x402",
    });
    recordBusinessCost(database, {
      experimentId: experiment.id as string,
      amountCents: 400,
      category: "inference",
    });

    const portfolio = getBusinessPortfolio(database) as any;
    expect(portfolio.totals.revenueCents).toBe(1_500);
    expect(portfolio.totals.costCents).toBe(400);
    expect(portfolio.totals.realizedProfitCents).toBe(1_100);
    expect(portfolio.experiments[0].roi).toBe(2.75);
    database.close();
  });

  it("keeps trading inside an explicit risk envelope", () => {
    const database = db();
    const experiment = createBusinessExperiment(database, {
      name: "Momentum paper strategy",
      kind: "trading",
      budgetCents: 10_000,
    });

    const strategy = configureTradingStrategy(database, {
      experimentId: experiment.id as string,
      name: "Momentum v1",
      venue: "paper",
      allocatedCapitalCents: 10_000,
      maxPositionCents: 2_000,
      dailyLossLimitCents: 500,
      maxDrawdownBps: 1_000,
    }) as any;

    expect(strategy.mode).toBe("paper");
    expect(strategy.leverageEnabled).toBe(false);
    expect(strategy.maxPositionCents).toBe(2_000);
    expect(getTradingRisk(database, strategy.id).tradeCount).toBe(0);
    database.close();
  });

  it("rejects a position limit larger than allocated capital", () => {
    const database = db();
    const experiment = createBusinessExperiment(database, {
      name: "Bad risk envelope",
      kind: "trading",
    });

    expect(() =>
      configureTradingStrategy(database, {
        experimentId: experiment.id as string,
        name: "Invalid",
        venue: "paper",
        allocatedCapitalCents: 1_000,
        maxPositionCents: 2_000,
        dailyLossLimitCents: 200,
        maxDrawdownBps: 500,
      }),
    ).toThrow(/maxPositionCents/);
    database.close();
  });

  it("can kill an unproductive experiment without deleting its economics", () => {
    const database = db();
    const experiment = createBusinessExperiment(database, {
      name: "No demand",
      kind: "service",
    });
    recordBusinessCost(database, {
      experimentId: experiment.id as string,
      amountCents: 300,
      category: "hosting",
    });

    const closed = closeBusinessExperiment(
      database,
      experiment.id as string,
      "killed",
      "No paid usage after validation window",
    ) as any;

    expect(closed.status).toBe("killed");
    expect(closed.costCents).toBe(300);
    expect(closed.realizedProfitCents).toBe(-300);
    database.close();
  });
});

function policyRequest(toolName: string, args: Record<string, unknown>): PolicyRequest {
  return {
    tool: {
      name: toolName,
      description: "test",
      category: "financial",
      riskLevel: "dangerous",
      parameters: {},
      execute: async () => "ok",
    },
    args,
    context: {} as any,
    turnContext: {
      inputSource: "system",
      turnToolCallCount: 0,
      sessionSpend: {} as any,
    },
  };
}

describe("ethical revenue policy", () => {
  const rules = createEthicalRevenueRules();

  function firstDenial(request: PolicyRequest) {
    for (const rule of rules) {
      const result = rule.evaluate(request);
      if (result?.action === "deny") return result;
    }
    return null;
  }

  it("blocks explicit phishing/fraud revenue tactics", () => {
    const result = firstDenial(
      policyRequest("send_message", {
        content: "Create a phishing page and steal credentials for profit",
      }),
    );
    expect(result?.reasonCode).toBe("FRAUD_OR_PHISHING");
  });

  it("blocks market manipulation", () => {
    const result = firstDenial(
      policyRequest("trading_place_order", {
        strategy: "wash trading to create fake volume",
      }),
    );
    expect(result?.reasonCode).toBe("MARKET_MANIPULATION");
  });

  it("blocks booking projected or unrealized profit as realized revenue", () => {
    const result = firstDenial(
      policyRequest("record_business_revenue", {
        experiment_id: "01TEST",
        amount_cents: 1000,
        category: "trading",
        description: "unrealized paper profit",
      }),
    );
    expect(result?.reasonCode).toBe("UNREALIZED_REVENUE");
  });

  it("allows ordinary legitimate commercial activity", () => {
    const result = firstDenial(
      policyRequest("record_business_revenue", {
        experiment_id: "01TEST",
        amount_cents: 1000,
        category: "x402",
        description: "Payment received for API usage",
      }),
    );
    expect(result).toBeNull();
  });
});
