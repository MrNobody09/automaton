import type { AutomatonTool } from "../types.js";
import {
  convertOpportunityToExperiment,
  createBusinessOpportunity,
  generateBusinessReview,
  getLatestBusinessReview,
  getOpportunityPipeline,
  scoreBusinessOpportunity,
  updateBusinessOpportunity,
} from "./intelligence.js";

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function createBusinessIntelligenceTools(): AutomatonTool[] {
  return [
    {
      name: "create_business_opportunity",
      description:
        "Add a legitimate revenue opportunity to the opportunity pipeline with explicit demand, cost, probability, risk, time-to-revenue, and learning assumptions.",
      category: "financial",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          revenue_mechanism: { type: "string" },
          target_buyer: { type: "string" },
          demand_evidence: { type: "string" },
          estimated_revenue_cents: { type: "number" },
          estimated_build_cost_cents: { type: "number" },
          estimated_recurring_cost_cents: { type: "number" },
          capital_at_risk_cents: { type: "number" },
          success_probability: { type: "number", description: "0.0 to 1.0" },
          risk_score: { type: "number", description: "0.0 to 1.0" },
          time_to_revenue_days: { type: "number" },
          learning_value: { type: "number", description: "0.0 to 1.0" },
          competition_notes: { type: "string" },
          legal_ethical_notes: { type: "string" },
          source: { type: "string" },
        },
        required: ["title", "revenue_mechanism", "target_buyer"],
      },
      execute: async (args, ctx) =>
        json(
          createBusinessOpportunity(ctx.db.raw, {
            title: args.title as string,
            revenueMechanism: args.revenue_mechanism as string,
            targetBuyer: args.target_buyer as string,
            demandEvidence: args.demand_evidence as string | undefined,
            estimatedRevenueCents: args.estimated_revenue_cents as number | undefined,
            estimatedBuildCostCents: args.estimated_build_cost_cents as number | undefined,
            estimatedRecurringCostCents: args.estimated_recurring_cost_cents as number | undefined,
            capitalAtRiskCents: args.capital_at_risk_cents as number | undefined,
            successProbability: args.success_probability as number | undefined,
            riskScore: args.risk_score as number | undefined,
            timeToRevenueDays: args.time_to_revenue_days as number | undefined,
            learningValue: args.learning_value as number | undefined,
            competitionNotes: args.competition_notes as string | undefined,
            legalEthicalNotes: args.legal_ethical_notes as string | undefined,
            source: args.source as string | undefined,
          }),
        ),
    },
    {
      name: "update_business_opportunity",
      description:
        "Update opportunity evidence or assumptions as research produces better information. Use this before rescoring when inputs change.",
      category: "financial",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          opportunity_id: { type: "string" },
          status: { type: "string", enum: ["discovered", "researching", "scored", "approved", "rejected", "converted"] },
          demand_evidence: { type: "string" },
          estimated_revenue_cents: { type: "number" },
          estimated_build_cost_cents: { type: "number" },
          estimated_recurring_cost_cents: { type: "number" },
          capital_at_risk_cents: { type: "number" },
          success_probability: { type: "number" },
          risk_score: { type: "number" },
          time_to_revenue_days: { type: "number" },
          learning_value: { type: "number" },
          competition_notes: { type: "string" },
          legal_ethical_notes: { type: "string" },
        },
        required: ["opportunity_id"],
      },
      execute: async (args, ctx) =>
        json(
          updateBusinessOpportunity(ctx.db.raw, args.opportunity_id as string, {
            status: args.status as any,
            demandEvidence: args.demand_evidence as string | undefined,
            estimatedRevenueCents: args.estimated_revenue_cents as number | undefined,
            estimatedBuildCostCents: args.estimated_build_cost_cents as number | undefined,
            estimatedRecurringCostCents: args.estimated_recurring_cost_cents as number | undefined,
            capitalAtRiskCents: args.capital_at_risk_cents as number | undefined,
            successProbability: args.success_probability as number | undefined,
            riskScore: args.risk_score as number | undefined,
            timeToRevenueDays: args.time_to_revenue_days as number | undefined,
            learningValue: args.learning_value as number | undefined,
            competitionNotes: args.competition_notes as string | undefined,
            legalEthicalNotes: args.legal_ethical_notes as string | undefined,
          }),
        ),
    },
    {
      name: "score_business_opportunity",
      description:
        "Calculate an auditable expected-value score from the opportunity's explicit assumptions. The score is evidence for prioritization, not permission to bypass policy or ethics.",
      category: "financial",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: { opportunity_id: { type: "string" } },
        required: ["opportunity_id"],
      },
      execute: async (args, ctx) =>
        json(scoreBusinessOpportunity(ctx.db.raw, args.opportunity_id as string)),
    },
    {
      name: "get_opportunity_pipeline",
      description:
        "List business opportunities ordered by economic priority, including assumptions, scores, status, and links to experiments.",
      category: "financial",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string" },
          limit: { type: "number", description: "1 to 100, default 20" },
        },
      },
      execute: async (args, ctx) =>
        json(getOpportunityPipeline(ctx.db.raw, args.status as any, (args.limit as number | undefined) ?? 20)),
    },
    {
      name: "convert_opportunity_to_experiment",
      description:
        "Convert a researched opportunity into a tracked business experiment. Conversion does not authorize unethical or otherwise policy-denied execution.",
      category: "financial",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          opportunity_id: { type: "string" },
          kind: { type: "string", enum: ["paid_work", "product", "service", "trading", "other"] },
          budget_cents: { type: "number" },
        },
        required: ["opportunity_id", "kind"],
      },
      execute: async (args, ctx) =>
        json(
          convertOpportunityToExperiment(
            ctx.db.raw,
            args.opportunity_id as string,
            args.kind as any,
            args.budget_cents as number | undefined,
          ),
        ),
    },
    {
      name: "run_business_review",
      description:
        "Generate a portfolio review with realized economics, experiment-level decision signals, and top scored opportunities. Recommendations are advisory and remain subject to policy rules.",
      category: "financial",
      riskLevel: "safe",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => json(generateBusinessReview(ctx.db.raw)),
    },
    {
      name: "get_latest_business_review",
      description: "Retrieve the most recent persisted business review.",
      category: "financial",
      riskLevel: "safe",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => json(getLatestBusinessReview(ctx.db.raw) ?? { message: "No business review has been generated yet." }),
    },
  ];
}
