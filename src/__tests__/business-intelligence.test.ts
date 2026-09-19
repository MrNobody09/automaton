import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  calculateOpportunityScore,
  convertOpportunityToExperiment,
  createBusinessOpportunity,
  generateBusinessReview,
  getOpportunityPipeline,
  scoreBusinessOpportunity,
} from "../business/intelligence.js";
import {
  createBusinessExperiment,
  recordBusinessCost,
  recordBusinessRevenue,
  updateBusinessExperiment,
} from "../business/ledger.js";

function memoryDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  return db;
}

describe("business opportunity scoring", () => {
  it("computes an auditable expected-value score", () => {
    const score = calculateOpportunityScore({
      estimatedRevenueCents: 10000,
      estimatedBuildCostCents: 1500,
      estimatedRecurringCostCents: 500,
      capitalAtRiskCents: 2000,
      successProbability: 0.5,
      riskScore: 0.25,
      timeToRevenueDays: 30,
      learningValue: 0.5,
    });

    expect(score.expectedRevenueCents).toBe(5000);
    expect(score.riskPenaltyCents).toBe(500);
    expect(score.expectedProfitCents).toBe(2500);
    expect(score.speedMultiplier).toBeCloseTo(0.5);
    expect(score.priorityValueCents).toBe(1500);
  });

  it("orders scored opportunities by priority value", () => {
    const db = memoryDb();
    const fast = createBusinessOpportunity(db, {
      title: "Fast API",
      revenueMechanism: "paid API",
      targetBuyer: "agents",
      estimatedRevenueCents: 5000,
      estimatedBuildCostCents: 500,
      successProbability: 0.7,
      timeToRevenueDays: 5,
    });
    const slow = createBusinessOpportunity(db, {
      title: "Slow product",
      revenueMechanism: "subscription",
      targetBuyer: "developers",
      estimatedRevenueCents: 5000,
      estimatedBuildCostCents: 500,
      successProbability: 0.7,
      timeToRevenueDays: 90,
    });

    scoreBusinessOpportunity(db, fast.id as string);
    scoreBusinessOpportunity(db, slow.id as string);

    const pipeline = getOpportunityPipeline(db);
    expect(pipeline[0].id).toBe(fast.id);
    expect(pipeline[1].id).toBe(slow.id);
    db.close();
  });
});

describe("opportunity conversion", () => {
  it("converts a researched opportunity into a tracked experiment", () => {
    const db = memoryDb();
    const opportunity = createBusinessOpportunity(db, {
      title: "Paid research endpoint",
      revenueMechanism: "x402 per request",
      targetBuyer: "AI agents",
      demandEvidence: "multiple requests for the same data",
      estimatedBuildCostCents: 1000,
      estimatedRecurringCostCents: 200,
    });

    const result = convertOpportunityToExperiment(
      db,
      opportunity.id as string,
      "product",
    ) as any;

    expect(result.opportunity.status).toBe("converted");
    expect(result.experiment.kind).toBe("product");
    expect(result.experiment.budgetCents).toBe(1200);
    expect(result.opportunity.linkedExperimentId).toBe(result.experiment.id);
    db.close();
  });
});

describe("business review", () => {
  it("flags a profitable validated experiment as a scaling candidate", () => {
    const db = memoryDb();
    const experiment = createBusinessExperiment(db, {
      name: "Useful API",
      kind: "product",
      budgetCents: 5000,
    });
    updateBusinessExperiment(db, experiment.id as string, { status: "validating" });
    recordBusinessCost(db, {
      experimentId: experiment.id as string,
      amountCents: 1000,
      category: "hosting",
    });
    recordBusinessRevenue(db, {
      experimentId: experiment.id as string,
      amountCents: 2500,
      category: "sales",
    });

    const review = generateBusinessReview(db);
    expect(review.actionable).toBe(true);
    expect(review.recommendations[0].action).toBe("consider_scaling");
    db.close();
  });

  it("flags an experiment that spends most of budget without revenue", () => {
    const db = memoryDb();
    const experiment = createBusinessExperiment(db, {
      name: "No-demand service",
      kind: "service",
      budgetCents: 1000,
    });
    updateBusinessExperiment(db, experiment.id as string, { status: "validating" });
    recordBusinessCost(db, {
      experimentId: experiment.id as string,
      amountCents: 800,
      category: "acquisition",
    });

    const review = generateBusinessReview(db);
    expect(review.actionable).toBe(true);
    expect(review.recommendations[0].action).toBe("consider_pause");
    db.close();
  });

  it("surfaces scored opportunities in the periodic review", () => {
    const db = memoryDb();
    const opportunity = createBusinessOpportunity(db, {
      title: "Agent data API",
      revenueMechanism: "per request",
      targetBuyer: "agents",
      estimatedRevenueCents: 3000,
      estimatedBuildCostCents: 300,
      successProbability: 0.8,
      timeToRevenueDays: 3,
    });
    scoreBusinessOpportunity(db, opportunity.id as string);

    const review = generateBusinessReview(db);
    expect(review.actionable).toBe(true);
    expect(review.topOpportunities).toHaveLength(1);
    expect(review.topOpportunities[0].id).toBe(opportunity.id);
    db.close();
  });
});
