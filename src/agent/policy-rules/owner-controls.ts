import type { PolicyRequest, PolicyRule, PolicyRuleResult } from "../../types.js";
import { isSpendingPaused, isTradingPaused } from "../../control/state.js";

// Exceptional spend-capable tools that are not categorized as `financial`.
// Financial tools are protected generically below so adding a new caution or
// dangerous financial tool cannot silently bypass the owner spending pause.
const NON_FINANCIAL_SPEND_TOOLS = new Set([
  "create_sandbox",
  "register_domain",
]);

function deny(rule: string, reasonCode: string, humanMessage: string): PolicyRuleResult {
  return { rule, action: "deny", reasonCode, humanMessage };
}

function getRawDb(request: PolicyRequest) {
  return request.context?.db?.raw;
}

function isOutboundSpendAction(request: PolicyRequest): boolean {
  if (NON_FINANCIAL_SPEND_TOOLS.has(request.tool.name)) return true;
  return request.tool.category === "financial" && request.tool.riskLevel !== "safe";
}

function isTradingExecution(request: PolicyRequest): boolean {
  const name = request.tool.name.toLowerCase();
  return (
    /(place|submit|execute|cancel|close|open).*(trade|order|position|swap)/.test(name) ||
    /(trade|order|swap)_?(buy|sell|execute|submit|place)/.test(name)
  );
}

function ownerStateUnavailable(rule: string, control: string): PolicyRuleResult {
  return deny(
    rule,
    "OWNER_CONTROL_STATE_UNAVAILABLE",
    `Owner ${control} control state is unavailable. Denying the sensitive action safely.`,
  );
}

export function createOwnerControlRules(): PolicyRule[] {
  return [
    {
      id: "owner_controls.spending_paused",
      description: "Deny outbound capital actions while owner spending pause is enabled",
      priority: 2,
      appliesTo: { by: "all" },
      evaluate(request: PolicyRequest): PolicyRuleResult | null {
        // Do not touch owner-control state for unrelated actions. Financial
        // caution/dangerous tools are automatically classified as spend-capable;
        // only non-financial exceptions need an explicit entry above.
        if (!isOutboundSpendAction(request)) return null;

        const rawDb = getRawDb(request);
        if (!rawDb) {
          return ownerStateUnavailable("owner_controls.spending_paused", "spending");
        }

        try {
          if (!isSpendingPaused(rawDb)) return null;
        } catch {
          return ownerStateUnavailable("owner_controls.spending_paused", "spending");
        }

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
        if (!isTradingExecution(request)) return null;

        const rawDb = getRawDb(request);
        if (!rawDb) {
          return ownerStateUnavailable("owner_controls.trading_paused", "trading");
        }

        try {
          if (!isTradingPaused(rawDb)) return null;
        } catch {
          return ownerStateUnavailable("owner_controls.trading_paused", "trading");
        }

        return deny(
          "owner_controls.trading_paused",
          "OWNER_TRADING_PAUSED",
          "Owner emergency control has paused live trading execution.",
        );
      },
    },
  ];
}
