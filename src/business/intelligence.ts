import type BetterSqlite3 from "better-sqlite3";
import { ulid } from "ulid";
import {
  createBusinessExperiment,
  getBusinessPortfolio,
  initializeBusinessSchema,
} from "./ledger.js";

export type OpportunityStatus =
  | "discovered"
  | "researching"
  | "scored"
  | "approved"
  | "rejected"
  | "converted";

export interface BusinessOpportunityInput {
  title: string;
  revenueMechanism: string;
  targetBuyer: string;
  demandEvidence?: string;
  estimatedRevenueCents?: number;
  estimatedBuildCostCents?: number;
  estimatedRecurringCostCents?: number;
  capitalAtRiskCents?: number;
  successProbability?: number;
  riskScore?: number;
  timeToRevenueDays?: number;
  learningValue?: number;
  competitionNotes?: string;
  legalEthicalNotes?: string;
  source?: string;
  metadata?: Record<string, unknown>;
}

export interface OpportunityScore {
  expectedRevenueCents: number;
  expectedProfitCents: number;
  riskPenaltyCents: number;
  speedMultiplier: number;
  learningBonusCents: number;
  priorityValueCents: number;
}

export interface BusinessReview {
  generatedAt: string;
  totals: {
    revenueCents: number;
    costCents: number;
    realizedProfitCents: number;
  };
  experimentCount: number;
  activeExperimentCount: number;
  recommendations: Array<{
    experimentId: string;
    experimentName: string;
    action: "continue" | "review" | "consider_scaling" | "consider_pause" | "consider_kill";
    reason: string;
  }>;
  topOpportunities: Record<string, unknown>[];
  summary: string;
  actionable: boolean;
}

const VALID_OPPORTUNITY_STATUSES = new Set<OpportunityStatus>([
  "discovered",
  "researching",
  "scored",
  "approved",
  "rejected",
  "converted",
]);

function assertCents(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer number of cents`);
  }
}

function assertUnitInterval(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${field} must be between 0 and 1`);
  }
}

export function initializeBusinessIntelligenceSchema(db: BetterSqlite3.Database): void {
  initializeBusinessSchema(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS business_opportunities (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'discovered'
        CHECK(status IN ('discovered','researching','scored','approved','rejected','converted')),
      revenue_mechanism TEXT NOT NULL,
      target_buyer TEXT NOT NULL,
      demand_evidence TEXT NOT NULL DEFAULT '',
      estimated_revenue_cents INTEGER NOT NULL DEFAULT 0 CHECK(estimated_revenue_cents >= 0),
      estimated_build_cost_cents INTEGER NOT NULL DEFAULT 0 CHECK(estimated_build_cost_cents >= 0),
      estimated_recurring_cost_cents INTEGER NOT NULL DEFAULT 0 CHECK(estimated_recurring_cost_cents >= 0),
      capital_at_risk_cents INTEGER NOT NULL DEFAULT 0 CHECK(capital_at_risk_cents >= 0),
      success_probability REAL NOT NULL DEFAULT 0.25 CHECK(success_probability >= 0 AND success_probability <= 1),
      risk_score REAL NOT NULL DEFAULT 0.25 CHECK(risk_score >= 0 AND risk_score <= 1),
      time_to_revenue_days INTEGER NOT NULL DEFAULT 30 CHECK(time_to_revenue_days >= 0),
      learning_value REAL NOT NULL DEFAULT 0.0 CHECK(learning_value >= 0 AND learning_value <= 1),
      competition_notes TEXT NOT NULL DEFAULT '',
      legal_ethical_notes TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      score_json TEXT,
      priority_value_cents REAL,
      linked_experiment_id TEXT REFERENCES business_experiments(id),
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_business_opportunities_status
      ON business_opportunities(status, priority_value_cents DESC, updated_at DESC);

    CREATE TABLE IF NOT EXISTS business_reviews (
      id TEXT PRIMARY KEY,
      review_json TEXT NOT NULL,
      actionable INTEGER NOT NULL DEFAULT 0 CHECK(actionable IN (0,1)),
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_business_reviews_created
      ON business_reviews(created_at DESC);
  `);
}

export function createBusinessOpportunity(
  db: BetterSqlite3.Database,
  input: BusinessOpportunityInput,
): Record<string, unknown> {
  initializeBusinessIntelligenceSchema(db);

  const title = input.title?.trim();
  const revenueMechanism = input.revenueMechanism?.trim();
  const targetBuyer = input.targetBuyer?.trim();
  if (!title) throw new Error("title is required");
  if (!revenueMechanism) throw new Error("revenueMechanism is required");
  if (!targetBuyer) throw new Error("targetBuyer is required");

  const estimatedRevenueCents = input.estimatedRevenueCents ?? 0;
  const estimatedBuildCostCents = input.estimatedBuildCostCents ?? 0;
  const estimatedRecurringCostCents = input.estimatedRecurringCostCents ?? 0;
  const capitalAtRiskCents = input.capitalAtRiskCents ?? 0;
  const successProbability = input.successProbability ?? 0.25;
  const riskScore = input.riskScore ?? 0.25;
  const timeToRevenueDays = input.timeToRevenueDays ?? 30;
  const learningValue = input.learningValue ?? 0;

  assertCents(estimatedRevenueCents, "estimatedRevenueCents");
  assertCents(estimatedBuildCostCents, "estimatedBuildCostCents");
  assertCents(estimatedRecurringCostCents, "estimatedRecurringCostCents");
  assertCents(capitalAtRiskCents, "capitalAtRiskCents");
  assertUnitInterval(successProbability, "successProbability");
  assertUnitInterval(riskScore, "riskScore");
  assertUnitInterval(learningValue, "learningValue");
  if (!Number.isInteger(timeToRevenueDays) || timeToRevenueDays < 0) {
    throw new Error("timeToRevenueDays must be a non-negative integer");
  }

  const id = ulid();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO business_opportunities (
      id, title, revenue_mechanism, target_buyer, demand_evidence,
      estimated_revenue_cents, estimated_build_cost_cents,
      estimated_recurring_cost_cents, capital_at_risk_cents,
      success_probability, risk_score, time_to_revenue_days, learning_value,
      competition_notes, legal_ethical_notes, source, metadata, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    title,
    revenueMechanism,
    targetBuyer,
    input.demandEvidence?.trim() ?? "",
    estimatedRevenueCents,
    estimatedBuildCostCents,
    estimatedRecurringCostCents,
    capitalAtRiskCents,
    successProbability,
    riskScore,
    timeToRevenueDays,
    learningValue,
    input.competitionNotes?.trim() ?? "",
    input.legalEthicalNotes?.trim() ?? "",
    input.source?.trim() ?? "",
    JSON.stringify(input.metadata ?? {}),
    now,
    now,
  );

  return getBusinessOpportunity(db, id)!;
}

export function getBusinessOpportunity(
  db: BetterSqlite3.Database,
  id: string,
): Record<string, unknown> | undefined {
  initializeBusinessIntelligenceSchema(db);
  const row = db.prepare("SELECT * FROM business_opportunities WHERE id = ?").get(id) as any | undefined;
  return row ? serializeOpportunity(row) : undefined;
}

export function updateBusinessOpportunity(
  db: BetterSqlite3.Database,
  id: string,
  updates: Partial<BusinessOpportunityInput> & { status?: OpportunityStatus },
): Record<string, unknown> {
  initializeBusinessIntelligenceSchema(db);
  const current = db.prepare("SELECT * FROM business_opportunities WHERE id = ?").get(id) as any | undefined;
  if (!current) throw new Error(`Business opportunity not found: ${id}`);

  const status = updates.status ?? current.status;
  if (!VALID_OPPORTUNITY_STATUSES.has(status)) throw new Error(`invalid opportunity status: ${status}`);

  const merged: BusinessOpportunityInput = {
    title: updates.title ?? current.title,
    revenueMechanism: updates.revenueMechanism ?? current.revenue_mechanism,
    targetBuyer: updates.targetBuyer ?? current.target_buyer,
    demandEvidence: updates.demandEvidence ?? current.demand_evidence,
    estimatedRevenueCents: updates.estimatedRevenueCents ?? current.estimated_revenue_cents,
    estimatedBuildCostCents: updates.estimatedBuildCostCents ?? current.estimated_build_cost_cents,
    estimatedRecurringCostCents: updates.estimatedRecurringCostCents ?? current.estimated_recurring_cost_cents,
    capitalAtRiskCents: updates.capitalAtRiskCents ?? current.capital_at_risk_cents,
    successProbability: updates.successProbability ?? current.success_probability,
    riskScore: updates.riskScore ?? current.risk_score,
    timeToRevenueDays: updates.timeToRevenueDays ?? current.time_to_revenue_days,
    learningValue: updates.learningValue ?? current.learning_value,
    competitionNotes: updates.competitionNotes ?? current.competition_notes,
    legalEthicalNotes: updates.legalEthicalNotes ?? current.legal_ethical_notes,
    source: updates.source ?? current.source,
    metadata: updates.metadata ?? safeJson(current.metadata),
  };

  assertCents(merged.estimatedRevenueCents!, "estimatedRevenueCents");
  assertCents(merged.estimatedBuildCostCents!, "estimatedBuildCostCents");
  assertCents(merged.estimatedRecurringCostCents!, "estimatedRecurringCostCents");
  assertCents(merged.capitalAtRiskCents!, "capitalAtRiskCents");
  assertUnitInterval(merged.successProbability!, "successProbability");
  assertUnitInterval(merged.riskScore!, "riskScore");
  assertUnitInterval(merged.learningValue!, "learningValue");
  if (!Number.isInteger(merged.timeToRevenueDays) || merged.timeToRevenueDays! < 0) {
    throw new Error("timeToRevenueDays must be a non-negative integer");
  }

  db.prepare(`
    UPDATE business_opportunities SET
      title = ?, status = ?, revenue_mechanism = ?, target_buyer = ?, demand_evidence = ?,
      estimated_revenue_cents = ?, estimated_build_cost_cents = ?, estimated_recurring_cost_cents = ?,
      capital_at_risk_cents = ?, success_probability = ?, risk_score = ?, time_to_revenue_days = ?,
      learning_value = ?, competition_notes = ?, legal_ethical_notes = ?, source = ?, metadata = ?, updated_at = ?
    WHERE id = ?
  `).run(
    merged.title.trim(), status, merged.revenueMechanism.trim(), merged.targetBuyer.trim(),
    merged.demandEvidence?.trim() ?? "", merged.estimatedRevenueCents,
    merged.estimatedBuildCostCents, merged.estimatedRecurringCostCents,
    merged.capitalAtRiskCents, merged.successProbability, merged.riskScore,
    merged.timeToRevenueDays, merged.learningValue, merged.competitionNotes?.trim() ?? "",
    merged.legalEthicalNotes?.trim() ?? "", merged.source?.trim() ?? "",
    JSON.stringify(merged.metadata ?? {}), new Date().toISOString(), id,
  );

  return getBusinessOpportunity(db, id)!;
}

export function scoreBusinessOpportunity(
  db: BetterSqlite3.Database,
  id: string,
): Record<string, unknown> {
  initializeBusinessIntelligenceSchema(db);
  const row = db.prepare("SELECT * FROM business_opportunities WHERE id = ?").get(id) as any | undefined;
  if (!row) throw new Error(`Business opportunity not found: ${id}`);

  const score = calculateOpportunityScore({
    estimatedRevenueCents: row.estimated_revenue_cents,
    estimatedBuildCostCents: row.estimated_build_cost_cents,
    estimatedRecurringCostCents: row.estimated_recurring_cost_cents,
    capitalAtRiskCents: row.capital_at_risk_cents,
    successProbability: row.success_probability,
    riskScore: row.risk_score,
    timeToRevenueDays: row.time_to_revenue_days,
    learningValue: row.learning_value,
  });

  db.prepare(`
    UPDATE business_opportunities
    SET score_json = ?, priority_value_cents = ?, status = 'scored', updated_at = ?
    WHERE id = ?
  `).run(JSON.stringify(score), score.priorityValueCents, new Date().toISOString(), id);

  return getBusinessOpportunity(db, id)!;
}

export function calculateOpportunityScore(input: {
  estimatedRevenueCents: number;
  estimatedBuildCostCents: number;
  estimatedRecurringCostCents: number;
  capitalAtRiskCents: number;
  successProbability: number;
  riskScore: number;
  timeToRevenueDays: number;
  learningValue: number;
}): OpportunityScore {
  const expectedRevenueCents = input.successProbability * input.estimatedRevenueCents;
  const riskPenaltyCents = input.riskScore * input.capitalAtRiskCents;
  const expectedProfitCents =
    expectedRevenueCents -
    input.estimatedBuildCostCents -
    input.estimatedRecurringCostCents -
    riskPenaltyCents;
  const speedMultiplier = 1 / (1 + input.timeToRevenueDays / 30);
  const learningBonusCents = input.learningValue * 0.1 * Math.max(expectedRevenueCents, 1000);
  const priorityValueCents = expectedProfitCents * speedMultiplier + learningBonusCents;

  return {
    expectedRevenueCents: Math.round(expectedRevenueCents),
    expectedProfitCents: Math.round(expectedProfitCents),
    riskPenaltyCents: Math.round(riskPenaltyCents),
    speedMultiplier,
    learningBonusCents: Math.round(learningBonusCents),
    priorityValueCents: Math.round(priorityValueCents),
  };
}

export function getOpportunityPipeline(
  db: BetterSqlite3.Database,
  status?: OpportunityStatus,
  limit = 20,
): Record<string, unknown>[] {
  initializeBusinessIntelligenceSchema(db);
  if (status && !VALID_OPPORTUNITY_STATUSES.has(status)) throw new Error(`invalid status: ${status}`);
  if (!Number.isInteger(limit) || limit <= 0 || limit > 100) throw new Error("limit must be between 1 and 100");

  const rows = status
    ? db.prepare(`SELECT * FROM business_opportunities WHERE status = ? ORDER BY priority_value_cents DESC, updated_at DESC LIMIT ?`).all(status, limit)
    : db.prepare(`SELECT * FROM business_opportunities ORDER BY CASE WHEN priority_value_cents IS NULL THEN 1 ELSE 0 END, priority_value_cents DESC, updated_at DESC LIMIT ?`).all(limit);
  return (rows as any[]).map(serializeOpportunity);
}

export function convertOpportunityToExperiment(
  db: BetterSqlite3.Database,
  opportunityId: string,
  kind: "paid_work" | "product" | "service" | "trading" | "other",
  budgetCents?: number,
): Record<string, unknown> {
  initializeBusinessIntelligenceSchema(db);
  const opportunity = db.prepare("SELECT * FROM business_opportunities WHERE id = ?").get(opportunityId) as any | undefined;
  if (!opportunity) throw new Error(`Business opportunity not found: ${opportunityId}`);
  if (opportunity.status === "rejected") throw new Error("Rejected opportunity cannot be converted to an experiment");
  if (opportunity.linked_experiment_id) {
    throw new Error(`Opportunity already converted to experiment: ${opportunity.linked_experiment_id}`);
  }

  const experiment = createBusinessExperiment(db, {
    name: opportunity.title,
    kind,
    hypothesis: `Revenue mechanism: ${opportunity.revenue_mechanism}. Target buyer: ${opportunity.target_buyer}. Demand evidence: ${opportunity.demand_evidence}`,
    budgetCents: budgetCents ?? (opportunity.estimated_build_cost_cents + opportunity.estimated_recurring_cost_cents),
    metadata: {
      opportunityId,
      source: opportunity.source,
      legalEthicalNotes: opportunity.legal_ethical_notes,
    },
  });

  db.prepare(`
    UPDATE business_opportunities
    SET status = 'converted', linked_experiment_id = ?, updated_at = ?
    WHERE id = ?
  `).run(experiment.id, new Date().toISOString(), opportunityId);

  return {
    opportunity: getBusinessOpportunity(db, opportunityId),
    experiment,
  };
}

export function generateBusinessReview(db: BetterSqlite3.Database): BusinessReview {
  initializeBusinessIntelligenceSchema(db);
  const portfolio = getBusinessPortfolio(db) as any;
  const experiments = (portfolio.experiments ?? []) as any[];
  const activeExperiments = experiments.filter((e) => !["completed", "killed"].includes(e.status));

  const recommendations = activeExperiments.map((experiment) => {
    const budget = Number(experiment.budgetCents ?? 0);
    const revenue = Number(experiment.revenueCents ?? 0);
    const cost = Number(experiment.costCents ?? 0);
    const profit = Number(experiment.realizedProfitCents ?? 0);
    const roi = typeof experiment.roi === "number" ? experiment.roi : null;
    const budgetUtilization = budget > 0 ? cost / budget : 0;

    let action: BusinessReview["recommendations"][number]["action"] = "continue";
    let reason = "No strong economic signal yet; continue collecting evidence.";

    if (profit > 0 && revenue > 0 && roi !== null && roi >= 0.5 && ["launched", "validating", "scaling"].includes(experiment.status)) {
      action = "consider_scaling";
      reason = `Positive realized profit (${profit}c) with ROI ${(roi * 100).toFixed(1)}%.`;
    } else if (cost > 0 && revenue === 0 && budget > 0 && budgetUtilization >= 0.75) {
      action = "consider_pause";
      reason = `No realized revenue after using ${(budgetUtilization * 100).toFixed(1)}% of experiment budget.`;
    } else if (profit < 0 && budget > 0 && cost > budget) {
      action = "consider_kill";
      reason = `Experiment is loss-making (${profit}c) and has exceeded its budget.`;
    } else if (profit < 0 || budgetUtilization >= 0.5) {
      action = "review";
      reason = `Economics require review: profit ${profit}c, budget utilization ${(budgetUtilization * 100).toFixed(1)}%.`;
    }

    return {
      experimentId: experiment.id,
      experimentName: experiment.name,
      action,
      reason,
    };
  });

  const topOpportunities = getOpportunityPipeline(db, undefined, 5).filter((o: any) =>
    ["scored", "approved"].includes(o.status),
  );
  const actionable = recommendations.some((r) => r.action !== "continue") || topOpportunities.length > 0;
  const totals = portfolio.totals ?? { revenueCents: 0, costCents: 0, realizedProfitCents: 0 };
  const summary = [
    `Portfolio: ${activeExperiments.length} active / ${experiments.length} total experiments.`,
    `Realized revenue ${totals.revenueCents}c, cost ${totals.costCents}c, profit ${totals.realizedProfitCents}c.`,
    `Actionable experiment decisions: ${recommendations.filter((r) => r.action !== "continue").length}.`,
    `Scored/approved opportunities in review set: ${topOpportunities.length}.`,
  ].join(" ");

  const review: BusinessReview = {
    generatedAt: new Date().toISOString(),
    totals,
    experimentCount: experiments.length,
    activeExperimentCount: activeExperiments.length,
    recommendations,
    topOpportunities,
    summary,
    actionable,
  };

  db.prepare(`INSERT INTO business_reviews (id, review_json, actionable, created_at) VALUES (?, ?, ?, ?)`)
    .run(ulid(), JSON.stringify(review), actionable ? 1 : 0, review.generatedAt);

  return review;
}

export function getLatestBusinessReview(db: BetterSqlite3.Database): BusinessReview | undefined {
  initializeBusinessIntelligenceSchema(db);
  const row = db.prepare(`SELECT review_json FROM business_reviews ORDER BY created_at DESC LIMIT 1`).get() as { review_json: string } | undefined;
  if (!row) return undefined;
  return JSON.parse(row.review_json) as BusinessReview;
}

function safeJson(raw: string | undefined): Record<string, unknown> {
  try {
    return JSON.parse(raw ?? "{}");
  } catch {
    return {};
  }
}

function serializeOpportunity(row: any): Record<string, unknown> {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    revenueMechanism: row.revenue_mechanism,
    targetBuyer: row.target_buyer,
    demandEvidence: row.demand_evidence,
    estimatedRevenueCents: row.estimated_revenue_cents,
    estimatedBuildCostCents: row.estimated_build_cost_cents,
    estimatedRecurringCostCents: row.estimated_recurring_cost_cents,
    capitalAtRiskCents: row.capital_at_risk_cents,
    successProbability: row.success_probability,
    riskScore: row.risk_score,
    timeToRevenueDays: row.time_to_revenue_days,
    learningValue: row.learning_value,
    competitionNotes: row.competition_notes,
    legalEthicalNotes: row.legal_ethical_notes,
    source: row.source,
    score: row.score_json ? JSON.parse(row.score_json) : null,
    priorityValueCents: row.priority_value_cents,
    linkedExperimentId: row.linked_experiment_id,
    metadata: safeJson(row.metadata),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
