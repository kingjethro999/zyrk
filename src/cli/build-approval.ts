import type { BuildReview } from "../install/private.ts";
import { redactSecrets } from "../log.ts";

const decisionLabel: Record<BuildReview["decision"], string> = {
  approved: "APPROVED",
  denied: "DENIED",
  pending: "PENDING",
};

const scopeLabel: Record<BuildReview["policyScope"], string> = {
  "user-deny": "mandatory user policy",
  "project-deny": "project deny policy",
  "project-policy": "project script policy",
  "workspace-policy": "zyrk-workspace.json",
  "local-session": "current graph approval",
  none: "no approval recorded",
};

function safe(value: string): string {
  return redactSecrets(value).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}

/** Human review text only. It never executes package code or changes policy. */
export function renderBuildReviews(reviews: readonly BuildReview[]): string {
  if (!reviews.length) return "No dependency builds require approval.\n";
  const entries = reviews
    .map((review) => {
      const stages = review.stages
        .map((stage) => `    ${safe(stage.name)}: ${safe(stage.command)}`)
        .join("\n");
      return `${decisionLabel[review.decision]} ${safe(review.name)}@${safe(review.version)}\n  source: ${safe(review.sourceId)}\n  policy: ${scopeLabel[review.policyScope]}\n  lifecycle:\n${stages}`;
    })
    .join("\n\n");
  return `Dependency build review (no package code ran)\n\n${entries}\n\nApprovals persist by exact source in zyrk-workspace.json. User and project denies take precedence.\nApproved scripts run with your OS account permissions; approval is not a sandbox.\n`;
}
