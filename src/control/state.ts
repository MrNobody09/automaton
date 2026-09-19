import type Database from "better-sqlite3";
import { ulid } from "ulid";

export interface OwnerControlFlags {
  autonomyPaused: boolean;
  spendingPaused: boolean;
  tradingPaused: boolean;
  childCreationPaused: boolean;
}

export interface OwnerMessage {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "processed" | "failed";
  createdAt: string;
  claimedAt?: string;
  processedAt?: string;
  error?: string;
}

export const CONTROL_KV_KEYS = {
  autonomyPaused: "owner_control.autonomy_paused",
  spendingPaused: "owner_control.spending_paused",
  tradingPaused: "owner_control.trading_paused",
  childCreationPaused: "owner_control.child_creation_paused",
} as const;

function boolFromKv(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

function getKv(db: Database.Database, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

function setKv(db: Database.Database, key: string, value: string): void {
  db.prepare(
    "INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))",
  ).run(key, value);
}

export function initializeOwnerControlSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS owner_messages (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','in_progress','processed','failed')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      claimed_at TEXT,
      processed_at TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_owner_messages_pending
      ON owner_messages(created_at) WHERE status = 'pending';

    CREATE TABLE IF NOT EXISTS owner_control_audit (
      id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_owner_control_audit_created
      ON owner_control_audit(created_at);
  `);
}

export function getOwnerControlFlags(db: Database.Database): OwnerControlFlags {
  return {
    autonomyPaused: boolFromKv(getKv(db, CONTROL_KV_KEYS.autonomyPaused)),
    spendingPaused: boolFromKv(getKv(db, CONTROL_KV_KEYS.spendingPaused)),
    tradingPaused: boolFromKv(getKv(db, CONTROL_KV_KEYS.tradingPaused)),
    childCreationPaused: boolFromKv(getKv(db, CONTROL_KV_KEYS.childCreationPaused)),
  };
}

export function isAutonomyPaused(db: Database.Database): boolean {
  return boolFromKv(getKv(db, CONTROL_KV_KEYS.autonomyPaused));
}

export function isSpendingPaused(db: Database.Database): boolean {
  return boolFromKv(getKv(db, CONTROL_KV_KEYS.spendingPaused));
}

export function isTradingPaused(db: Database.Database): boolean {
  return boolFromKv(getKv(db, CONTROL_KV_KEYS.tradingPaused));
}

export function isChildCreationPaused(db: Database.Database): boolean {
  return boolFromKv(getKv(db, CONTROL_KV_KEYS.childCreationPaused));
}

export function updateOwnerControlFlags(
  db: Database.Database,
  patch: Partial<OwnerControlFlags>,
): OwnerControlFlags {
  initializeOwnerControlSchema(db);
  const allowed = new Set<keyof OwnerControlFlags>([
    "autonomyPaused",
    "spendingPaused",
    "tradingPaused",
    "childCreationPaused",
  ]);

  const tx = db.transaction(() => {
    for (const [key, value] of Object.entries(patch)) {
      if (!allowed.has(key as keyof OwnerControlFlags)) continue;
      if (typeof value !== "boolean") {
        throw new Error(`${key} must be boolean`);
      }
      const kvKey = CONTROL_KV_KEYS[key as keyof OwnerControlFlags];
      setKv(db, kvKey, value ? "1" : "0");
    }

    const flags = getOwnerControlFlags(db);
    db.prepare(
      "INSERT INTO owner_control_audit (id, action, detail) VALUES (?, ?, ?)",
    ).run(ulid(), "update_controls", JSON.stringify({ patch, flags }));
    return flags;
  });

  return tx();
}

export function enqueueOwnerMessage(db: Database.Database, content: string): OwnerMessage {
  initializeOwnerControlSchema(db);
  const normalized = content.trim();
  if (!normalized) throw new Error("Owner message cannot be empty");
  if (normalized.length > 20_000) throw new Error("Owner message exceeds 20,000 characters");

  const message: OwnerMessage = {
    id: ulid(),
    content: normalized,
    status: "pending",
    createdAt: new Date().toISOString(),
  };

  db.prepare(
    `INSERT INTO owner_messages (id, content, status, created_at)
     VALUES (?, ?, 'pending', ?)`,
  ).run(message.id, message.content, message.createdAt);

  db.prepare(
    "INSERT INTO owner_control_audit (id, action, detail) VALUES (?, ?, ?)",
  ).run(ulid(), "owner_message_enqueued", JSON.stringify({ messageId: message.id }));

  return message;
}

export function claimNextOwnerMessage(db: Database.Database): OwnerMessage | undefined {
  initializeOwnerControlSchema(db);

  const tx = db.transaction(() => {
    const row = db.prepare(
      `SELECT id, content, status, created_at, claimed_at, processed_at, error
       FROM owner_messages
       WHERE status = 'pending'
       ORDER BY created_at ASC
       LIMIT 1`,
    ).get() as any | undefined;

    if (!row) return undefined;

    const claimedAt = new Date().toISOString();
    const updated = db.prepare(
      `UPDATE owner_messages
       SET status = 'in_progress', claimed_at = ?, error = NULL
       WHERE id = ? AND status = 'pending'`,
    ).run(claimedAt, row.id);

    if (updated.changes !== 1) return undefined;

    return {
      id: row.id,
      content: row.content,
      status: "in_progress" as const,
      createdAt: row.created_at,
      claimedAt,
    };
  });

  return tx();
}

export function markOwnerMessageProcessed(db: Database.Database, id: string): void {
  db.prepare(
    `UPDATE owner_messages
     SET status = 'processed', processed_at = ?, error = NULL
     WHERE id = ? AND status = 'in_progress'`,
  ).run(new Date().toISOString(), id);
}

export function resetOwnerMessage(db: Database.Database, id: string, error?: string): void {
  db.prepare(
    `UPDATE owner_messages
     SET status = 'pending', claimed_at = NULL, error = ?
     WHERE id = ? AND status = 'in_progress'`,
  ).run(error ?? null, id);
}

export function countPendingOwnerMessages(db: Database.Database): number {
  initializeOwnerControlSchema(db);
  const row = db.prepare(
    "SELECT COUNT(*) AS count FROM owner_messages WHERE status IN ('pending','in_progress')",
  ).get() as { count: number };
  return row.count;
}

export function getOwnerControlAudit(db: Database.Database, limit = 50): Array<{
  id: string;
  action: string;
  detail: unknown;
  createdAt: string;
}> {
  initializeOwnerControlSchema(db);
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 200);
  const rows = db.prepare(
    `SELECT id, action, detail, created_at
     FROM owner_control_audit
     ORDER BY created_at DESC
     LIMIT ?`,
  ).all(safeLimit) as Array<{ id: string; action: string; detail: string; created_at: string }>;

  return rows.map((row) => ({
    id: row.id,
    action: row.action,
    detail: (() => {
      try { return JSON.parse(row.detail); } catch { return row.detail; }
    })(),
    createdAt: row.created_at,
  }));
}
