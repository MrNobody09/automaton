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

function getRawDb(request: PolicyRequest) {
  return request.context?.db?.raw;
}

function isDangerousFinancialAction(request: PolicyRequest): boolean {
  return request.tool.category === "financial" && request.tool.riskLevel === "dangerous";
}

function isOutboundSpendAction(request: PolicyRequest): boolean {
  return OUTBOUND_SPEND_TOOLS.has(request.tool.name) || isDangerousFinancialAction(request);
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
        // Do not touch owner-control state for unrelated actions. This keeps
        // independent policy rules composable and prevents a missing control
        // store from masking command-safety evaluation.
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
