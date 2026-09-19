import os from "node:os";
import path from "node:path";
import { createDatabase } from "../src/state/database.js";
import { createBusinessTools } from "../src/business/tools.js";

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

const dbPath = expandHome(process.env.AUTOMATON_DB_PATH || "~/.automaton/state.db");
const db = createDatabase(dbPath);
const cliPath = path.resolve(process.cwd(), "dist/business/cli.js");
const node = process.execPath;

const tools = createBusinessTools();

for (const tool of tools) {
  db.installTool({
    id: `business:${tool.name}`,
    name: tool.name,
    type: "custom",
    config: {
      command: `${JSON.stringify(node)} ${JSON.stringify(cliPath)} ${tool.name}`,
      parameters: tool.parameters,
    },
    installedAt: new Date().toISOString(),
    enabled: true,
  });
}

db.close();
console.log(`Registered ${tools.length} business tools in ${dbPath}`);
