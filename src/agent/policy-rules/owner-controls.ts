import type { PolicyRequest, PolicyRule, PolicyRuleResult } from "../../types.js";
import { isSpendingPaused, isTradingPaused } from "../../control/state.js";

const OUTBOUND_SPEND_TOOLS = new Set([
  "transfer_credits",
  "topup_credits",
  "fund_child",
  "x402_fetch",
  "register_domain",
]);

function deny(rule: string, reasonCode: string, humanMessage: string): PolicyRuleResult {
  return { rule, action: "deny", reasonCode, humanMessage };
}

export function createOwnerControlRules(): PolicyRule[] {
  return [
    {
      id: "owner_controls.spending_paused",
      description: "Deny outbound capital actions while owner spending pause is enabled",
      priority: 2,
      appliesTo: { by: "all" },
      evaluate(request: PolicyRequest): PolicyRuleResult | null {
        if (!isSpendingPaused(request.context.db.raw)) return null;
        const isDangerousFinancial =
          request.tool.category === "financial" && request.tool.riskLevel === "dangerous";
        if (!OUTBOUND_SPEND_TOOLS.has(request.tool.name) && !isDangerousFinancial) return null;
        return deny(
          "owner_controls.spending_paused",
          "OWNER_SPENDING_PAUSED",
          "Owner emergency control has paused outbound spending.",
        );
      },
    },
    {
      id: "owner_controls.trading_paused",
      description: "Deny live trading execution while owner trading pause is enabled",
      priority: 2,
      appliesTo: { by: "all" },
      evaluate(request: PolicyRequest): PolicyRuleResult | null {
        if (!isTradingPaused(request.context.db.raw)) return null;
        const name = request.tool.name.toLowerCase();
        const looksLikeTradingExecution =
          /(place|submit|execute|cancel|close|open).*(trade|order|position|swap)/.test(name) ||
          /(trade|order|swap)_?(buy|sell|execute|submit|place)/.test(name);
        if (!looksLikeTradingExecution) return null;
        return deny(
          "owner_controls.trading_paused",
          "OWNER_TRADING_PAUSED",
          "Owner emergency control has paused live trading execution.",
        );
      },
    },
  ];
}
