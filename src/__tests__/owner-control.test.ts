import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase } from "../state/database.js";
import {
  claimNextOwnerMessage,
  countPendingOwnerMessages,
  enqueueOwnerMessage,
  getOwnerControlFlags,
  markOwnerMessageProcessed,
  resetOwnerMessage,
  updateOwnerControlFlags,
} from "../control/state.js";
import {
  consumeApprovedOwnerApproval,
  decideOwnerApproval,
  requestOwnerApproval,
} from "../control/approvals.js";
import { createOwnerControlRules } from "../agent/policy-rules/owner-controls.js";
import { spawnChild } from "../replication/spawn.js";
import { createOwnerControlServer } from "../control/server.js";
import { BUILTIN_TASKS } from "../heartbeat/tasks.js";

const tempDirs: string[] = [];
const servers: Array<ReturnType<typeof createOwnerControlServer>> = [];

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automaton-owner-control-"));
  tempDirs.push(dir);
  return createDatabase(path.join(dir, "state.db"));
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    if (server.listening) {
      server.close();
      await once(server, "close");
    }
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("owner control state", () => {
  it("persists emergency flags independently", () => {
    const db = makeDb();
    const flags = updateOwnerControlFlags(db.raw, {
      autonomyPaused: true,
      spendingPaused: true,
      tradingPaused: false,
      childCreationPaused: true,
    });

    expect(flags).toEqual({
      autonomyPaused: true,
      spendingPaused: true,
      tradingPaused: false,
      childCreationPaused: true,
    });
    expect(getOwnerControlFlags(db.raw)).toEqual(flags);
    db.close();
  });

  it("retries owner messages after failure and processes them durably", () => {
    const db = makeDb();
    const queued = enqueueOwnerMessage(db.raw, "Review current business portfolio");
    expect(countPendingOwnerMessages(db.raw)).toBe(1);

    const firstClaim = claimNextOwnerMessage(db.raw);
    expect(firstClaim?.id).toBe(queued.id);
    expect(firstClaim?.status).toBe("in_progress");

    resetOwnerMessage(db.raw, queued.id, "temporary failure");
    const retry = claimNextOwnerMessage(db.raw);
    expect(retry?.id).toBe(queued.id);

    markOwnerMessageProcessed(db.raw, queued.id);
    expect(countPendingOwnerMessages(db.raw)).toBe(0);
    expect(claimNextOwnerMessage(db.raw)).toBeUndefined();
    db.close();
  });
});

describe("owner approvals", () => {
  it("binds approval to exact tool args and consumes it once", () => {
    const db = makeDb();
    const approval = requestOwnerApproval(db.raw, {
      toolName: "transfer_credits",
      argsHash: "hash-a",
      args: { to_address: "0xabc", amount_cents: 2000 },
      reason: "confirmation required",
    });

    decideOwnerApproval(db.raw, approval.id, "approve");
    expect(consumeApprovedOwnerApproval(db.raw, "transfer_credits", "hash-b")).toBeUndefined();
    expect(consumeApprovedOwnerApproval(db.raw, "transfer_credits", "hash-a")?.id).toBe(approval.id);
    expect(consumeApprovedOwnerApproval(db.raw, "transfer_credits", "hash-a")).toBeUndefined();
    db.close();
  });
});

describe("owner emergency policy", () => {
  function request(db: ReturnType<typeof makeDb>, tool: any) {
    return {
      tool,
      args: {},
      context: { db } as any,
      turnContext: {} as any,
    };
  }

  it("blocks outbound spend while leaving safe financial bookkeeping available", () => {
    const db = makeDb();
    updateOwnerControlFlags(db.raw, { spendingPaused: true });
    const rules = createOwnerControlRules();
    const spendRule = rules.find((rule) => rule.id === "owner_controls.spending_paused")!;

    expect(
      spendRule.evaluate(
        request(db, { name: "transfer_credits", category: "financial", riskLevel: "dangerous" }),
      )?.reasonCode,
    ).toBe("OWNER_SPENDING_PAUSED");

    expect(
      spendRule.evaluate(
        request(db, { name: "get_business_portfolio", category: "financial", riskLevel: "safe" }),
      ),
    ).toBeNull();
    db.close();
  });

  it("blocks live trading-like execution while keeping trading inspection available", () => {
    const db = makeDb();
    updateOwnerControlFlags(db.raw, { tradingPaused: true });
    const rule = createOwnerControlRules().find((item) => item.id === "owner_controls.trading_paused")!;

    expect(
      rule.evaluate(request(db, { name: "place_trade_order", category: "financial", riskLevel: "dangerous" }))
        ?.reasonCode,
    ).toBe("OWNER_TRADING_PAUSED");
    expect(
      rule.evaluate(request(db, { name: "get_trading_risk", category: "financial", riskLevel: "safe" })),
    ).toBeNull();
    db.close();
  });

  it("prevents heartbeat auto-topup while spending is paused", async () => {
    const db = makeDb();
    updateOwnerControlFlags(db.raw, { spendingPaused: true });

    const result = await BUILTIN_TASKS.check_usdc_balance(
      {
        timestamp: new Date().toISOString(),
        creditBalance: 0,
        usdcBalance: 100,
        survivalTier: "critical",
      } as any,
      {
        db,
        config: { conwayApiUrl: "https://example.invalid" },
        identity: { account: {}, chainType: "evm" },
        conway: {},
      } as any,
    );

    expect(result.shouldWake).toBe(false);
    expect(db.getKV("last_auto_topup_attempt")).toBeUndefined();
    db.close();
  });
});

describe("child creation pause", () => {
  it("blocks at the spawn boundary before any Conway allocation", async () => {
    const db = makeDb();
    updateOwnerControlFlags(db.raw, { childCreationPaused: true });

    await expect(
      spawnChild({} as any, {} as any, db, { name: "blocked-child" } as any, undefined, { maxChildren: 3 }),
    ).rejects.toThrow("disabled by owner emergency control");
    db.close();
  });
});

describe("owner control HTTP API", () => {
  it("requires bearer auth and accepts authenticated owner messages", async () => {
    const db = makeDb();
    const token = "a".repeat(48);
    const server = createOwnerControlServer({
      db,
      config: { name: "test", version: "test" } as any,
      token,
      host: "127.0.0.1",
      port: 0,
    });
    servers.push(server);
    if (!server.listening) await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const base = `http://127.0.0.1:${address.port}`;

    const unauthorized = await fetch(`${base}/v1/status`);
    expect(unauthorized.status).toBe(401);

    const authorized = await fetch(`${base}/v1/status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(authorized.status).toBe(200);

    const chat = await fetch(`${base}/v1/chat`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message: "Pause new experiments until review" }),
    });
    expect(chat.status).toBe(202);
    expect(countPendingOwnerMessages(db.raw)).toBe(1);

    const control = await fetch(`${base}/v1/controls`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ spendingPaused: true }),
    });
    expect(control.status).toBe(200);
    expect(getOwnerControlFlags(db.raw).spendingPaused).toBe(true);
    db.close();
  });
});
