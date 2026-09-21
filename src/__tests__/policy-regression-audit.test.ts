import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { PolicyEngine } from "../agent/policy-engine.js";
import { createOwnerControlRules } from "../agent/policy-rules/owner-controls.js";
import type { PolicyRule } from "../types.js";

function request(overrides: Record<string, unknown> = {}): any {
  return {
    tool: {
      name: "write_file",
      description: "test tool",
      category: "vm",
      riskLevel: "caution",
      parameters: {},
      execute: async () => "ok",
    },
    args: { path: "/tmp/test" },
    context: {},
    turnContext: { inputSource: "agent" },
    ...overrides,
  };
}

describe("retroactive policy regression audit", () => {
  it("owner-control rules do not require DB state for unrelated tools", () => {
    const rules = createOwnerControlRules();
    const req = request();

    expect(rules[0].evaluate(req)).toBeNull();
    expect(rules[1].evaluate(req)).toBeNull();
  });

  it("owner-control rules fail closed when sensitive action state is unavailable", () => {
    const spendingRule = createOwnerControlRules()[0];
    const result = spendingRule.evaluate(request({
      tool: {
        name: "transfer_credits",
        description: "transfer credits",
        category: "financial",
        riskLevel: "dangerous",
        parameters: {},
        execute: async () => "ok",
      },
      args: { to: "0xabc", amount_cents: 100 },
    }));

    expect(result).toMatchObject({
      action: "deny",
      reasonCode: "OWNER_CONTROL_STATE_UNAVAILABLE",
    });
  });

  it("automatically treats new non-safe financial tools as spending-sensitive", () => {
    const spendingRule = createOwnerControlRules()[0];
    const result = spendingRule.evaluate(request({
      tool: {
        name: "future_financial_action",
        description: "future financial action",
        category: "financial",
        riskLevel: "caution",
        parameters: {},
        execute: async () => "ok",
      },
      args: { amount: 10 },
    }));

    expect(result).toMatchObject({
      action: "deny",
      reasonCode: "OWNER_CONTROL_STATE_UNAVAILABLE",
    });
  });

  it("keeps safe financial read-only tools outside the spending pause", () => {
    const spendingRule = createOwnerControlRules()[0];
    const result = spendingRule.evaluate(request({
      tool: {
        name: "check_balance",
        description: "read-only balance check",
        category: "financial",
        riskLevel: "safe",
        parameters: {},
        execute: async () => "ok",
      },
      args: {},
    }));

    expect(result).toBeNull();
  });

  it("classifies known non-financial capital actions as spending-sensitive", () => {
    const spendingRule = createOwnerControlRules()[0];
    const result = spendingRule.evaluate(request({
      tool: {
        name: "create_sandbox",
        description: "create paid compute sandbox",
        category: "conway",
        riskLevel: "caution",
        parameters: {},
        execute: async () => "ok",
      },
      args: { vcpu: 1 },
    }));

    expect(result).toMatchObject({
      action: "deny",
      reasonCode: "OWNER_CONTROL_STATE_UNAVAILABLE",
    });
  });

  it("policy engine fails closed if an applicable rule throws", () => {
    const db = new Database(":memory:");
    const throwingRule: PolicyRule = {
      id: "test.throwing_rule",
      description: "throws intentionally",
      priority: 1,
      appliesTo: { by: "all" },
      evaluate() {
        throw new Error("broken policy dependency");
      },
    };

    const decision = new PolicyEngine(db, [throwingRule]).evaluate(request());
    expect(decision).toMatchObject({
      action: "deny",
      reasonCode: "POLICY_RULE_ERROR",
    });
    expect(decision.rulesTriggered).toContain("test.throwing_rule");
    db.close();
  });

  it("policy engine denies cyclic arguments instead of throwing during audit hashing", () => {
    const db = new Database(":memory:");
    const cyclic: Record<string, unknown> = { value: "test" };
    cyclic.self = cyclic;

    const engine = new PolicyEngine(db, []);
    expect(() => engine.evaluate(request({ args: cyclic }))).not.toThrow();

    const decision = engine.evaluate(request({ args: cyclic }));
    expect(decision).toMatchObject({
      action: "deny",
      reasonCode: "POLICY_ARGS_UNSERIALIZABLE",
    });
    expect(decision.rulesTriggered).toContain("policy.args_serialization");
    expect(decision.argsHash).toMatch(/^[0-9a-f]{64}$/);
    db.close();
  });

  it("policy engine denies BigInt arguments instead of crashing", () => {
    const db = new Database(":memory:");
    const decision = new PolicyEngine(db, []).evaluate(request({ args: { amount: 1n } }));

    expect(decision).toMatchObject({
      action: "deny",
      reasonCode: "POLICY_ARGS_UNSERIALIZABLE",
    });
    db.close();
  });
});
