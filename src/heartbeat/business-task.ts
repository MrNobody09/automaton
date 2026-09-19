import type { HeartbeatTaskFn } from "../types.js";
import { generateBusinessReview } from "../business/intelligence.js";

export const BUSINESS_REVIEW_TASK_NAME = "business_review";

export const businessReviewTask: HeartbeatTaskFn = async (_ctx, taskCtx) => {
  const review = generateBusinessReview(taskCtx.db.raw);

  taskCtx.db.setKV(
    "business.latest_review_summary",
    JSON.stringify({
      generatedAt: review.generatedAt,
      summary: review.summary,
      actionable: review.actionable,
    }),
  );

  if (!review.actionable) {
    return { shouldWake: false };
  }

  const decisions = review.recommendations
    .filter((item) => item.action !== "continue")
    .slice(0, 5)
    .map((item) => `${item.experimentName}: ${item.action} — ${item.reason}`);

  const opportunities = review.topOpportunities
    .slice(0, 3)
    .map((item: any) => `${item.title} (${Math.round(Number(item.priorityValueCents ?? 0))}c priority value)`);

  const details = [
    review.summary,
    decisions.length > 0 ? `Experiment decisions: ${decisions.join(" | ")}` : "",
    opportunities.length > 0 ? `Top opportunities: ${opportunities.join(" | ")}` : "",
    "Review the portfolio before allocating additional capital.",
  ]
    .filter(Boolean)
    .join(" ");

  return {
    shouldWake: true,
    message: `Business review requires attention. ${details}`,
  };
};
