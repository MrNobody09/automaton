import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const SECRET_KEY_PATTERN = /(api.?key|private.?key|secret|token|password|credential)/i;

function sanitize(value: unknown, key = ""): unknown {
  if (SECRET_KEY_PATTERN.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [
        childKey,
        sanitize(childValue, childKey),
      ]),
    );
  }
  return value;
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

function copyIfPresent(source: string, destination: string): void {
  if (!fs.existsSync(source)) return;
  fs.cpSync(source, destination, { recursive: true, dereference: false });
}

export interface ProductionBackupOptions {
  stateDir?: string;
  backupRoot?: string;
  now?: Date;
}

export async function createProductionBackup(options: ProductionBackupOptions = {}): Promise<string> {
  const stateDir = options.stateDir ?? process.env.AUTOMATON_STATE_DIR ?? path.join(os.homedir(), ".automaton");
  const backupRoot = options.backupRoot ?? process.env.AUTOMATON_BACKUP_DIR ?? "/var/backups/automaton";
  const now = options.now ?? new Date();
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const destination = path.join(backupRoot, stamp);
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });

  const configPath = path.join(stateDir, "automaton.json");
  let config: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    config = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(
      path.join(destination, "automaton.json"),
      JSON.stringify(sanitize(config), null, 2),
      { mode: 0o600 },
    );
  }

  const dbPath = resolveStatePath(
    typeof config.dbPath === "string" ? config.dbPath : undefined,
    stateDir,
    "state.db",
  );
  if (!fs.existsSync(dbPath)) throw new Error(`state database not found at ${dbPath}`);
  const db = new Database(dbPath, { readonly: true });
  try {
    await db.backup(path.join(destination, "state.db"));
  } finally {
    db.close();
  }

  const heartbeatPath = resolveStatePath(
    typeof config.heartbeatConfigPath === "string" ? config.heartbeatConfigPath : undefined,
    stateDir,
    "heartbeat.yml",
  );
  copyIfPresent(heartbeatPath, path.join(destination, "heartbeat.yml"));
  copyIfPresent(path.join(stateDir, "SOUL.md"), path.join(destination, "SOUL.md"));
  copyIfPresent(path.join(stateDir, "constitution.md"), path.join(destination, "constitution.md"));
  copyIfPresent(path.join(stateDir, "skills"), path.join(destination, "skills"));

  const manifest = {
    createdAt: now.toISOString(),
    sourceStateDir: stateDir,
    excluded: ["wallet.json", "config.json", "raw secret-bearing environment files"],
    redactedConfigFields: "keys matching api-key/private-key/secret/token/password/credential patterns",
    note: "Restore wallet/API credentials separately from encrypted secret recovery material.",
  };
  fs.writeFileSync(path.join(destination, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  return destination;
}
