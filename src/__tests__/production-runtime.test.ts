import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase } from "../state/database.js";
import { runProductionHealth } from "../production/health.js";
import { createProductionBackup } from "../production/backup.js";
import { loadInstalledTools } from "../agent/tools.js";
import { assertChildCapacity } from "../replication/spawn.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automaton-production-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function seedHealthyState(stateDir: string): void {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "automaton.json"),
    JSON.stringify({
      dbPath: "~/.automaton/state.db",
      heartbeatConfigPath: "~/.automaton/heartbeat.yml",
      conwayApiKey: "must-not-leak",
      nested: { token: "also-secret", ordinary: "keep-me" },
    }),
    { mode: 0o600 },
  );
  fs.writeFileSync(path.join(stateDir, "wallet.json"), JSON.stringify({ privateKey: "0xsecret" }), { mode: 0o600 });
  fs.writeFileSync(path.join(stateDir, "heartbeat.yml"), "entries: []\n", { mode: 0o600 });
  const db = createDatabase(path.join(stateDir, "state.db"));
  db.setAgentState("sleeping");
  db.close();
}

describe("production health", () => {
  it("validates a healthy private state directory without exposing credentials", () => {
    const stateDir = tempDir();
    seedHealthyState(stateDir);

    const result = runProductionHealth({ stateDir });

    expect(result.ok).toBe(true);
    expect(result.agentState).toBe("sleeping");
    expect(JSON.stringify(result)).not.toContain("0xsecret");
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
  });

  it("rejects permissive wallet permissions", () => {
    const stateDir = tempDir();
    seedHealthyState(stateDir);
    fs.chmodSync(path.join(stateDir, "wallet.json"), 0o644);

    const result = runProductionHealth({ stateDir });
    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.name === "wallet")?.ok).toBe(false);
  });
});

describe("production backup", () => {
  it("creates a consistent state backup while excluding wallet material and redacting secrets", async () => {
    const stateDir = tempDir();
    const backupRoot = tempDir();
    seedHealthyState(stateDir);
    fs.mkdirSync(path.join(stateDir, "skills"));
    fs.writeFileSync(path.join(stateDir, "skills", "example.txt"), "skill");

    const destination = await createProductionBackup({
      stateDir,
      backupRoot,
      now: new Date("2026-09-19T12:00:00.000Z"),
    });

    expect(fs.existsSync(path.join(destination, "state.db"))).toBe(true);
    expect(fs.existsSync(path.join(destination, "wallet.json"))).toBe(false);
    expect(fs.existsSync(path.join(destination, "skills", "example.txt"))).toBe(true);

    const sanitized = JSON.parse(fs.readFileSync(path.join(destination, "automaton.json"), "utf8"));
    expect(sanitized.conwayApiKey).toBe("[REDACTED]");
    expect(sanitized.nested.token).toBe("[REDACTED]");
    expect(sanitized.nested.ordinary).toBe("keep-me");
  });
});

describe("runtime safety integration", () => {
  it("preserves installed financial tool category and risk metadata", () => {
    const tools = loadInstalledTools({
      getInstalledTools: () => [{
        id: "business:test",
        name: "record_business_cost",
        type: "custom",
        config: {
          category: "financial",
          riskLevel: "dangerous",
          parameters: { type: "object", properties: {} },
        },
        installedAt: new Date().toISOString(),
        enabled: true,
      }],
    });

    expect(tools[0].category).toBe("financial");
    expect(tools[0].riskLevel).toBe("dangerous");
  });

  it("enforces an explicit zero-child production cap", () => {
    expect(() => assertChildCapacity([], 0)).toThrow(/max children \(0\)/);
  });

  it("counts only active children toward the replication cap", () => {
    expect(() => assertChildCapacity([
      { status: "dead" } as any,
      { status: "failed" } as any,
    ], 1)).not.toThrow();
  });
});
