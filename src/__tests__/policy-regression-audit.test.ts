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
});
