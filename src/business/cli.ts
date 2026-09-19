#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
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
  updateBusinessExperiment,
} from "./ledger.js";

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

function requireNumber(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${key} must be a number`);
  return value;
}

const toolName = process.argv[2];
const args = parseArgs(process.argv[3]);
const dbPath = expandHome(process.env.AUTOMATON_DB_PATH || "~/.automaton/state.db");
const db = new Database(dbPath);
db.pragma("foreign_keys = ON");
initializeBusinessSchema(db);

try {
  let result: unknown;
  switch (toolName) {
    case "create_business_experiment":
      result = createBusinessExperiment(db, {
        name: requireString(args, "name"),
        kind: requireString(args, "kind") as any,
        hypothesis: args.hypothesis as string | undefined,
        budgetCents: args.budget_cents as number | undefined,
        owner: args.owner as string | undefined,
      });
      break;
    case "update_business_experiment":
      result = updateBusinessExperiment(db, requireString(args, "experiment_id"), {
        status: args.status as any,
        budgetCents: args.budget_cents as number | undefined,
        hypothesis: args.hypothesis as string | undefined,
      });
      break;
    case "record_business_revenue":
      result = recordBusinessRevenue(db, {
        experimentId: requireString(args, "experiment_id"),
        amountCents: requireNumber(args, "amount_cents"),
        category: requireString(args, "category"),
        description: args.description as string | undefined,
        externalRef: args.external_ref as string | undefined,
      });
      break;
    case "record_business_cost":
      result = recordBusinessCost(db, {
        experimentId: requireString(args, "experiment_id"),
        amountCents: requireNumber(args, "amount_cents"),
        category: requireString(args, "category"),
        description: args.description as string | undefined,
        externalRef: args.external_ref as string | undefined,
      });
      break;
    case "get_business_portfolio":
      result = getBusinessPortfolio(db, args.status as any);
      break;
    case "close_business_experiment":
      result = closeBusinessExperiment(
        db,
        requireString(args, "experiment_id"),
        requireString(args, "outcome") as any,
        args.reason as string | undefined,
      );
      break;
    case "configure_trading_strategy":
      result = configureTradingStrategy(db, {
        experimentId: requireString(args, "experiment_id"),
        name: requireString(args, "name"),
        venue: requireString(args, "venue"),
        mode: args.mode as any,
        allocatedCapitalCents: requireNumber(args, "allocated_capital_cents"),
        maxPositionCents: requireNumber(args, "max_position_cents"),
        dailyLossLimitCents: requireNumber(args, "daily_loss_limit_cents"),
        maxDrawdownBps: requireNumber(args, "max_drawdown_bps"),
        leverageEnabled: args.leverage_enabled as boolean | undefined,
      });
      break;
    case "get_trading_risk":
      result = getTradingRisk(db, requireString(args, "strategy_id"));
      break;
    default:
      throw new Error(`Unknown business tool: ${toolName}`);
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  db.close();
}
