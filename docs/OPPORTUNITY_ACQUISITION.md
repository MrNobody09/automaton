# Opportunity Acquisition

## Purpose

The acquisition layer turns external evidence of legitimate paid work into the existing `business_opportunities` pipeline. It is intentionally read-only at the marketplace boundary:

`Discover -> Normalize -> Dedupe -> Score -> Review -> Approve/Reject`

Claiming work, staking funds, submitting applications, posting proposals, or accepting contractual terms are not part of this layer.

## Supported sources

### 0xWork

A disabled-by-default source named `0xwork-public` is seeded automatically. When explicitly enabled, Automaton reads open tasks from the configured 0xWork discovery endpoint and filters them by capability, bounty range, physical/IRL category, safety flags, and result count.

0xWork opportunities are assigned non-zero capital-at-risk and elevated default risk because claiming can involve collateral/staking, escrow, dispute handling, smart contracts, token liquidity, and slashing. Discovery does not authorize a claim.

### GitHub issues

GitHub discovery requires an explicit repository allowlist. Global `label:bounty` discovery is deliberately not supported because public issue search contains spam, joke bounties, mirrored boards, stale tasks, and unverified payment claims.

Configuration can include:

- `repositories`: required `owner/repo` allowlist when enabled
- `labels`: optional issue labels such as `bounty`
- `searchTerms`: optional query text; cannot add repository/org/user qualifiers
- `maxResults`
- `maxRewardUsd`
- scoring defaults such as probability, risk, learning value, and time to revenue

`GITHUB_TOKEN` may be provided through the production environment to increase GitHub API rate limits. It is not stored in acquisition tables.

## Trust model

External marketplace content is untrusted. Titles and descriptions pass through Automaton's prompt-injection defense before being promoted into business state. Raw source records are stored only for audit/provenance and are not treated as instructions.

A discovered reward is evidence, not realized revenue. Acquisition never writes to the realized-revenue ledger.

## Provenance and deduplication

`opportunity_sources` stores source configuration and sync health.

`opportunity_imports` stores:

- source and external ID
- canonical external URL
- fingerprint
- linked `business_opportunity`
- bounded raw/normalized evidence
- first/last seen timestamps

Repeated syncs update the existing linked opportunity rather than creating a new one. Cross-source records with the same canonical URL share the existing opportunity through the fingerprint.

## Scheduled discovery

The `opportunity_discovery` heartbeat runs every six hours at minute 43. The default 0xWork source is disabled, so a fresh installation performs no external opportunity polling until a source is explicitly enabled.

Discovery failures are isolated per source. A failed marketplace does not prevent other enabled sources from syncing.

The heartbeat wakes the agent only when new opportunities were created or a source failed. New opportunities then enter the existing business review and scoring loop.

## Current boundary

This PR stops before external commitment. A later execution layer may support claim/apply actions, but those actions must be separate dangerous/financial tools subject to:

- owner spending controls
- policy/ethics enforcement
- exact approval for quarantined actions
- marketplace authorization and ToS validation
- capital-at-risk accounting
- source-specific claim/submission rules
