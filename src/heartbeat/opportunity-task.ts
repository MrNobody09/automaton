import type { HeartbeatTaskFn } from "../types.js";
import { runEnabledOpportunityDiscovery } from "../business/acquisition.js";

export const OPPORTUNITY_DISCOVERY_TASK_NAME = "opportunity_discovery";

export const opportunityDiscoveryTask: HeartbeatTaskFn = async (_ctx, taskCtx) => {
  const result = await runEnabledOpportunityDiscovery(taskCtx.db.raw);
  taskCtx.db.setKV(
    "business.latest_opportunity_discovery",
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      totals: result.totals,
      results: result.results,
    }),
  );

  const newCount = result.totals.created ?? 0;
  const errorCount = result.totals.errors ?? 0;
  if (newCount === 0 && errorCount === 0) return { shouldWake: false };

  const details = [
    newCount > 0 ? `${newCount} new opportunity${newCount === 1 ? "" : "ies"} discovered.` : "",
    errorCount > 0 ? `${errorCount} source${errorCount === 1 ? "" : "s"} failed and should be reviewed.` : "",
    "Review scored opportunities before making any external commitment or allocating capital.",
  ].filter(Boolean).join(" ");

  return {
    shouldWake: true,
    message: `Opportunity discovery update. ${details}`,
  };
};
