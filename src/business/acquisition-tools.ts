import type { AutomatonTool } from "../types.js";
import {
  configureOpportunitySource,
  getAcquisitionSummary,
  listOpportunitySources,
  runEnabledOpportunityDiscovery,
  runOpportunityDiscovery,
} from "./acquisition.js";

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function createOpportunityAcquisitionTools(): AutomatonTool[] {
  return [
    {
      name: "configure_opportunity_source",
      description:
        "Create or update a read-only opportunity discovery source. GitHub sources require explicit owner/repo allowlists; enabling a source authorizes discovery only, not claiming or applying for work.",
      category: "financial",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          type: { type: "string", enum: ["0xwork", "github_issues"] },
          enabled: { type: "boolean" },
          config: { type: "object" },
        },
        required: ["id", "name", "type"],
      },
      execute: async (args, ctx) =>
        json(
          configureOpportunitySource(ctx.db.raw, {
            id: args.id as string,
            name: args.name as string,
            type: args.type as any,
            enabled: args.enabled as boolean | undefined,
            config: args.config as Record<string, unknown> | undefined,
          }),
        ),
    },
    {
      name: "list_opportunity_sources",
      description:
        "List configured opportunity discovery sources, sync health, risk notes, and configuration. Does not make network requests.",
      category: "financial",
      riskLevel: "safe",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => json(listOpportunitySources(ctx.db.raw)),
    },
    {
      name: "discover_opportunities",
      description:
        "Run read-only discovery for one configured source, normalize and deduplicate results, and score new opportunities. This never claims work, submits applications, or stakes funds.",
      category: "financial",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: { source_id: { type: "string" } },
        required: ["source_id"],
      },
      execute: async (args, ctx) =>
        json(await runOpportunityDiscovery(ctx.db.raw, args.source_id as string)),
    },
    {
      name: "discover_all_opportunities",
      description:
        "Run read-only discovery across all enabled opportunity sources. Source failures are isolated and reported instead of aborting the full discovery cycle.",
      category: "financial",
      riskLevel: "caution",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => json(await runEnabledOpportunityDiscovery(ctx.db.raw)),
    },
    {
      name: "get_acquisition_summary",
      description:
        "Show opportunity acquisition source health, recent imports, provenance, and linked business opportunities without making network requests.",
      category: "financial",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: { limit: { type: "number", description: "1 to 100, default 20" } },
      },
      execute: async (args, ctx) =>
        json(getAcquisitionSummary(ctx.db.raw, (args.limit as number | undefined) ?? 20)),
    },
  ];
}
