import { runProductionHealth } from "./health.js";

const result = runProductionHealth();
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
