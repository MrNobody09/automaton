#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  configureOpportunitySource,
  getAcquisitionSummary,
  initializeOpportunityAcquisitionSchema,
  listOpportunitySources,
  runEnabledOpportunityDiscovery,
  runOpportunityDiscovery,
} from "./acquisition.js";

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function parseArgs(raw?: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid tool arguments JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`);
  return value;
}

const toolName = process.argv[2];
const args = parseArgs(process.argv[3]);
const dbPath = expandHome(process.env.AUTOMATON_DB_PATH || "~/.automaton/state.db");
const db = new Database(dbPath);
db.pragma("foreign_keys = ON");
initializeOpportunityAcquisitionSchema(db);

try {
  let result: unknown;
  switch (toolName) {
    case "configure_opportunity_source":
      result = configureOpportunitySource(db, {
        id: requireString(args, "id"),
        name: requireString(args, "name"),
        type: requireString(args, "type") as any,
        enabled: args.enabled as boolean | undefined,
        config: args.config as Record<string, unknown> | undefined,
      });
      break;
    case "list_opportunity_sources":
      result = listOpportunitySources(db);
      break;
    case "discover_opportunities":
      result = await runOpportunityDiscovery(db, requireString(args, "source_id"));
      break;
    case "discover_all_opportunities":
      result = await runEnabledOpportunityDiscovery(db);
      break;
    case "get_acquisition_summary":
      result = getAcquisitionSummary(db, (args.limit as number | undefined) ?? 20);
      break;
    default:
      throw new Error(`Unknown opportunity acquisition tool: ${toolName}`);
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  db.close();
}
