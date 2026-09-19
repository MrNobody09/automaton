import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDatabase } from "../state/database.js";

export interface ProductionHealthCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ProductionHealthResult {
  ok: boolean;
  stateDir: string;
  checks: ProductionHealthCheck[];
  agentState?: string;
}

export interface ProductionHealthOptions {
  stateDir?: string;
}

function resolveStatePath(configuredPath: string | undefined, stateDir: string, fallbackName: string): string {
  if (!configuredPath) return path.join(stateDir, fallbackName);
  if (configuredPath === "~/.automaton") return stateDir;
  if (configuredPath.startsWith("~/.automaton/")) {
    return path.join(stateDir, configuredPath.slice("~/.automaton/".length));
  }
  if (configuredPath.startsWith("~/")) {
    return path.join(os.homedir(), configuredPath.slice(2));
  }
  return configuredPath;
}

function filePermissionsArePrivate(filePath: string): boolean {
  const mode = fs.statSync(filePath).mode & 0o777;
  return (mode & 0o077) === 0;
}

export function runProductionHealth(options: ProductionHealthOptions = {}): ProductionHealthResult {
  const stateDir = options.stateDir ?? process.env.AUTOMATON_STATE_DIR ?? path.join(os.homedir(), ".automaton");
  const checks: ProductionHealthCheck[] = [];
  let config: Record<string, unknown> | undefined;
  let agentState: string | undefined;

  const configPath = path.join(stateDir, "automaton.json");
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    checks.push({ name: "config", ok: true, detail: "automaton.json is present and valid JSON" });
  } catch (error) {
    checks.push({
      name: "config",
      ok: false,
      detail: `automaton.json unavailable or invalid: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  const walletPath = path.join(stateDir, "wallet.json");
  try {
    if (!fs.existsSync(walletPath)) throw new Error("wallet.json is missing");
    if (!filePermissionsArePrivate(walletPath)) {
      throw new Error("wallet.json must not be readable or writable by group/other users");
    }
    checks.push({ name: "wallet", ok: true, detail: "wallet.json exists with private permissions" });
  } catch (error) {
    checks.push({
      name: "wallet",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  const configuredDbPath = typeof config?.dbPath === "string" ? config.dbPath : undefined;
  const dbPath = resolveStatePath(configuredDbPath, stateDir, "state.db");
  try {
    if (!fs.existsSync(dbPath)) throw new Error(`database is missing at ${dbPath}`);
    const db = createDatabase(dbPath);
    try {
      const integrity = db.raw.pragma("integrity_check") as Array<{ integrity_check: string }>;
      if (integrity[0]?.integrity_check !== "ok") {
        throw new Error("SQLite integrity_check did not return ok");
      }
      agentState = db.getAgentState();
    } finally {
      db.close();
    }
    checks.push({ name: "database", ok: true, detail: "state.db opened successfully and passed integrity_check" });
  } catch (error) {
    checks.push({
      name: "database",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  const heartbeatPath = resolveStatePath(
    typeof config?.heartbeatConfigPath === "string" ? config.heartbeatConfigPath : undefined,
    stateDir,
    "heartbeat.yml",
  );
  checks.push({
    name: "heartbeat_config",
    ok: fs.existsSync(heartbeatPath),
    detail: fs.existsSync(heartbeatPath) ? "heartbeat configuration is present" : `heartbeat configuration is missing at ${heartbeatPath}`,
  });

  return {
    ok: checks.every((check) => check.ok),
    stateDir,
    checks,
    agentState,
  };
}
