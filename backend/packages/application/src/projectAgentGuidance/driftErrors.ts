/**
 * Issue #85's `core.agentGuidanceDrift` action errors. Same neutral `status`/`code`/`details`
 * convention as `errors.ts` (this package stays free of `packages/data`'s `ChokePointError`).
 */

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
 * The guidance row's `ownerUserId`/`updatedAt` no longer match what the read transaction
 * captured before the gateway call: the guidance was rewritten or transferred mid-comparison.
 * Retryable — a fresh run will capture the new state and compare against that instead.
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
 * The guidance row itself is unchanged, but the permission manifest re-rendered in the write
 * transaction no longer matches the one captured before the gateway call byte-for-byte:
 * something the manifest depends on (a database, a heartbeat, a capability, an agent tool)
 * mutated mid-comparison. Retryable, same reasoning as `GuidanceChangedError`.
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
