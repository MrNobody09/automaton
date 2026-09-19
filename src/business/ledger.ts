import type BetterSqlite3 from "better-sqlite3";
import { ulid } from "ulid";

export type BusinessExperimentKind =
  | "paid_work"
  | "product"
  | "service"
  | "trading"
  | "other";

export type BusinessExperimentStatus =
  | "researching"
  | "building"
  | "launched"
  | "validating"
  | "scaling"
  | "paused"
  | "completed"
  | "killed";

export interface BusinessExperimentInput {
  name: string;
  kind: BusinessExperimentKind;
  hypothesis?: string;
  budgetCents?: number;
  owner?: string;
  metadata?: Record<string, unknown>;
}

export interface BusinessEventInput {
  experimentId: string;
  amountCents: number;
  category: string;
  description?: string;
  externalRef?: string;
  occurredAt?: string;
}

export interface TradingStrategyInput {
  experimentId: string;
  name: string;
  venue: string;
  mode?: "paper" | "live";
  allocatedCapitalCents: number;
  maxPositionCents: number;
  dailyLossLimitCents: number;
  maxDrawdownBps: number;
  leverageEnabled?: boolean;
}

const VALID_KINDS = new Set<BusinessExperimentKind>([
  "paid_work",
  "product",
  "service",
  "trading",
  "other",
]);

const VALID_STATUSES = new Set<BusinessExperimentStatus>([
  "researching",
  "building",
  "launched",
  "validating",
  "scaling",
  "paused",
  "completed",
  "killed",
]);

export function initializeBusinessSchema(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS business_experiments (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('paid_work','product','service','trading','other')),
      hypothesis TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'researching'
        CHECK(status IN ('researching','building','launched','validating','scaling','paused','completed','killed')),
      budget_cents INTEGER NOT NULL DEFAULT 0 CHECK(budget_cents >= 0),
      owner TEXT NOT NULL DEFAULT 'parent',
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      closed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_business_experiments_status
      ON business_experiments(status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_business_experiments_kind
      ON business_experiments(kind, updated_at);

    CREATE TABLE IF NOT EXISTS business_events (
      id TEXT PRIMARY KEY,
      experiment_id TEXT NOT NULL REFERENCES business_experiments(id),
      event_type TEXT NOT NULL CHECK(event_type IN ('revenue','cost')),
      amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
      category TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      external_ref TEXT,
      realized INTEGER NOT NULL DEFAULT 1 CHECK(realized IN (0,1)),
      occurred_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_business_events_experiment
      ON business_events(experiment_id, occurred_at);
    CREATE INDEX IF NOT EXISTS idx_business_events_type
      ON business_events(event_type, occurred_at);

    CREATE TABLE IF NOT EXISTS strategy_allocations (
      strategy_key TEXT PRIMARY KEY,
      experiment_id TEXT REFERENCES business_experiments(id),
      allocation_cents INTEGER NOT NULL DEFAULT 0 CHECK(allocation_cents >= 0),
      notes TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS trading_strategies (
      id TEXT PRIMARY KEY,
      experiment_id TEXT NOT NULL UNIQUE REFERENCES business_experiments(id),
      name TEXT NOT NULL,
      venue TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'paper' CHECK(mode IN ('paper','live')),
      allocated_capital_cents INTEGER NOT NULL CHECK(allocated_capital_cents >= 0),
      max_position_cents INTEGER NOT NULL CHECK(max_position_cents >= 0),
      daily_loss_limit_cents INTEGER NOT NULL CHECK(daily_loss_limit_cents >= 0),
      max_drawdown_bps INTEGER NOT NULL CHECK(max_drawdown_bps >= 0 AND max_drawdown_bps <= 10000),
      leverage_enabled INTEGER NOT NULL DEFAULT 0 CHECK(leverage_enabled IN (0,1)),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','stopped')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS trading_trades (
      id TEXT PRIMARY KEY,
      strategy_id TEXT NOT NULL REFERENCES trading_strategies(id),
      symbol TEXT NOT NULL,
      side TEXT NOT NULL CHECK(side IN ('buy','sell')),
      quantity REAL NOT NULL CHECK(quantity > 0),
      price REAL NOT NULL CHECK(price > 0),
      fees_cents INTEGER NOT NULL DEFAULT 0 CHECK(fees_cents >= 0),
      slippage_cents INTEGER NOT NULL DEFAULT 0 CHECK(slippage_cents >= 0),
      realized_pnl_cents INTEGER NOT NULL DEFAULT 0,
      external_ref TEXT,
      executed_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_trading_trades_strategy
      ON trading_trades(strategy_id, executed_at);
  `);
}

function requirePositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer number of cents`);
  }
}

function requireNonNegativeInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
}

function assertExperimentExists(db: BetterSqlite3.Database, id: string): void {
  const row = db.prepare("SELECT id FROM business_experiments WHERE id = ?").get(id);
  if (!row) throw new Error(`Business experiment not found: ${id}`);
}

export function createBusinessExperiment(
  db: BetterSqlite3.Database,
  input: BusinessExperimentInput,
): Record<string, unknown> {
  initializeBusinessSchema(db);
  const name = input.name?.trim();
  if (!name) throw new Error("name is required");
  if (!VALID_KINDS.has(input.kind)) throw new Error(`invalid experiment kind: ${input.kind}`);

  const budgetCents = input.budgetCents ?? 0;
  requireNonNegativeInteger(budgetCents, "budgetCents");

  const id = ulid();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO business_experiments
      (id, name, kind, hypothesis, status, budget_cents, owner, metadata, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'researching', ?, ?, ?, ?, ?)
  `).run(
    id,
    name,
    input.kind,
    input.hypothesis?.trim() ?? "",
    budgetCents,
    input.owner?.trim() || "parent",
    JSON.stringify(input.metadata ?? {}),
    now,
    now,
  );

  return getBusinessExperiment(db, id)!;
}

export function getBusinessExperiment(
  db: BetterSqlite3.Database,
  id: string,
): Record<string, unknown> | undefined {
  initializeBusinessSchema(db);
  const row = db.prepare(`
    SELECT
      e.*,
      COALESCE(SUM(CASE WHEN ev.event_type = 'revenue' AND ev.realized = 1 THEN ev.amount_cents ELSE 0 END), 0) AS revenue_cents,
      COALESCE(SUM(CASE WHEN ev.event_type = 'cost' AND ev.realized = 1 THEN ev.amount_cents ELSE 0 END), 0) AS cost_cents
    FROM business_experiments e
    LEFT JOIN business_events ev ON ev.experiment_id = e.id
    WHERE e.id = ?
    GROUP BY e.id
  `).get(id) as any | undefined;

  if (!row) return undefined;
  return serializeExperimentRow(row);
}

export function updateBusinessExperiment(
  db: BetterSqlite3.Database,
  id: string,
  updates: {
    status?: BusinessExperimentStatus;
    budgetCents?: number;
    hypothesis?: string;
    metadata?: Record<string, unknown>;
  },
): Record<string, unknown> {
  initializeBusinessSchema(db);
  assertExperimentExists(db, id);

  if (updates.status && !VALID_STATUSES.has(updates.status)) {
    throw new Error(`invalid experiment status: ${updates.status}`);
  }
  if (updates.budgetCents !== undefined) {
    requireNonNegativeInteger(updates.budgetCents, "budgetCents");
  }

  const existing = db.prepare("SELECT * FROM business_experiments WHERE id = ?").get(id) as any;
  const status = updates.status ?? existing.status;
  const budgetCents = updates.budgetCents ?? existing.budget_cents;
  const hypothesis = updates.hypothesis ?? existing.hypothesis;
  const metadata = updates.metadata ? JSON.stringify(updates.metadata) : existing.metadata;
  const now = new Date().toISOString();
  const closedAt = ["completed", "killed"].includes(status) ? (existing.closed_at ?? now) : null;

  db.prepare(`
    UPDATE business_experiments
    SET status = ?, budget_cents = ?, hypothesis = ?, metadata = ?, updated_at = ?, closed_at = ?
    WHERE id = ?
  `).run(status, budgetCents, hypothesis, metadata, now, closedAt, id);

  return getBusinessExperiment(db, id)!;
}

function recordBusinessEvent(
  db: BetterSqlite3.Database,
  eventType: "revenue" | "cost",
  input: BusinessEventInput,
): Record<string, unknown> {
  initializeBusinessSchema(db);
  assertExperimentExists(db, input.experimentId);
  requirePositiveInteger(input.amountCents, "amountCents");
  const category = input.category?.trim();
  if (!category) throw new Error("category is required");

  const id = ulid();
  const now = new Date().toISOString();
  const occurredAt = input.occurredAt ?? now;

  db.prepare(`
    INSERT INTO business_events
      (id, experiment_id, event_type, amount_cents, category, description, external_ref, realized, occurred_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(
    id,
    input.experimentId,
    eventType,
    input.amountCents,
    category,
    input.description?.trim() ?? "",
    input.externalRef?.trim() || null,
    occurredAt,
    now,
  );

  return {
    id,
    experimentId: input.experimentId,
    eventType,
    amountCents: input.amountCents,
    category,
    description: input.description?.trim() ?? "",
    externalRef: input.externalRef?.trim() || null,
    occurredAt,
  };
}

export function recordBusinessRevenue(db: BetterSqlite3.Database, input: BusinessEventInput) {
  return recordBusinessEvent(db, "revenue", input);
}

export function recordBusinessCost(db: BetterSqlite3.Database, input: BusinessEventInput) {
  return recordBusinessEvent(db, "cost", input);
}

export function getBusinessPortfolio(
  db: BetterSqlite3.Database,
  status?: BusinessExperimentStatus,
): Record<string, unknown> {
  initializeBusinessSchema(db);
  if (status && !VALID_STATUSES.has(status)) throw new Error(`invalid status: ${status}`);

  const where = status ? "WHERE e.status = ?" : "";
  const rows = db.prepare(`
    SELECT
      e.*,
      COALESCE(SUM(CASE WHEN ev.event_type = 'revenue' AND ev.realized = 1 THEN ev.amount_cents ELSE 0 END), 0) AS revenue_cents,
      COALESCE(SUM(CASE WHEN ev.event_type = 'cost' AND ev.realized = 1 THEN ev.amount_cents ELSE 0 END), 0) AS cost_cents
    FROM business_experiments e
    LEFT JOIN business_events ev ON ev.experiment_id = e.id
    ${where}
    GROUP BY e.id
    ORDER BY e.updated_at DESC
  `).all(...(status ? [status] : [])) as any[];

  const experiments = rows.map(serializeExperimentRow);
  const totals = rows.reduce(
    (acc, row) => {
      acc.revenueCents += Number(row.revenue_cents ?? 0);
      acc.costCents += Number(row.cost_cents ?? 0);
      return acc;
    },
    { revenueCents: 0, costCents: 0 },
  );

  return {
    totals: {
      ...totals,
      realizedProfitCents: totals.revenueCents - totals.costCents,
    },
    experimentCount: experiments.length,
    experiments,
  };
}

export function closeBusinessExperiment(
  db: BetterSqlite3.Database,
  id: string,
  outcome: "completed" | "killed" | "paused",
  reason?: string,
): Record<string, unknown> {
  const experiment = updateBusinessExperiment(db, id, { status: outcome });
  if (reason?.trim()) {
    const existingMetadata = (experiment.metadata as Record<string, unknown>) ?? {};
    return updateBusinessExperiment(db, id, {
      metadata: {
        ...existingMetadata,
        closeReason: reason.trim(),
        closeReasonRecordedAt: new Date().toISOString(),
      },
    });
  }
  return experiment;
}

export function configureTradingStrategy(
  db: BetterSqlite3.Database,
  input: TradingStrategyInput,
): Record<string, unknown> {
  initializeBusinessSchema(db);
  assertExperimentExists(db, input.experimentId);
  const experiment = db.prepare("SELECT kind FROM business_experiments WHERE id = ?").get(input.experimentId) as { kind: string };
  if (experiment.kind !== "trading") throw new Error("trading strategies must belong to an experiment with kind='trading'");

  requireNonNegativeInteger(input.allocatedCapitalCents, "allocatedCapitalCents");
  requireNonNegativeInteger(input.maxPositionCents, "maxPositionCents");
  requireNonNegativeInteger(input.dailyLossLimitCents, "dailyLossLimitCents");
  requireNonNegativeInteger(input.maxDrawdownBps, "maxDrawdownBps");
  if (input.maxDrawdownBps > 10000) throw new Error("maxDrawdownBps cannot exceed 10000");
  if (input.maxPositionCents > input.allocatedCapitalCents) {
    throw new Error("maxPositionCents cannot exceed allocatedCapitalCents");
  }
  if (input.dailyLossLimitCents > input.allocatedCapitalCents) {
    throw new Error("dailyLossLimitCents cannot exceed allocatedCapitalCents");
  }

  const existing = db.prepare("SELECT id, created_at FROM trading_strategies WHERE experiment_id = ?").get(input.experimentId) as any | undefined;
  const id = existing?.id ?? ulid();
  const now = new Date().toISOString();
  const mode = input.mode ?? "paper";
  if (!new Set(["paper", "live"]).has(mode)) throw new Error(`invalid trading mode: ${mode}`);

  db.prepare(`
    INSERT INTO trading_strategies
      (id, experiment_id, name, venue, mode, allocated_capital_cents, max_position_cents,
       daily_loss_limit_cents, max_drawdown_bps, leverage_enabled, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
    ON CONFLICT(experiment_id) DO UPDATE SET
      name = excluded.name,
      venue = excluded.venue,
      mode = excluded.mode,
      allocated_capital_cents = excluded.allocated_capital_cents,
      max_position_cents = excluded.max_position_cents,
      daily_loss_limit_cents = excluded.daily_loss_limit_cents,
      max_drawdown_bps = excluded.max_drawdown_bps,
      leverage_enabled = excluded.leverage_enabled,
      updated_at = excluded.updated_at
  `).run(
    id,
    input.experimentId,
    input.name.trim(),
    input.venue.trim(),
    mode,
    input.allocatedCapitalCents,
    input.maxPositionCents,
    input.dailyLossLimitCents,
    input.maxDrawdownBps,
    input.leverageEnabled ? 1 : 0,
    existing?.created_at ?? now,
    now,
  );

  return getTradingRisk(db, id);
}

export function getTradingRisk(
  db: BetterSqlite3.Database,
  strategyId: string,
): Record<string, unknown> {
  initializeBusinessSchema(db);
  const strategy = db.prepare("SELECT * FROM trading_strategies WHERE id = ?").get(strategyId) as any | undefined;
  if (!strategy) throw new Error(`Trading strategy not found: ${strategyId}`);

  const pnl = db.prepare(`
    SELECT
      COALESCE(SUM(realized_pnl_cents), 0) AS realized_pnl_cents,
      COALESCE(SUM(fees_cents), 0) AS fees_cents,
      COALESCE(SUM(slippage_cents), 0) AS slippage_cents,
      COUNT(*) AS trade_count
    FROM trading_trades
    WHERE strategy_id = ?
  `).get(strategyId) as any;

  return {
    id: strategy.id,
    experimentId: strategy.experiment_id,
    name: strategy.name,
    venue: strategy.venue,
    mode: strategy.mode,
    allocatedCapitalCents: strategy.allocated_capital_cents,
    maxPositionCents: strategy.max_position_cents,
    dailyLossLimitCents: strategy.daily_loss_limit_cents,
    maxDrawdownBps: strategy.max_drawdown_bps,
    leverageEnabled: Boolean(strategy.leverage_enabled),
    status: strategy.status,
    realizedPnlCents: Number(pnl.realized_pnl_cents ?? 0),
    feesCents: Number(pnl.fees_cents ?? 0),
    slippageCents: Number(pnl.slippage_cents ?? 0),
    tradeCount: Number(pnl.trade_count ?? 0),
  };
}

function serializeExperimentRow(row: any): Record<string, unknown> {
  const revenueCents = Number(row.revenue_cents ?? 0);
  const costCents = Number(row.cost_cents ?? 0);
  const realizedProfitCents = revenueCents - costCents;
  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(row.metadata ?? "{}");
  } catch {
    metadata = {};
  }

  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    hypothesis: row.hypothesis,
    status: row.status,
    budgetCents: row.budget_cents,
    owner: row.owner,
    metadata,
    revenueCents,
    costCents,
    realizedProfitCents,
    roi: costCents > 0 ? realizedProfitCents / costCents : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
  };
}
