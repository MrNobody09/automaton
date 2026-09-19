#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  convertOpportunityToExperiment,
  createBusinessOpportunity,
  generateBusinessReview,
  getLatestBusinessReview,
  getOpportunityPipeline,
  initializeBusinessIntelligenceSchema,
  scoreBusinessOpportunity,
  updateBusinessOpportunity,
} from "./intelligence.js";

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function parseArgs(raw?: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid tool arguments JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`);
  return value;
}

const toolName = process.argv[2];
const args = parseArgs(process.argv[3]);
const dbPath = expandHome(process.env.AUTOMATON_DB_PATH || "~/.automaton/state.db");
const db = new Database(dbPath);
db.pragma("foreign_keys = ON");
initializeBusinessIntelligenceSchema(db);

try {
  let result: unknown;
  switch (toolName) {
    case "create_business_opportunity":
      result = createBusinessOpportunity(db, {
        title: requireString(args, "title"),
        revenueMechanism: requireString(args, "revenue_mechanism"),
        targetBuyer: requireString(args, "target_buyer"),
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
      });
      break;
    case "update_business_opportunity":
      result = updateBusinessOpportunity(db, requireString(args, "opportunity_id"), {
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
      });
      break;
    case "score_business_opportunity":
      result = scoreBusinessOpportunity(db, requireString(args, "opportunity_id"));
      break;
    case "get_opportunity_pipeline":
      result = getOpportunityPipeline(db, args.status as any, (args.limit as number | undefined) ?? 20);
      break;
    case "convert_opportunity_to_experiment":
      result = convertOpportunityToExperiment(
        db,
        requireString(args, "opportunity_id"),
        requireString(args, "kind") as any,
        args.budget_cents as number | undefined,
      );
      break;
    case "run_business_review":
      result = generateBusinessReview(db);
      break;
    case "get_latest_business_review":
      result = getLatestBusinessReview(db) ?? { message: "No business review has been generated yet." };
      break;
    default:
      throw new Error(`Unknown business intelligence tool: ${toolName}`);
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  db.close();
}
