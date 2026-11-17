import { GuidanceReferenceNotFoundError, MAX_PROJECT_AGENT_GUIDANCE_MARKDOWN_BYTES } from "@semprec/shared";
import type {
  GuidanceHeartbeatStore,
  GuidanceReferenceStore,
  ProjectAgentGuidance,
  ProjectAgentGuidanceActor,
  ProjectAgentGuidanceStore,
  TransactionRunner,
  TransferProjectAgentGuidanceInput,
  UpsertProjectAgentGuidanceInput,
} from "@semprec/shared";
import { ProjectAgentGuidanceOwnerViolationError, ProjectAgentGuidanceValidationError } from "./errors.js";

export interface ProjectAgentGuidanceServiceDeps<Tx> {
  store: ProjectAgentGuidanceStore<Tx>;
  references: GuidanceReferenceStore<Tx>;
  heartbeats: GuidanceHeartbeatStore<Tx>;
  transactions: TransactionRunner<Tx>;
}

export interface ProjectAgentGuidanceService {
  loadProjectAgentGuidance(projectItemId: string): Promise<ProjectAgentGuidance | null>;
  upsertProjectAgentGuidance(
    actor: ProjectAgentGuidanceActor,
    input: UpsertProjectAgentGuidanceInput,
  ): Promise<ProjectAgentGuidance>;
  transferProjectAgentGuidance(
    actor: ProjectAgentGuidanceActor,
    input: TransferProjectAgentGuidanceInput,
  ): Promise<ProjectAgentGuidance>;
}

/**
 * Maps `GuidanceReferenceNotFoundError` to the matching `validation_failed` response; any other error
 * is an infrastructure failure and propagates unchanged rather than becoming a 400.
 */
async function requireOrValidationError(
  guard: () => Promise<void>,
  details: { field: "projectItemId" | "newOwnerUserId"; reason: "not_found" },
): Promise<void> {
  try {
    await guard();
  } catch (err) {
    if (err instanceof GuidanceReferenceNotFoundError) {
      throw new ProjectAgentGuidanceValidationError(details);
    }
    throw err;
  }
}

export function createProjectAgentGuidanceService<Tx>(
  deps: ProjectAgentGuidanceServiceDeps<Tx>,
): ProjectAgentGuidanceService {
  const { store, references, heartbeats, transactions } = deps;

  return {
    async loadProjectAgentGuidance(projectItemId) {
      return transactions.withTransaction({ isolation: "repeatable_read" }, (tx) => store.load(tx, projectItemId));
    },

    async upsertProjectAgentGuidance(actor, input) {
      if (input.markdown.trim().length === 0) {
        throw new ProjectAgentGuidanceValidationError({ field: "markdown", reason: "blank" });
      }
      if (Buffer.byteLength(input.markdown, "utf8") > MAX_PROJECT_AGENT_GUIDANCE_MARKDOWN_BYTES) {
        throw new ProjectAgentGuidanceValidationError({ field: "markdown", reason: "too_long" });
      }

      return transactions.withTransaction({ isolation: "serializable" }, async (tx) => {
        await requireOrValidationError(() => references.requireProjectsItem(tx, input.projectItemId), {
          field: "projectItemId",
          reason: "not_found",
        });

        const existing = await store.load(tx, input.projectItemId);
        if (existing && existing.ownerUserId !== actor.userId) {
          throw new ProjectAgentGuidanceOwnerViolationError(input.projectItemId);
        }
        if (!existing) {
          // The first write seeds the owner, so the actor must be the tenant's own user; anyone else is an owner violation.
          try {
            await references.requireUser(tx, actor.userId);
          } catch (err) {
            if (err instanceof GuidanceReferenceNotFoundError) {
              throw new ProjectAgentGuidanceOwnerViolationError(input.projectItemId);
            }
            throw err;
          }
        }

        const saved = await store.upsert(tx, {
          projectItemId: input.projectItemId,
          ownerUserId: existing ? existing.ownerUserId : actor.userId,
          markdown: input.markdown,
        });

        await heartbeats.upsertDriftHeartbeat(tx, input.projectItemId);
        return saved;
      });
    },

    async transferProjectAgentGuidance(actor, input) {
      return transactions.withTransaction({ isolation: "serializable" }, async (tx) => {
        await requireOrValidationError(() => references.requireProjectsItem(tx, input.projectItemId), {
          field: "projectItemId",
          reason: "not_found",
        });

        const existing = await store.load(tx, input.projectItemId);
        // No guidance means no current owner, so this gets the same 403 as a wrong-owner call.
        if (!existing || existing.ownerUserId !== actor.userId) {
          throw new ProjectAgentGuidanceOwnerViolationError(input.projectItemId);
        }

        await requireOrValidationError(() => references.requireUser(tx, input.newOwnerUserId), {
          field: "newOwnerUserId",
          reason: "not_found",
        });

        const saved = await store.transfer(tx, input.projectItemId, input.newOwnerUserId);
        await heartbeats.upsertDriftHeartbeat(tx, input.projectItemId);
        return saved;
      });
    },
  };
}
