import type { PoolClient } from "pg";
import {
  composeProjectAgentGuidanceMarkdown,
  findReservedHeading,
  GuidanceReferenceNotFoundError,
  MAX_PROJECT_AGENT_GUIDANCE_MARKDOWN_BYTES,
  parseProjectAgentGuidanceMarkdown,
  type ProjectAgentGuidanceSections,
} from "@semprec/shared";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors.js";
import { guidanceReferenceStore, projectAgentGuidanceStore } from "../projectAgentGuidanceStore.js";
import { guidanceDriftHeartbeatStore } from "../guidanceDrift/guidanceDriftHeartbeatStore.js";
import { agentGuidanceDriftFindingsStore } from "../guidanceDrift/agentGuidanceDriftFindingsStore.js";

const empty = (): ProjectAgentGuidanceSections => ({
  purpose: "",
  allowed: "",
  notAllowed: "",
  generalInstructions: "",
});

async function requireProject(tx: PoolClient, projectItemId: string): Promise<void> {
  try {
    await guidanceReferenceStore.requireProjectsItem(tx, projectItemId);
  } catch (error) {
    if (error instanceof GuidanceReferenceNotFoundError) throw new NotFoundError("Project not found");
    throw error;
  }
}

export async function loadGuidanceSections(tx: PoolClient, projectItemId: string) {
  await requireProject(tx, projectItemId);
  const row = await projectAgentGuidanceStore.load(tx, projectItemId);
  return {
    sections: row ? parseProjectAgentGuidanceMarkdown(row.markdown) : empty(),
    updatedAt: row?.updatedAt ?? null,
    ownerUserId: row?.ownerUserId ?? null,
  };
}

export async function saveGuidanceSections(
  tx: PoolClient,
  input: {
    actorUserId: string;
    projectItemId: string;
    sections: ProjectAgentGuidanceSections;
    expectedUpdatedAt: string | null;
  },
) {
  await requireProject(tx, input.projectItemId);
  const reserved = findReservedHeading(input.sections);
  if (reserved)
    throw new ValidationError("Reserved heading in section", {
      field: `sections.${reserved}`,
      reason: "reserved_heading",
    });
  const markdown = composeProjectAgentGuidanceMarkdown(input.sections);
  if (Buffer.byteLength(markdown, "utf8") > MAX_PROJECT_AGENT_GUIDANCE_MARKDOWN_BYTES) {
    throw new ValidationError("Guidance is too long", { field: "sections", reason: "too_long" });
  }
  const existing = await projectAgentGuidanceStore.loadForUpdate(tx, input.projectItemId);
  const current = {
    sections: existing ? parseProjectAgentGuidanceMarkdown(existing.markdown) : empty(),
    updatedAt: existing?.updatedAt ?? null,
    ownerUserId: existing?.ownerUserId ?? null,
  };
  if (existing && existing.ownerUserId !== input.actorUserId)
    throw new ForbiddenError("Guidance owner required", undefined, "owner_violation");
  if (current.updatedAt !== input.expectedUpdatedAt) throw new ConflictError("Guidance changed", { current });
  if (!existing && !markdown) return { sections: empty(), updatedAt: null };
  if (!existing) {
    try {
      await guidanceReferenceStore.requireUser(tx, input.actorUserId);
    } catch (error) {
      if (error instanceof GuidanceReferenceNotFoundError)
        throw new ForbiddenError("Guidance owner required", undefined, "owner_violation");
      throw error;
    }
  }
  if (!markdown) {
    await projectAgentGuidanceStore.delete(tx, input.projectItemId);
    await guidanceDriftHeartbeatStore.disableDriftHeartbeat(tx, input.projectItemId);
    const findings = await agentGuidanceDriftFindingsStore.listActive(tx, input.projectItemId);
    for (const finding of findings) await agentGuidanceDriftFindingsStore.resolve(tx, finding.id, new Date());
    return { sections: empty(), updatedAt: null };
  }
  const saved = await projectAgentGuidanceStore.upsert(tx, {
    projectItemId: input.projectItemId,
    ownerUserId: existing?.ownerUserId ?? input.actorUserId,
    markdown,
  });
  await guidanceDriftHeartbeatStore.upsertDriftHeartbeat(tx, input.projectItemId);
  return { sections: parseProjectAgentGuidanceMarkdown(saved.markdown), updatedAt: saved.updatedAt };
}
