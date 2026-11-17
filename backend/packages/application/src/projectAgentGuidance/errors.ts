/**
 * Own error shapes with the backend's `status`/`code`/`details` convention: this package may not
 * import `packages/data`'s `ChokePointError` family.
 */

export type ProjectAgentGuidanceValidationField = "projectItemId" | "newOwnerUserId" | "markdown";
export type ProjectAgentGuidanceValidationReason = "not_found" | "blank" | "too_long";

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
