/** `core.agentGuidanceDrift` errors, with the neutral `status`/`code`/`details` convention of `errors.ts`. */

export class GuidanceMissingError extends Error {
  readonly status = 404 as const;
  readonly code = "guidance_missing" as const;
  readonly details: { projectItemId: string };

  constructor(projectItemId: string) {
    super(`No agent guidance exists for project ${projectItemId}`);
    this.name = "GuidanceMissingError";
    this.details = { projectItemId };
  }
}

/**
 * The guidance row's `ownerUserId`/`updatedAt` changed between the read transaction and the write
 * transaction. Retryable: a fresh run compares the new state.
 */
export class GuidanceChangedError extends Error {
  readonly status = 409 as const;
  readonly code = "guidance_changed" as const;
  readonly retryable = true as const;
  readonly details: { projectItemId: string };

  constructor(projectItemId: string) {
    super(`Project ${projectItemId}'s agent guidance changed during drift comparison`);
    this.name = "GuidanceChangedError";
    this.details = { projectItemId };
  }
}

/**
 * The guidance row is unchanged but the re-rendered permission manifest differs from the captured
 * one: a database, heartbeat, capability or agent tool changed mid-comparison. Retryable.
 */
export class GuidanceContextChangedError extends Error {
  readonly status = 409 as const;
  readonly code = "guidance_context_changed" as const;
  readonly retryable = true as const;
  readonly details: { projectItemId: string };

  constructor(projectItemId: string) {
    super(`Project ${projectItemId}'s permission manifest changed during drift comparison`);
    this.name = "GuidanceContextChangedError";
    this.details = { projectItemId };
  }
}
