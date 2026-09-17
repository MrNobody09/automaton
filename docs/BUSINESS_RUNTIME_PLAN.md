# Automaton Business Runtime Plan

## Objective

Extend Automaton into a profit-seeking autonomous digital business while preserving hard ethical constraints and human auditability.

The runtime may pursue multiple legitimate revenue strategies, including paid digital work, software/API products, agent-native commerce, and trading. Profit is subordinate to the constitution and policy engine.

## Design Principles

1. **Ethics above profit** — the agent must not earn through fraud, theft, deception, coercion, unauthorized access, manipulation, spam, market manipulation, exploitation, or other harmful/illegal activity.
2. **Enforce constraints in code** — ethical and financial boundaries must be represented in policy rules and audit logs, not only in prompts.
3. **Portfolio economics** — every commercial strategy is tracked as an experiment with attributable revenue and cost.
4. **Realized profit over activity** — optimize for sustainable realized profit and cash runway, not token usage, number of projects, gross volume, or speculative mark-to-market gains.
5. **Trading is one strategy, not the business** — trading receives a defined capital allocation and separate risk accounting.
6. **Auditable autonomy** — revenue, costs, policy decisions, strategy state, and capital allocation remain inspectable by the creator.

## Workstreams

### 1. Business Accounting Foundation

Add persistent entities for:
- business experiments
- revenue events
- cost events
- strategy allocations
- realized profit and ROI
- lifecycle state: research, build, launch, validate, scale, pause, kill

Expose tools for creating/updating experiments, recording revenue/costs, querying economics, and closing experiments.

### 2. Ethical Revenue Policy

Extend the runtime policy layer with hard-deny categories for activities that violate the constitution, including:
- fraud, phishing, credential theft, or impersonation
- malicious code or unauthorized access
- extortion, coercion, deceptive sales, or manipulation
- spam or abusive unsolicited outreach
- theft of data, funds, intellectual property, or services
- market manipulation, wash trading, spoofing, pump-and-dump behavior, insider-information abuse, or attempts to evade exchange/platform controls
- revenue methods whose legality or authorization cannot reasonably be established

Policy denials must be logged.

### 3. Trading Strategy Lane

Trading will be represented as a business strategy with its own ledger and risk budget.

Initial design:
- support research and market-data ingestion
- maintain strategy-level P&L separate from other revenue
- distinguish realized from unrealized P&L
- configurable maximum capital allocation
- configurable maximum position size
- configurable daily loss and drawdown limits
- no leverage by default
- no market manipulation or deceptive market behavior
- strategy pause/circuit-breaker on risk-limit breach
- paper/simulation execution path and live execution path using the same strategy interface

Trading performance must be evaluated net of fees, slippage, infrastructure, and inference costs.

### 4. Opportunity Discovery

Continuously identify legitimate paid work and product opportunities, estimate expected value and cost, and create experiments when justified.

### 5. Revenue Integrations

Planned integrations:
- autonomous paid-work marketplaces
- x402-paid APIs and services
- agent/developer marketplaces
- product deployment and metered payment collection
- trading venues through explicitly configured, authorized accounts

### 6. Capital Allocation

The parent agent allocates treasury across experiments according to expected return, realized evidence, risk, and runway. Child agents are spawned only where parallelization has positive expected value.

## North-Star Metrics

Primary:
- cumulative realized net profit

Supporting:
- cash runway
- revenue
- direct and shared costs
- realized profit by strategy
- ROI / margin
- revenue per inference dollar
- experiment conversion and survival rate
- repeat customers / paid calls
- trading realized P&L, drawdown, fees and risk utilization

## Implementation Order

1. Business accounting + persistence
2. Ethical revenue policy rules + tests
3. Business review / portfolio tools
4. Opportunity discovery
5. Paid-work integration
6. x402 seller/product integration
7. Trading research + simulation interface
8. Live trading adapter behind configured risk controls
9. Economic child-agent allocation
10. Production business genesis prompt
