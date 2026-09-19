import type Database from "better-sqlite3";
import { ulid } from "ulid";

export type OwnerApprovalStatus = "pending" | "approved" | "rejected" | "consumed";

export interface OwnerApproval {
  id: string;
  toolName: string;
  argsHash: string;
  args: Record<string, unknown>;
  reason: string;
  status: OwnerApprovalStatus;
  createdAt: string;
  decidedAt?: string;
  decisionNote?: string;
}

export function initializeOwnerApprovalSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS owner_approvals (
      id TEXT PRIMARY KEY,
      tool_name TEXT NOT NULL,
      args_hash TEXT NOT NULL,
      args_json TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','approved','rejected','consumed')),
      created_at TEXT NOT NULL,
      decided_at TEXT,
      decision_note TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_owner_approvals_lookup
      ON owner_approvals(tool_name, args_hash, status, created_at);
  `);
}

function deserialize(row: any): OwnerApproval {
  return {
    id: row.id,
    toolName: row.tool_name,
    argsHash: row.args_hash,
    args: (() => {
      try { return JSON.parse(row.args_json); } catch { return {}; }
    })(),
    reason: row.reason,
    status: row.status,
    createdAt: row.created_at,
    decidedAt: row.decided_at ?? undefined,
    decisionNote: row.decision_note ?? undefined,
  };
}

export function requestOwnerApproval(
  db: Database.Database,
  input: {
    toolName: string;
    argsHash: string;
    args: Record<string, unknown>;
    reason: string;
  },
): OwnerApproval {
  initializeOwnerApprovalSchema(db);

  const existing = db.prepare(
    `SELECT * FROM owner_approvals
     WHERE tool_name = ? AND args_hash = ? AND status IN ('pending','approved')
     ORDER BY created_at DESC LIMIT 1`,
  ).get(input.toolName, input.argsHash) as any | undefined;

  if (existing) return deserialize(existing);

  const approval: OwnerApproval = {
    id: ulid(),
    toolName: input.toolName,
    argsHash: input.argsHash,
    args: input.args,
    reason: input.reason,
    status: "pending",
    createdAt: new Date().toISOString(),
  };

  db.prepare(
    `INSERT INTO owner_approvals
      (id, tool_name, args_hash, args_json, reason, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
  ).run(
    approval.id,
    approval.toolName,
    approval.argsHash,
    JSON.stringify(approval.args),
    approval.reason,
    approval.createdAt,
  );

  return approval;
}

export function consumeApprovedOwnerApproval(
  db: Database.Database,
  toolName: string,
  argsHash: string,
): OwnerApproval | undefined {
  initializeOwnerApprovalSchema(db);

  const tx = db.transaction(() => {
    const row = db.prepare(
      `SELECT * FROM owner_approvals
       WHERE tool_name = ? AND args_hash = ? AND status = 'approved'
       ORDER BY created_at ASC LIMIT 1`,
    ).get(toolName, argsHash) as any | undefined;
    if (!row) return undefined;

    const result = db.prepare(
      `UPDATE owner_approvals SET status = 'consumed'
       WHERE id = ? AND status = 'approved'`,
    ).run(row.id);
    if (result.changes !== 1) return undefined;
    return { ...deserialize(row), status: "consumed" as const };
  });

  return tx();
}

export function decideOwnerApproval(
  db: Database.Database,
  id: string,
  decision: "approve" | "reject",
  note?: string,
): OwnerApproval {
  initializeOwnerApprovalSchema(db);
  const status = decision === "approve" ? "approved" : "rejected";
  const result = db.prepare(
    `UPDATE owner_approvals
     SET status = ?, decided_at = ?, decision_note = ?
     WHERE id = ? AND status = 'pending'`,
  ).run(status, new Date().toISOString(), note?.trim() || null, id);

  if (result.changes !== 1) {
    const current = db.prepare("SELECT * FROM owner_approvals WHERE id = ?").get(id) as any | undefined;
    if (!current) throw new Error(`Approval ${id} not found`);
    throw new Error(`Approval ${id} is already ${current.status}`);
  }

  const row = db.prepare("SELECT * FROM owner_approvals WHERE id = ?").get(id) as any;
  return deserialize(row);
}

export function listOwnerApprovals(
  db: Database.Database,
  limit = 50,
): OwnerApproval[] {
  initializeOwnerApprovalSchema(db);
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 200);
  const rows = db.prepare(
    `SELECT * FROM owner_approvals
     ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
              created_at DESC
     LIMIT ?`,
  ).all(safeLimit) as any[];
  return rows.map(deserialize);
}
