import { createProductionBackup } from "./backup.js";

try {
  const destination = await createProductionBackup();
  console.log(destination);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
