import type { PoolClient } from "pg";
import { parseProjectAgentGuidanceMarkdown, validateGuidanceDriftContradiction } from "@semprec/shared";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors.js";
import { projectAgentGuidanceStore } from "../projectAgentGuidanceStore.js";
import { saveGuidanceSections } from "../projectAgentGuidance/projectAgentGuidanceSections.js";
import { writeNotification } from "../notifications/notify.js";
import { agentGuidanceDriftFindingsStore } from "./agentGuidanceDriftFindingsStore.js";

export async function resolveGuidanceDriftFinding(
  tx: PoolClient,
  input: {
    findingId: string;
    actorUserId: string;
    choice: "allow" | "forbid" | "dismiss";
    expectedGuidanceUpdatedAt: string | null;
  },
) {
  const found = await tx.query<{ project_item_id: string }>(
    "SELECT project_item_id FROM agent_guidance_drift_findings WHERE id = $1 AND status = 'active'",
    [input.findingId],
  );
  const projectId = found.rows[0]?.project_item_id;
  if (!projectId) throw new NotFoundError("Guidance drift finding not found");
  const guidance = await projectAgentGuidanceStore.loadForUpdate(tx, projectId);
  if (!guidance) throw new NotFoundError("Guidance drift finding not found");
  const sections = parseProjectAgentGuidanceMarkdown(guidance.markdown);
  const current = { sections, updatedAt: guidance.updatedAt, ownerUserId: guidance.ownerUserId };
  if (guidance.ownerUserId !== input.actorUserId)
    throw new ForbiddenError("Guidance owner required", undefined, "owner_violation");
  if (guidance.updatedAt !== input.expectedGuidanceUpdatedAt) throw new ConflictError("Guidance changed", { current });
  const locked = await tx.query<{ payload: unknown; fingerprint: string }>(
    "SELECT payload, fingerprint FROM agent_guidance_drift_findings WHERE id = $1 AND project_item_id = $2 AND status = 'active' FOR UPDATE",
    [input.findingId, projectId],
  );
  const row = locked.rows[0];
  if (!row) throw new NotFoundError("Guidance drift finding not found");
  const payload = validateGuidanceDriftContradiction(row.payload, "guidance drift finding");
  if (input.choice !== "dismiss" && payload.kind !== "behavior")
    throw new ValidationError("Choice is not applicable", { field: "choice", reason: "not_applicable" });
  let saved = { sections, updatedAt: guidance.updatedAt };
  if (input.choice !== "dismiss" && payload.kind === "behavior") {
    const section = input.choice === "allow" ? "allowed" : "notAllowed";
    const line = input.choice === "allow" ? payload.suggestedAllowedLine : payload.suggestedNotAllowedLine;
    if (/[\r\n\u0085\u2028\u2029]/u.test(line))
      throw new ValidationError("Suggestion must be a single line", { field: "choice" });
    const previous = sections[section];
    const amended = {
      ...sections,
      [section]: `${previous}${previous && !previous.endsWith("\n") ? "\n" : ""}- ${line}`,
    };
    const result = await saveGuidanceSections(tx, {
      actorUserId: input.actorUserId,
      projectItemId: projectId,
      sections: amended,
      expectedUpdatedAt: input.expectedGuidanceUpdatedAt,
    });
    if (result.updatedAt === null) throw new Error("Saved guidance disappeared");
    saved = { sections: result.sections, updatedAt: result.updatedAt };
  }
  const at = new Date();
  const finding = await agentGuidanceDriftFindingsStore.decide(tx, input.findingId, {
    status: input.choice === "dismiss" ? "dismissed" : "resolved",
    choice: input.choice,
    userId: input.actorUserId,
    at,
  });
  await writeNotification(tx, {
    userId: guidance.ownerUserId,
    kind: "agent_guidance_drift_resolved",
    linkHref: `/projects/${projectId}/agent-guidance`,
    sourceTable: "agent_guidance_drift_findings",
    sourceId: finding.id,
    transitionInstance: `${row.fingerprint}:${at.toISOString()}`,
    payload: { projectItemId: projectId, fingerprint: row.fingerprint, kind: payload.kind },
  });
  return { finding: { id: finding.id, status: finding.status }, guidance: saved };
}
