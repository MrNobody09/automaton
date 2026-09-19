import type { AutomatonTool } from "../types.js";
import {
  closeBusinessExperiment,
  configureTradingStrategy,
  createBusinessExperiment,
  getBusinessPortfolio,
  getTradingRisk,
  recordBusinessCost,
  recordBusinessRevenue,
  updateBusinessExperiment,
} from "./ledger.js";

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function createBusinessTools(): AutomatonTool[] {
  return [
    {
      name: "create_business_experiment",
      description:
        "Create a revenue experiment for paid work, a product, service, trading strategy, or another legitimate business idea. Track all business activity through experiments so profitability can be measured.",
      category: "financial",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short experiment name" },
          kind: {
            type: "string",
            enum: ["paid_work", "product", "service", "trading", "other"],
          },
          hypothesis: {
            type: "string",
            description: "Why this experiment is expected to make money",
          },
          budget_cents: {
            type: "number",
            description: "Maximum planned experiment budget in cents",
          },
          owner: { type: "string", description: "Owning agent/role (optional)" },
        },
        required: ["name", "kind"],
      },
      execute: async (args, ctx) =>
        json(
          createBusinessExperiment(ctx.db.raw, {
            name: args.name as string,
            kind: args.kind as any,
            hypothesis: args.hypothesis as string | undefined,
            budgetCents: args.budget_cents as number | undefined,
            owner: args.owner as string | undefined,
          }),
        ),
    },
    {
      name: "update_business_experiment",
      description:
        "Update an experiment's lifecycle status, hypothesis, or budget as evidence changes.",
      category: "financial",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          experiment_id: { type: "string" },
          status: {
            type: "string",
            enum: [
              "researching",
              "building",
              "launched",
              "validating",
              "scaling",
              "paused",
              "completed",
              "killed",
            ],
          },
          budget_cents: { type: "number" },
          hypothesis: { type: "string" },
        },
        required: ["experiment_id"],
      },
      execute: async (args, ctx) =>
        json(
          updateBusinessExperiment(ctx.db.raw, args.experiment_id as string, {
            status: args.status as any,
            budgetCents: args.budget_cents as number | undefined,
            hypothesis: args.hypothesis as string | undefined,
          }),
        ),
    },
    {
      name: "record_business_revenue",
      description:
        "Record realized revenue actually received for a business experiment. Do not record projected, quoted, or unrealized revenue here.",
      category: "financial",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          experiment_id: { type: "string" },
          amount_cents: { type: "number" },
          category: { type: "string" },
          description: { type: "string" },
          external_ref: { type: "string" },
        },
        required: ["experiment_id", "amount_cents", "category"],
      },
      execute: async (args, ctx) =>
        json(
          recordBusinessRevenue(ctx.db.raw, {
            experimentId: args.experiment_id as string,
            amountCents: args.amount_cents as number,
            category: args.category as string,
            description: args.description as string | undefined,
            externalRef: args.external_ref as string | undefined,
          }),
        ),
    },
    {
      name: "record_business_cost",
      description:
        "Record a realized business cost attributable to an experiment, including inference, hosting, API usage, fees, slippage, labor marketplace fees, or other direct costs.",
      category: "financial",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          experiment_id: { type: "string" },
          amount_cents: { type: "number" },
          category: { type: "string" },
          description: { type: "string" },
          external_ref: { type: "string" },
        },
        required: ["experiment_id", "amount_cents", "category"],
      },
      execute: async (args, ctx) =>
        json(
          recordBusinessCost(ctx.db.raw, {
            experimentId: args.experiment_id as string,
            amountCents: args.amount_cents as number,
            category: args.category as string,
            description: args.description as string | undefined,
            externalRef: args.external_ref as string | undefined,
          }),
        ),
    },
    {
      name: "get_business_portfolio",
      description:
        "Get experiment-level and portfolio-level realized revenue, costs, profit, ROI, status, and budgets. Use this before allocating more capital or deciding what to scale or kill.",
      category: "financial",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          status: {
            type: "string",
            description: "Optional lifecycle status filter",
          },
        },
      },
      execute: async (args, ctx) =>
        json(getBusinessPortfolio(ctx.db.raw, args.status as any)),
    },
    {
      name: "close_business_experiment",
      description:
        "Conclude an experiment as completed, killed, or paused. Use evidence rather than sunk-cost reasoning.",
      category: "financial",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          experiment_id: { type: "string" },
          outcome: {
            type: "string",
            enum: ["completed", "killed", "paused"],
          },
          reason: { type: "string" },
        },
        required: ["experiment_id", "outcome"],
      },
      execute: async (args, ctx) =>
        json(
          closeBusinessExperiment(
            ctx.db.raw,
            args.experiment_id as string,
            args.outcome as any,
            args.reason as string | undefined,
          ),
        ),
    },
    {
      name: "configure_trading_strategy",
      description:
        "Configure the accounting and risk envelope for a trading experiment. This does not place trades. Paper mode is the default. Live execution requires a separately configured authorized venue adapter.",
      category: "financial",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          experiment_id: { type: "string" },
          name: { type: "string" },
          venue: { type: "string" },
          mode: { type: "string", enum: ["paper", "live"] },
          allocated_capital_cents: { type: "number" },
          max_position_cents: { type: "number" },
          daily_loss_limit_cents: { type: "number" },
          max_drawdown_bps: { type: "number" },
          leverage_enabled: { type: "boolean" },
        },
        required: [
          "experiment_id",
          "name",
          "venue",
          "allocated_capital_cents",
          "max_position_cents",
          "daily_loss_limit_cents",
          "max_drawdown_bps",
        ],
      },
      execute: async (args, ctx) =>
        json(
          configureTradingStrategy(ctx.db.raw, {
            experimentId: args.experiment_id as string,
            name: args.name as string,
            venue: args.venue as string,
            mode: args.mode as any,
            allocatedCapitalCents: args.allocated_capital_cents as number,
            maxPositionCents: args.max_position_cents as number,
            dailyLossLimitCents: args.daily_loss_limit_cents as number,
            maxDrawdownBps: args.max_drawdown_bps as number,
            leverageEnabled: args.leverage_enabled as boolean | undefined,
          }),
        ),
    },
    {
      name: "get_trading_risk",
      description:
        "Inspect a configured trading strategy's risk envelope, realized P&L, fees, slippage, and trade count.",
      category: "financial",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          strategy_id: { type: "string" },
        },
        required: ["strategy_id"],
      },
      execute: async (args, ctx) =>
        json(getTradingRisk(ctx.db.raw, args.strategy_id as string)),
    },
  ];
}
