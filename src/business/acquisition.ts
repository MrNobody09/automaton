import { createHash } from "node:crypto";
import type BetterSqlite3 from "better-sqlite3";
import { ulid } from "ulid";
import { sanitizeInput, sanitizeToolResult } from "../agent/injection-defense.js";
import {
  createBusinessOpportunity,
  getBusinessOpportunity,
  initializeBusinessIntelligenceSchema,
  scoreBusinessOpportunity,
  updateBusinessOpportunity,
} from "./intelligence.js";

export type OpportunitySourceType = "0xwork" | "github_issues";

export interface OpportunitySourceConfigInput {
  id: string;
  name: string;
  type: OpportunitySourceType;
  enabled?: boolean;
  config?: Record<string, unknown>;
}

export interface OpportunityDiscoveryResult {
  sourceId: string;
  sourceName: string;
  status: "success" | "disabled" | "error";
  fetched: number;
  created: number;
  updated: number;
  duplicates: number;
  skipped: number;
  error?: string;
}

export interface AcquisitionSummary {
  generatedAt: string;
  sourceCount: number;
  enabledSourceCount: number;
  importCount: number;
  linkedOpportunityCount: number;
  recentImports: Record<string, unknown>[];
  sources: Record<string, unknown>[];
}

export interface AcquisitionFetchResponse {
  ok: boolean;
  status: number;
  statusText?: string;
  json(): Promise<unknown>;
}

export type AcquisitionFetch = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  },
) => Promise<AcquisitionFetchResponse>;

interface NormalizedCandidate {
  externalId: string;
  externalUrl: string;
  title: string;
  description: string;
  revenueMechanism: string;
  targetBuyer: string;
  demandEvidence: string;
  estimatedRevenueCents: number;
  estimatedBuildCostCents: number;
  estimatedRecurringCostCents: number;
  capitalAtRiskCents: number;
  successProbability: number;
  riskScore: number;
  timeToRevenueDays: number;
  learningValue: number;
  competitionNotes: string;
  legalEthicalNotes: string;
  metadata: Record<string, unknown>;
  raw: unknown;
}

interface OpportunitySourceRow {
  id: string;
  name: string;
  type: OpportunitySourceType;
  enabled: number;
  endpoint: string;
  config_json: string;
  risk_notes: string;
  created_at: string;
  updated_at: string;
  last_sync_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  consecutive_failures: number;
}

const SOURCE_ENDPOINTS: Record<OpportunitySourceType, string> = {
  "0xwork": "https://api.0xwork.org/tasks?status=open",
  "github_issues": "https://api.github.com/search/issues",
};

const DEFAULT_0XWORK_CONFIG = {
  capabilities: ["Research", "Writing", "Code", "Data"],
  minBountyUsd: 5,
  maxBountyUsd: 10_000,
  maxResults: 50,
  includePhysical: false,
  allowSafetyFlagged: false,
  successProbability: 0.3,
  riskScore: 0.55,
};

const MAX_RAW_JSON_CHARS = 50_000;
const MAX_DESCRIPTION_CHARS = 12_000;
const MAX_GITHUB_REPOSITORIES = 25;
const MAX_RESULTS = 100;
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

export function initializeOpportunityAcquisitionSchema(db: BetterSqlite3.Database): void {
  initializeBusinessIntelligenceSchema(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS opportunity_sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('0xwork','github_issues')),
      enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
      endpoint TEXT NOT NULL,
      config_json TEXT NOT NULL DEFAULT '{}',
      risk_notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_sync_at TEXT,
      last_success_at TEXT,
      last_error TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK(consecutive_failures >= 0)
    );

    CREATE INDEX IF NOT EXISTS idx_opportunity_sources_enabled
      ON opportunity_sources(enabled, type);

    CREATE TABLE IF NOT EXISTS opportunity_imports (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES opportunity_sources(id),
      external_id TEXT NOT NULL,
      external_url TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      opportunity_id TEXT REFERENCES business_opportunities(id),
      raw_json TEXT NOT NULL DEFAULT '{}',
      normalized_json TEXT NOT NULL DEFAULT '{}',
      import_status TEXT NOT NULL DEFAULT 'linked'
        CHECK(import_status IN ('linked','duplicate','skipped')),
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      UNIQUE(source_id, external_id)
    );

    CREATE INDEX IF NOT EXISTS idx_opportunity_imports_fingerprint
      ON opportunity_imports(fingerprint);
    CREATE INDEX IF NOT EXISTS idx_opportunity_imports_opportunity
      ON opportunity_imports(opportunity_id);
    CREATE INDEX IF NOT EXISTS idx_opportunity_imports_seen
      ON opportunity_imports(last_seen_at DESC);
  `);

  ensureDefaultOpportunitySources(db);
}

export function ensureDefaultOpportunitySources(db: BetterSqlite3.Database): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR IGNORE INTO opportunity_sources (
      id, name, type, enabled, endpoint, config_json, risk_notes, created_at, updated_at
    ) VALUES (?, ?, '0xwork', 0, ?, ?, ?, ?, ?)
  `).run(
    "0xwork-public",
    "0xWork public tasks",
    SOURCE_ENDPOINTS["0xwork"],
    JSON.stringify(DEFAULT_0XWORK_CONFIG),
    "Read-only discovery only. Claiming work can require AXOBOTL collateral and exposes capital to protocol, smart-contract, dispute, and slashing risk.",
    now,
    now,
  );
}

export function configureOpportunitySource(
  db: BetterSqlite3.Database,
  input: OpportunitySourceConfigInput,
): Record<string, unknown> {
  initializeOpportunityAcquisitionSchema(db);
  const id = normalizeSourceId(input.id);
  const name = input.name?.trim();
  if (!name) throw new Error("name is required");
  if (input.type !== "0xwork" && input.type !== "github_issues") {
    throw new Error(`Unsupported opportunity source type: ${String(input.type)}`);
  }

  const current = db.prepare("SELECT * FROM opportunity_sources WHERE id = ?").get(id) as OpportunitySourceRow | undefined;
  if (current && current.type !== input.type) {
    throw new Error("Opportunity source type cannot be changed after creation");
  }

  const baseConfig = current ? safeJson(current.config_json) : defaultConfigForType(input.type);
  const config = { ...baseConfig, ...(input.config ?? {}) };
  validateSourceConfig(input.type, config, input.enabled ?? Boolean(current?.enabled));

  const now = new Date().toISOString();
  const enabled = input.enabled ?? Boolean(current?.enabled);
  const riskNotes = riskNotesForType(input.type);

  db.prepare(`
    INSERT INTO opportunity_sources (
      id, name, type, enabled, endpoint, config_json, risk_notes, created_at, updated_at,
      last_sync_at, last_success_at, last_error, consecutive_failures
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      enabled = excluded.enabled,
      endpoint = excluded.endpoint,
      config_json = excluded.config_json,
      risk_notes = excluded.risk_notes,
      updated_at = excluded.updated_at
  `).run(
    id,
    name,
    input.type,
    enabled ? 1 : 0,
    SOURCE_ENDPOINTS[input.type],
    JSON.stringify(config),
    riskNotes,
    current?.created_at ?? now,
    now,
  );

  return getOpportunitySource(db, id)!;
}

export function getOpportunitySource(
  db: BetterSqlite3.Database,
  id: string,
): Record<string, unknown> | undefined {
  initializeOpportunityAcquisitionSchema(db);
  const row = db.prepare("SELECT * FROM opportunity_sources WHERE id = ?").get(id) as OpportunitySourceRow | undefined;
  return row ? serializeSource(row) : undefined;
}

export function listOpportunitySources(db: BetterSqlite3.Database): Record<string, unknown>[] {
  initializeOpportunityAcquisitionSchema(db);
  const rows = db.prepare(`SELECT * FROM opportunity_sources ORDER BY enabled DESC, name ASC`).all() as OpportunitySourceRow[];
  return rows.map(serializeSource);
}

export async function runOpportunityDiscovery(
  db: BetterSqlite3.Database,
  sourceId: string,
  fetcher: AcquisitionFetch = globalThis.fetch as unknown as AcquisitionFetch,
): Promise<OpportunityDiscoveryResult> {
  initializeOpportunityAcquisitionSchema(db);
  const source = db.prepare("SELECT * FROM opportunity_sources WHERE id = ?").get(sourceId) as OpportunitySourceRow | undefined;
  if (!source) throw new Error(`Opportunity source not found: ${sourceId}`);

  const baseResult: OpportunityDiscoveryResult = {
    sourceId: source.id,
    sourceName: source.name,
    status: source.enabled ? "success" : "disabled",
    fetched: 0,
    created: 0,
    updated: 0,
    duplicates: 0,
    skipped: 0,
  };
  if (!source.enabled) return baseResult;

  const config = safeJson(source.config_json);
  try {
    validateSourceConfig(source.type, config, true);
    const candidates = await fetchSourceCandidates(source, config, fetcher);
    baseResult.fetched = candidates.length;

    for (const candidate of candidates) {
      const outcome = importCandidate(db, source, candidate);
      if (outcome === "created") baseResult.created++;
      else if (outcome === "updated") baseResult.updated++;
      else if (outcome === "duplicate") baseResult.duplicates++;
      else baseResult.skipped++;
    }

    const now = new Date().toISOString();
    db.prepare(`
      UPDATE opportunity_sources
      SET last_sync_at = ?, last_success_at = ?, last_error = NULL,
          consecutive_failures = 0, updated_at = ?
      WHERE id = ?
    `).run(now, now, now, source.id);
    return baseResult;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE opportunity_sources
      SET last_sync_at = ?, last_error = ?, consecutive_failures = consecutive_failures + 1,
          updated_at = ?
      WHERE id = ?
    `).run(now, message.slice(0, 2_000), now, source.id);
    return { ...baseResult, status: "error", error: message };
  }
}

export async function runEnabledOpportunityDiscovery(
  db: BetterSqlite3.Database,
  fetcher: AcquisitionFetch = globalThis.fetch as unknown as AcquisitionFetch,
): Promise<{ results: OpportunityDiscoveryResult[]; totals: Record<string, number> }> {
  initializeOpportunityAcquisitionSchema(db);
  const rows = db.prepare(`SELECT id FROM opportunity_sources WHERE enabled = 1 ORDER BY name ASC`).all() as Array<{ id: string }>;
  const results: OpportunityDiscoveryResult[] = [];
  for (const row of rows) {
    results.push(await runOpportunityDiscovery(db, row.id, fetcher));
  }

  return {
    results,
    totals: {
      sources: results.length,
      fetched: results.reduce((sum, item) => sum + item.fetched, 0),
      created: results.reduce((sum, item) => sum + item.created, 0),
      updated: results.reduce((sum, item) => sum + item.updated, 0),
      duplicates: results.reduce((sum, item) => sum + item.duplicates, 0),
      skipped: results.reduce((sum, item) => sum + item.skipped, 0),
      errors: results.filter((item) => item.status === "error").length,
    },
  };
}

export function getAcquisitionSummary(db: BetterSqlite3.Database, limit = 20): AcquisitionSummary {
  initializeOpportunityAcquisitionSchema(db);
  if (!Number.isInteger(limit) || limit <= 0 || limit > 100) throw new Error("limit must be between 1 and 100");

  const counts = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM opportunity_sources) AS source_count,
      (SELECT COUNT(*) FROM opportunity_sources WHERE enabled = 1) AS enabled_source_count,
      (SELECT COUNT(*) FROM opportunity_imports) AS import_count,
      (SELECT COUNT(DISTINCT opportunity_id) FROM opportunity_imports WHERE opportunity_id IS NOT NULL) AS linked_count
  `).get() as any;

  const imports = db.prepare(`
    SELECT oi.*, os.name AS source_name, os.type AS source_type
    FROM opportunity_imports oi
    JOIN opportunity_sources os ON os.id = oi.source_id
    ORDER BY oi.last_seen_at DESC
    LIMIT ?
  `).all(limit) as any[];

  return {
    generatedAt: new Date().toISOString(),
    sourceCount: Number(counts.source_count ?? 0),
    enabledSourceCount: Number(counts.enabled_source_count ?? 0),
    importCount: Number(counts.import_count ?? 0),
    linkedOpportunityCount: Number(counts.linked_count ?? 0),
    recentImports: imports.map(serializeImport),
    sources: listOpportunitySources(db),
  };
}

async function fetchSourceCandidates(
  source: OpportunitySourceRow,
  config: Record<string, unknown>,
  fetcher: AcquisitionFetch,
): Promise<NormalizedCandidate[]> {
  if (source.type === "0xwork") return fetch0xWorkCandidates(config, fetcher);
  return fetchGitHubIssueCandidates(config, fetcher);
}

async function fetch0xWorkCandidates(
  config: Record<string, unknown>,
  fetcher: AcquisitionFetch,
): Promise<NormalizedCandidate[]> {
  const payload = await fetchJson(SOURCE_ENDPOINTS["0xwork"], fetcher, {
    Accept: "application/json",
    "User-Agent": "conway-automaton-opportunity-acquisition/1.0",
  });
  const tasks = extractArray(payload, ["tasks", "items", "data"]);
  const maxResults = boundedInteger(config.maxResults, 50, 1, MAX_RESULTS);
  const minBountyUsd = nonNegativeNumber(config.minBountyUsd, 0);
  const maxBountyUsd = nonNegativeNumber(config.maxBountyUsd, 10_000);
  const includePhysical = config.includePhysical === true;
  const allowSafetyFlagged = config.allowSafetyFlagged === true;
  const capabilities = stringArray(config.capabilities).map((item) => item.toLowerCase());
  const result: NormalizedCandidate[] = [];

  for (const raw of tasks) {
    if (result.length >= maxResults) break;
    if (!raw || typeof raw !== "object") continue;
    const task = raw as Record<string, unknown>;
    const status = String(task.status ?? "open").toLowerCase();
    if (["closed", "completed", "cancelled", "canceled", "expired"].includes(status)) continue;

    const category = cleanText(task.category ?? task.capability ?? task.type ?? "", 128);
    if (!includePhysical && /physical|irl/i.test(category)) continue;
    if (capabilities.length > 0 && category && !capabilities.includes(category.toLowerCase())) continue;

    const safetyFlags = normalizeSafetyFlags(task.safetyFlags ?? task.safety_flags ?? task.flags);
    if (!allowSafetyFlagged && safetyFlags.length > 0) continue;

    const bountyUsd = read0xWorkBountyUsd(task);
    if (bountyUsd === null || bountyUsd < minBountyUsd || bountyUsd > maxBountyUsd) continue;

    const externalId = cleanText(task.chainTaskId ?? task.chain_task_id ?? task.id ?? "", 128);
    const externalSource = `0xwork-${createFingerprint(externalId || "unknown").slice(0, 16)}`;
    const title = cleanExternalText(task.title ?? task.name ?? `0xWork task ${externalId}`, 500, externalSource);
    if (!externalId || !title) continue;

    const description = cleanExternalText(task.description ?? task.details ?? task.body ?? "", MAX_DESCRIPTION_CHARS, externalSource);
    const deadlineRaw = task.deadline ?? task.deadlineAt ?? task.deadline_at;
    const deadlineDays = daysUntil(deadlineRaw, 7);
    if (deadlineDays < 0) continue;

    const rewardCents = Math.round(bountyUsd * 100);
    const explicitStakeUsd = firstFiniteNumber(task.stakeUsd, task.stake_usd, task.collateralUsd, task.collateral_usd);
    const capitalAtRiskCents = Math.round((explicitStakeUsd ?? bountyUsd * 0.1) * 100);
    const url = `https://www.0xwork.org/tasks/${encodeURIComponent(externalId)}`;
    const poster = cleanText(task.posterName ?? task.poster ?? task.posterAddress ?? task.poster_address ?? "0xWork task poster", 256);

    result.push({
      externalId,
      externalUrl: url,
      title,
      description,
      revenueMechanism: "Complete an escrow-backed 0xWork task and receive its stated USDC bounty after acceptance.",
      targetBuyer: poster,
      demandEvidence: `Open 0xWork task${category ? ` in ${category}` : ""} with a stated ${bountyUsd.toFixed(2)} USDC bounty.`,
      estimatedRevenueCents: rewardCents,
      estimatedBuildCostCents: 0,
      estimatedRecurringCostCents: 0,
      capitalAtRiskCents,
      successProbability: unitNumber(config.successProbability, 0.3),
      riskScore: unitNumber(config.riskScore, 0.55),
      timeToRevenueDays: Math.max(0, Math.min(deadlineDays, 30)),
      learningValue: 0.25,
      competitionNotes: cleanText(task.claimCount ?? task.claim_count ?? task.applications ?? "", 256),
      legalEthicalNotes:
        "External marketplace opportunity. Verify task legality, authorization, deliverable/IP terms, current escrow, collateral requirement, and platform terms before accepting. Discovery does not authorize claiming or staking funds.",
      metadata: {
        acquisitionSourceType: "0xwork",
        category,
        deadline: deadlineRaw ?? null,
        bountyUsd,
        safetyFlags,
        stakeRequirement: task.stakeRequired ?? task.stake_required ?? null,
        taskScope: task.scope ?? null,
        externalDescription: description,
        externalUntrusted: true,
      },
      raw,
    });
  }
  return result;
}

async function fetchGitHubIssueCandidates(
  config: Record<string, unknown>,
  fetcher: AcquisitionFetch,
): Promise<NormalizedCandidate[]> {
  const repositories = validateRepositories(config.repositories);
  const labels = stringArray(config.labels).slice(0, 10);
  const searchTerms = cleanSearchTerms(config.searchTerms);
  const maxResults = boundedInteger(config.maxResults, 50, 1, MAX_RESULTS);
  const maxRewardUsd = nonNegativeNumber(config.maxRewardUsd, 50_000);
  const provider = cleanText(config.provider ?? "GitHub", 128) || "GitHub";
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "conway-automaton-opportunity-acquisition/1.0",
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  const result: NormalizedCandidate[] = [];
  for (const repository of repositories) {
    if (result.length >= maxResults) break;
    const qualifiers = [
      `repo:${repository}`,
      "is:issue",
      "is:open",
      ...labels.map((label) => `label:\"${label.replace(/\"/g, "")}\"`),
      searchTerms,
    ].filter(Boolean).join(" ");
    const remaining = maxResults - result.length;
    const url = `${SOURCE_ENDPOINTS.github_issues}?q=${encodeURIComponent(qualifiers)}&sort=updated&order=desc&per_page=${Math.min(remaining, 100)}`;
    const payload = await fetchJson(url, fetcher, headers);
    const issues = extractArray(payload, ["items"]);

    for (const raw of issues) {
      if (result.length >= maxResults) break;
      if (!raw || typeof raw !== "object") continue;
      const issue = raw as Record<string, unknown>;
      if (issue.pull_request) continue;
      const number = Number(issue.number);
      if (!Number.isInteger(number) || number <= 0) continue;
      const externalSource = `github-${createFingerprint(`${repository}#${number}`).slice(0, 16)}`;
      const title = cleanExternalText(issue.title ?? "", 500, externalSource);
      const body = cleanExternalText(issue.body ?? "", MAX_DESCRIPTION_CHARS, externalSource);
      const externalUrl = cleanText(issue.html_url ?? `https://github.com/${repository}/issues/${number}`, 2_048);
      if (!title || !externalUrl) continue;

      const rewardUsd = parseUsdAmount(`${title}\n${body}`, maxRewardUsd);
      const labelsFromIssue = Array.isArray(issue.labels)
        ? issue.labels.map((label: any) => typeof label === "string" ? label : String(label?.name ?? "")).filter(Boolean).slice(0, 20)
        : [];
      const comments = Number(issue.comments ?? 0);
      const rewardEvidence = rewardUsd !== null
        ? `Issue states an explicit USD/USDC-denominated reward of approximately $${rewardUsd.toFixed(2)}.`
        : "Configured repository has an open matching issue, but no trusted USD/USDC reward amount could be parsed.";

      result.push({
        externalId: `${repository}#${number}`,
        externalUrl,
        title,
        description: body,
        revenueMechanism: `Complete an explicitly configured GitHub issue/bounty and receive payment through the maintainer's stated ${provider} process.`,
        targetBuyer: repository,
        demandEvidence: `${rewardEvidence} Repository is owner-configured; issue currently open with ${comments} comment(s).`,
        estimatedRevenueCents: rewardUsd === null ? 0 : Math.round(rewardUsd * 100),
        estimatedBuildCostCents: 0,
        estimatedRecurringCostCents: 0,
        capitalAtRiskCents: 0,
        successProbability: unitNumber(config.successProbability, rewardUsd === null ? 0.15 : 0.25),
        riskScore: unitNumber(config.riskScore, rewardUsd === null ? 0.45 : 0.35),
        timeToRevenueDays: boundedInteger(config.timeToRevenueDays, 14, 0, 365),
        learningValue: unitNumber(config.learningValue, 0.25),
        competitionNotes: `${comments} issue comment(s); labels: ${labelsFromIssue.join(", ") || "none"}.`,
        legalEthicalNotes:
          "External GitHub opportunity from an owner-configured repository. Verify maintainer authorization, payout mechanism, acceptance criteria, contributor/IP terms, and whether work is still available before making any commitment.",
        metadata: {
          acquisitionSourceType: "github_issues",
          provider,
          repository,
          issueNumber: number,
          labels: labelsFromIssue,
          comments,
          authorAssociation: issue.author_association ?? null,
          createdAt: issue.created_at ?? null,
          updatedAt: issue.updated_at ?? null,
          externalDescription: body,
          externalUntrusted: true,
        },
        raw,
      });
    }
  }
  return result;
}

function importCandidate(
  db: BetterSqlite3.Database,
  source: OpportunitySourceRow,
  candidate: NormalizedCandidate,
): "created" | "updated" | "duplicate" | "skipped" {
  const now = new Date().toISOString();
  const fingerprint = createFingerprint(candidate.externalUrl || `${source.id}:${candidate.externalId}`);
  const normalizedJson = boundedJson(candidate, MAX_RAW_JSON_CHARS);
  const rawJson = boundedJson(candidate.raw, MAX_RAW_JSON_CHARS);

  const existingImport = db.prepare(`
    SELECT * FROM opportunity_imports WHERE source_id = ? AND external_id = ?
  `).get(source.id, candidate.externalId) as any | undefined;

  if (existingImport) {
    db.prepare(`
      UPDATE opportunity_imports
      SET external_url = ?, fingerprint = ?, raw_json = ?, normalized_json = ?, last_seen_at = ?
      WHERE id = ?
    `).run(candidate.externalUrl, fingerprint, rawJson, normalizedJson, now, existingImport.id);

    if (existingImport.opportunity_id) {
      const opportunity = getBusinessOpportunity(db, existingImport.opportunity_id) as any;
      if (opportunity && ["discovered", "researching", "scored"].includes(opportunity.status)) {
        updateBusinessOpportunity(db, existingImport.opportunity_id, candidateToOpportunityInput(candidate, source));
        scoreBusinessOpportunity(db, existingImport.opportunity_id);
      }
    }
    return "updated";
  }

  const duplicate = db.prepare(`
    SELECT opportunity_id FROM opportunity_imports
    WHERE fingerprint = ? AND opportunity_id IS NOT NULL
    ORDER BY first_seen_at ASC LIMIT 1
  `).get(fingerprint) as { opportunity_id: string } | undefined;

  if (duplicate?.opportunity_id) {
    db.prepare(`
      INSERT INTO opportunity_imports (
        id, source_id, external_id, external_url, fingerprint, opportunity_id,
        raw_json, normalized_json, import_status, first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'duplicate', ?, ?)
    `).run(
      ulid(), source.id, candidate.externalId, candidate.externalUrl, fingerprint,
      duplicate.opportunity_id, rawJson, normalizedJson, now, now,
    );
    return "duplicate";
  }

  const opportunity = createBusinessOpportunity(db, candidateToOpportunityInput(candidate, source));
  const opportunityId = String(opportunity.id);
  scoreBusinessOpportunity(db, opportunityId);
  db.prepare(`
    INSERT INTO opportunity_imports (
      id, source_id, external_id, external_url, fingerprint, opportunity_id,
      raw_json, normalized_json, import_status, first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'linked', ?, ?)
  `).run(
    ulid(), source.id, candidate.externalId, candidate.externalUrl, fingerprint,
    opportunityId, rawJson, normalizedJson, now, now,
  );
  return "created";
}

function candidateToOpportunityInput(candidate: NormalizedCandidate, source: OpportunitySourceRow) {
  return {
    title: candidate.title,
    revenueMechanism: candidate.revenueMechanism,
    targetBuyer: candidate.targetBuyer,
    demandEvidence: candidate.demandEvidence,
    estimatedRevenueCents: candidate.estimatedRevenueCents,
    estimatedBuildCostCents: candidate.estimatedBuildCostCents,
    estimatedRecurringCostCents: candidate.estimatedRecurringCostCents,
    capitalAtRiskCents: candidate.capitalAtRiskCents,
    successProbability: candidate.successProbability,
    riskScore: candidate.riskScore,
    timeToRevenueDays: candidate.timeToRevenueDays,
    learningValue: candidate.learningValue,
    competitionNotes: candidate.competitionNotes,
    legalEthicalNotes: candidate.legalEthicalNotes,
    source: source.name,
    metadata: {
      ...candidate.metadata,
      acquisitionSourceId: source.id,
      acquisitionSourceType: source.type,
      externalId: candidate.externalId,
      externalUrl: candidate.externalUrl,
      discoveredViaReadOnlyAcquisition: true,
    },
  };
}

async function fetchJson(
  url: string,
  fetcher: AcquisitionFetch,
  headers: Record<string, string>,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_FETCH_TIMEOUT_MS);
  try {
    const response = await fetcher(url, { method: "GET", headers, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""} from ${new URL(url).host}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function validateSourceConfig(type: OpportunitySourceType, config: Record<string, unknown>, enabled: boolean): void {
  const maxResults = config.maxResults ?? 50;
  boundedInteger(maxResults, 50, 1, MAX_RESULTS);
  if (type === "0xwork") {
    const capabilities = stringArray(config.capabilities);
    if (capabilities.length > 20) throw new Error("0xWork capabilities cannot exceed 20 values");
    nonNegativeNumber(config.minBountyUsd, 0);
    nonNegativeNumber(config.maxBountyUsd, 10_000);
    unitNumber(config.successProbability, 0.3);
    unitNumber(config.riskScore, 0.55);
    return;
  }

  const repositories = validateRepositories(config.repositories, !enabled);
  if (enabled && repositories.length === 0) {
    throw new Error("Enabled GitHub opportunity source requires at least one explicitly configured repository");
  }
  stringArray(config.labels).slice(0, 10);
  cleanSearchTerms(config.searchTerms);
  nonNegativeNumber(config.maxRewardUsd, 50_000);
  unitNumber(config.successProbability, 0.25);
  unitNumber(config.riskScore, 0.35);
  unitNumber(config.learningValue, 0.25);
  boundedInteger(config.timeToRevenueDays, 14, 0, 365);
}

function validateRepositories(value: unknown, allowEmpty = false): string[] {
  const repositories = stringArray(value);
  if (!allowEmpty && repositories.length === 0) throw new Error("repositories must contain at least one owner/repo entry");
  if (repositories.length > MAX_GITHUB_REPOSITORIES) {
    throw new Error(`repositories cannot exceed ${MAX_GITHUB_REPOSITORIES}`);
  }
  for (const repository of repositories) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
      throw new Error(`Invalid GitHub repository: ${repository}`);
    }
  }
  return [...new Set(repositories)];
}

function defaultConfigForType(type: OpportunitySourceType): Record<string, unknown> {
  if (type === "0xwork") return { ...DEFAULT_0XWORK_CONFIG };
  return {
    repositories: [],
    labels: ["bounty"],
    searchTerms: "",
    maxResults: 50,
    maxRewardUsd: 50_000,
    successProbability: 0.25,
    riskScore: 0.35,
    learningValue: 0.25,
    timeToRevenueDays: 14,
    provider: "GitHub",
  };
}

function riskNotesForType(type: OpportunitySourceType): string {
  if (type === "0xwork") {
    return "Read-only discovery is separated from claiming. Claims may require collateral and expose funds to smart-contract, platform, dispute, token-liquidity, and slashing risk.";
  }
  return "Only repositories explicitly configured by the owner are queried. A GitHub issue is evidence of demand, not proof that payment is valid, funded, available, or guaranteed.";
}

function serializeSource(row: OpportunitySourceRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    enabled: Boolean(row.enabled),
    endpoint: row.endpoint,
    config: safeJson(row.config_json),
    riskNotes: row.risk_notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSyncAt: row.last_sync_at,
    lastSuccessAt: row.last_success_at,
    lastError: row.last_error,
    consecutiveFailures: row.consecutive_failures,
  };
}

function serializeImport(row: any): Record<string, unknown> {
  return {
    id: row.id,
    sourceId: row.source_id,
    sourceName: row.source_name,
    sourceType: row.source_type,
    externalId: row.external_id,
    externalUrl: row.external_url,
    opportunityId: row.opportunity_id,
    importStatus: row.import_status,
    normalized: safeJson(row.normalized_json),
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

function extractArray(payload: unknown, keys: string[]): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  const object = payload as Record<string, unknown>;
  for (const key of keys) {
    if (Array.isArray(object[key])) return object[key] as unknown[];
  }
  return [];
}

function normalizeSourceId(raw: string): string {
  const value = raw?.trim().toLowerCase();
  if (!value || !/^[a-z0-9][a-z0-9._-]{1,63}$/.test(value)) {
    throw new Error("id must be 2-64 lowercase letters, numbers, dots, underscores, or hyphens");
  }
  return value;
}

function cleanExternalText(value: unknown, maxLength: number, source: string): string {
  if (value === null || value === undefined) return "";
  const raw = String(value);
  const sanitized = sanitizeInput(raw, source, "social_message");
  if (sanitized.blocked) return "[External content blocked by injection defense]";
  return sanitizeToolResult(sanitized.content, maxLength).trim();
}

function cleanText(value: unknown, maxLength: number): string {
  if (value === null || value === undefined) return "";
  return sanitizeToolResult(String(value), maxLength).trim();
}

function cleanSearchTerms(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length > 200) throw new Error("searchTerms cannot exceed 200 characters");
  if (/\b(repo|org|user):/i.test(text)) {
    throw new Error("searchTerms must not add repo/org/user qualifiers; use the explicit repositories allowlist");
  }
  return text.replace(/[\r\n\t]+/g, " ");
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeSafetyFlags(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => cleanText(item, 256)).filter(Boolean);
  if (typeof value === "string" && value.trim()) return [cleanText(value, 512)];
  return [];
}

function read0xWorkBountyUsd(task: Record<string, unknown>): number | null {
  const micro = firstFiniteNumber(task.bountyMicroUsdc, task.bounty_micro_usdc, task.rewardMicroUsdc, task.reward_micro_usdc);
  if (micro !== null) return micro / 1_000_000;
  const direct = firstFiniteNumber(task.bountyUsd, task.bounty_usd, task.bountyUSDC, task.rewardUsd, task.reward_usd, task.bounty, task.reward);
  if (direct === null || direct < 0 || direct > 1_000_000) return null;
  return direct;
}

function firstFiniteNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value.replace(/[$,]/g, ""));
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function parseUsdAmount(text: string, ceilingUsd: number): number | null {
  const matches: number[] = [];
  const patterns = [
    /\$\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/g,
    /\b([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*(?:USD|USDC)\b/gi,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = Number(match[1].replace(/,/g, ""));
      if (Number.isFinite(value) && value > 0 && value <= ceilingUsd) matches.push(value);
    }
  }
  if (matches.length === 0) return null;
  return Math.max(...matches);
}

function createFingerprint(value: string): string {
  return createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
}

function boundedJson(value: unknown, maxLength: number): string {
  let encoded: string;
  try {
    encoded = JSON.stringify(value ?? {});
  } catch {
    encoded = JSON.stringify({ serializationError: true });
  }
  if (encoded.length <= maxLength) return encoded;
  const previewLength = Math.max(256, Math.floor(maxLength / 2));
  return JSON.stringify({ truncated: true, preview: encoded.slice(0, previewLength) });
}

function safeJson(raw: string | undefined): Record<string, any> {
  try {
    const parsed = JSON.parse(raw ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function nonNegativeNumber(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error("Expected a non-negative finite number");
  return number;
}

function unitNumber(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) throw new Error("Expected a number between 0 and 1");
  return number;
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined || value === null) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`Expected an integer between ${min} and ${max}`);
  }
  return number;
}

function daysUntil(value: unknown, fallback: number): number {
  if (!value) return fallback;
  const timestamp = new Date(String(value)).getTime();
  if (!Number.isFinite(timestamp)) return fallback;
  return Math.ceil((timestamp - Date.now()) / 86_400_000);
}
