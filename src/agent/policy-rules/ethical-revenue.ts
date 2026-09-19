import type {
  PolicyRequest,
  PolicyRule,
  PolicyRuleResult,
} from "../../types.js";

type ProhibitedPattern = {
  id: string;
  pattern: RegExp;
  message: string;
};

/**
 * Constitution-backed revenue constraints.
 *
 * This rule is deliberately tool-agnostic: a prohibited commercial activity
 * must remain prohibited whether attempted through shell, messaging, payments,
 * a future marketplace integration, or a future trading adapter.
 *
 * Pattern detection is defense-in-depth, not a substitute for integration-
 * specific authorization and compliance checks.
 */
const PROHIBITED_PATTERNS: ProhibitedPattern[] = [
  {
    id: "FRAUD_OR_PHISHING",
    pattern: /\b(phish(?:ing)?|credential\s*(?:theft|steal|harvest)|steal\s+(?:password|credentials?|funds?)|fraud(?:ulent)?|fake\s+(?:login|identity|invoice)|impersonat(?:e|ion))\b/i,
    message: "Fraud, phishing, credential theft, theft, and deceptive impersonation are prohibited.",
  },
  {
    id: "MALICIOUS_OR_UNAUTHORIZED_ACCESS",
    pattern: /\b(ransomware|malware|keylogger|botnet|credential\s*stuffing|unauthori[sz]ed\s+(?:access|exploit|intrusion)|exploit\s+(?:a\s+)?(?:victim|target)\s+(?:without|with\s+no)\s+(?:permission|authorization))\b/i,
    message: "Malicious code and unauthorized access are prohibited.",
  },
  {
    id: "COERCION_OR_EXTORTION",
    pattern: /\b(extort(?:ion)?|blackmail|ransom\s+demand|coerc(?:e|ion))\b/i,
    message: "Extortion, blackmail, and coercive revenue methods are prohibited.",
  },
  {
    id: "ABUSIVE_SPAM",
    pattern: /\b(mass\s+spam|spam\s+(?:thousands|millions)|unsolicited\s+bulk\s+(?:message|email|dm)|evade\s+spam\s+filter)\b/i,
    message: "Abusive unsolicited bulk messaging and spam-evasion are prohibited.",
  },
  {
    id: "MARKET_MANIPULATION",
    pattern: /\b(wash\s+trad(?:e|ing)|spoof(?:ing)?|layering|pump\s*(?:and|&)\s*dump|front[- ]?run(?:ning)?|manipulat(?:e|ing)\s+(?:the\s+)?market|fake\s+volume|coordinate\s+(?:a\s+)?pump)\b/i,
    message: "Market manipulation, wash trading, spoofing, layering, pump-and-dump behavior, and front-running are prohibited.",
  },
  {
    id: "INSIDER_INFORMATION_ABUSE",
    pattern: /\b(trade\s+on\s+(?:material\s+)?non[- ]?public\s+information|insider\s+information|inside\s+information|mnpi)\b/i,
    message: "Trading on material non-public or improperly obtained inside information is prohibited.",
  },
  {
    id: "CONTROL_EVASION",
    pattern: /\b(evade|bypass|circumvent)\s+(?:exchange|broker|platform|kyc|aml|sanctions?|risk|position|withdrawal|account)\s+(?:control|limit|restriction|rule|check)s?\b/i,
    message: "Evasion of exchange, broker, platform, KYC/AML, sanctions, or risk controls is prohibited.",
  },
  {
    id: "STOLEN_DATA_OR_SERVICES",
    pattern: /\b(stolen\s+(?:data|account|card|credentials?|api\s*key)|carding|pirated\s+credential|use\s+someone\s+else'?s\s+(?:account|card|api\s*key)\s+without\s+permission)\b/i,
    message: "Using stolen data, accounts, payment instruments, credentials, or services is prohibited.",
  },
];

function flattenStrings(value: unknown, depth = 0): string[] {
  if (depth > 5 || value === null || value === undefined) return [];
  if (typeof value === "string") return [value];
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (Array.isArray(value)) return value.flatMap((item) => flattenStrings(item, depth + 1));
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => [
      key,
      ...flattenStrings(child, depth + 1),
    ]);
  }
  return [];
}

function deny(pattern: ProhibitedPattern): PolicyRuleResult {
  return {
    rule: "ethics.prohibited_revenue_activity",
    action: "deny",
    reasonCode: pattern.id,
    humanMessage: `Constitutional revenue guardrail: ${pattern.message}`,
  };
}

function createProhibitedRevenueActivityRule(): PolicyRule {
  return {
    id: "ethics.prohibited_revenue_activity",
    description:
      "Block tool calls that explicitly request unethical, harmful, deceptive, unauthorized, or manipulative revenue activity.",
    priority: 1,
    appliesTo: { by: "all" },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const searchable = flattenStrings(request.args).join(" \n ");
      if (!searchable) return null;

      for (const pattern of PROHIBITED_PATTERNS) {
        if (pattern.pattern.test(searchable)) return deny(pattern);
      }
      return null;
    },
  };
}

/**
 * Business-ledger integrity rule.
 * Revenue must represent money actually received. It cannot be manufactured
 * from forecasts or unrealized trading gains to make portfolio metrics look
 * better than they are.
 */
function createRevenueIntegrityRule(): PolicyRule {
  return {
    id: "ethics.revenue_integrity",
    description: "Prevent projected or unrealized amounts from being booked as realized business revenue.",
    priority: 2,
    appliesTo: { by: "name", names: ["record_business_revenue"] },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const text = flattenStrings(request.args).join(" ");
      if (/\b(projected|forecast|expected|potential|unrealized|paper\s+profit|mark[- ]to[- ]market)\b/i.test(text)) {
        return {
          rule: "ethics.revenue_integrity",
          action: "deny",
          reasonCode: "UNREALIZED_REVENUE",
          humanMessage:
            "Only realized revenue actually received may be recorded as business revenue. Track forecasts and unrealized gains separately.",
        };
      }
      return null;
    },
  };
}

/**
 * A generic live-trading rule for current and future adapters.
 * Any tool whose name starts with trade_/trading_/place_order/submit_order is
 * subject to a basic authorization check. Adapter-specific policy will add
 * capital, drawdown, venue, and account constraints later.
 */
function createTradingIntentRule(): PolicyRule {
  return {
    id: "ethics.trading_intent",
    description: "Apply constitutional trading restrictions to current and future trading/order tools.",
    priority: 3,
    appliesTo: { by: "all" },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const name = request.tool.name.toLowerCase();
      const looksLikeTradingExecution =
        name.startsWith("trade_") ||
        name.startsWith("trading_") ||
        name.includes("place_order") ||
        name.includes("submit_order");
      if (!looksLikeTradingExecution) return null;

      const text = flattenStrings(request.args).join(" ");
      for (const pattern of PROHIBITED_PATTERNS) {
        if (
          ["MARKET_MANIPULATION", "INSIDER_INFORMATION_ABUSE", "CONTROL_EVASION"].includes(pattern.id) &&
          pattern.pattern.test(text)
        ) {
          return deny(pattern);
        }
      }
      return null;
    },
  };
}

export function createEthicalRevenueRules(): PolicyRule[] {
  return [
    createProhibitedRevenueActivityRule(),
    createRevenueIntegrityRule(),
    createTradingIntentRule(),
  ];
}
