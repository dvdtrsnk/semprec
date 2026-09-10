/**
 * This package stays neutral (dependency-cruiser forbids it importing `packages/data`'s
 * `ChokePointError` family — see `dependency-cruiser.rules.json`), so it defines its own
 * error shapes here, mirroring the same `status`/`code`/`details` convention used across the
 * rest of the backend.
 */

export type ProjectAgentGuidanceValidationField = "projectItemId" | "newOwnerUserId" | "markdown";
export type ProjectAgentGuidanceValidationReason = "not_found" | "blank";

export interface ProjectAgentGuidanceValidationDetails {
  field: ProjectAgentGuidanceValidationField;
  reason: ProjectAgentGuidanceValidationReason;
}

export class ProjectAgentGuidanceValidationError extends Error {
  readonly status = 400 as const;
  readonly code = "validation_failed" as const;
  readonly details: ProjectAgentGuidanceValidationDetails;

  constructor(details: ProjectAgentGuidanceValidationDetails) {
    super(`project agent guidance validation failed: ${details.field} ${details.reason}`);
    this.name = "ProjectAgentGuidanceValidationError";
    this.details = details;
  }
}

export interface ProjectAgentGuidanceOwnerViolationDetails {
  field: "ownerUserId";
  projectItemId: string;
}

export class ProjectAgentGuidanceOwnerViolationError extends Error {
  readonly status = 403 as const;
  readonly code = "owner_violation" as const;
  readonly details: ProjectAgentGuidanceOwnerViolationDetails;

  constructor(projectItemId: string) {
    super(`Actor is not the current owner of project ${projectItemId}'s agent guidance`);
    this.name = "ProjectAgentGuidanceOwnerViolationError";
    this.details = { field: "ownerUserId", projectItemId };
  }
}
