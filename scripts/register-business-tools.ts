import os from "node:os";
import path from "node:path";
import { createDatabase } from "../src/state/database.js";
import { createBusinessTools } from "../src/business/tools.js";
import { createBusinessIntelligenceTools } from "../src/business/intelligence-tools.js";

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

const dbPath = expandHome(process.env.AUTOMATON_DB_PATH || "~/.automaton/state.db");
const db = createDatabase(dbPath);
const node = process.execPath;

const toolGroups = [
  {
    tools: createBusinessTools(),
    cliPath: path.resolve(process.cwd(), "dist/business/cli.js"),
  },
  {
    tools: createBusinessIntelligenceTools(),
    cliPath: path.resolve(process.cwd(), "dist/business/intelligence-cli.js"),
  },
];

let registered = 0;
for (const group of toolGroups) {
  for (const tool of group.tools) {
    db.installTool({
      id: `business:${tool.name}`,
      name: tool.name,
      type: "custom",
      config: {
        command: `${JSON.stringify(node)} ${JSON.stringify(group.cliPath)} ${tool.name}`,
        parameters: tool.parameters,
        category: tool.category,
        riskLevel: tool.riskLevel,
      },
      installedAt: new Date().toISOString(),
      enabled: true,
    });
    registered++;
  }
}

db.close();
console.log(`Registered ${registered} business tools in ${dbPath}`);
