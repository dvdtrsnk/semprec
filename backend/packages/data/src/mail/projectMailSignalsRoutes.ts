import type { Pool } from "pg";
import { z } from "zod";
import { createRelationWithClient } from "../chokePoint/relationOps.js";
import { withTransaction } from "../db/pool.js";
import { RateLimitedError, ValidationError } from "../errors.js";
import type { CustomRouteResult, RouteBody, RouteParams, RouteUser } from "../customRoute.js";
import { requireUuidParam } from "../customRoute.js";
import { listMailThreads } from "./mailThreadListQuery.js";
import { lockMailThreadMutation } from "./mailThreadMutationGuard.js";
import {
  EMPTY_MAIL_SIGNALS,
  listProjectPeopleAddresses,
  mailThreadsMatchingSignals,
  parseMailSignalSet,
  previewMailSignalMatches,
  requireLiveProject,
  type PersonMailAddress,
} from "./projectMailSignals.js";
import {
  readProjectMailSignals,
  replaceProjectMailSignals,
  type MailSignalSet,
  type StoredMailSignals,
} from "./projectMailSignalsStore.js";
import { projectPropertyIdIfOpen } from "./threadProjectTriage.js";

type ThrottleAttempt = { granted: true } | { granted: false; retryAfterSeconds: number };

export interface MailSignalPreviewThrottle {
  /** Checks and counts in the same synchronous step, per user. */
  tryAcquire(action: "mailSignalPreview", userId: string): ThrottleAttempt;
}

export interface ProjectMailSignalsRouteDependencies {
  throttle?: MailSignalPreviewThrottle;
}

/** The threads a preview lists; `total` counts them all. */
export const MAIL_SIGNAL_PREVIEW_LIMIT = 50;
/** The threads one apply call may name. */
export const MAX_APPLY_THREADS = 200;

export interface ProjectMailSignalsBody extends MailSignalSet {
  projectId: string;
  /** `null` while the project has never had signals saved. */
  updatedAt: string | null;
  /** The addresses of the project's people: they count as signals and are edited on the people, not here. */
  peopleAddresses: PersonMailAddress[];
}

function signalsBody(
  projectId: string,
  stored: StoredMailSignals | null,
  people: PersonMailAddress[],
): ProjectMailSignalsBody {
  const signals = stored ?? EMPTY_MAIL_SIGNALS;
  return {
    projectId,
    domains: [...signals.domains],
    addresses: [...signals.addresses],
    keywords: [...signals.keywords],
    updatedAt: stored?.updatedAt ?? null,
    peopleAddresses: people,
  };
}

/** The project's signals and its people's addresses. An unknown, trashed or foreign project is 404. */
export function createProjectMailSignalsReadRouteHandler(pool: Pool) {
  return async (ctx: RouteParams): Promise<CustomRouteResult<ProjectMailSignalsBody>> => {
    const projectId = requireUuidParam(ctx.params, "projectId");
    const body = await withTransaction(
      pool,
      async (client) => {
        await requireLiveProject(client, projectId, false);
        const stored = await readProjectMailSignals(client, projectId);
        const people = await listProjectPeopleAddresses(client, [projectId]);
        return signalsBody(projectId, stored, people.get(projectId) ?? []);
      },
      { isolation: "repeatable_read" },
    );
    return { status: 200, body };
  };
}

/**
 * Replaces the project's signals with the body's `{ domains, addresses, keywords }` (each optional, empty when left
 * out), normalized by `parseMailSignalSet`. The last write wins. The project is held `FOR SHARE` until the commit, so a
 * trash waits for the write.
 */
export function createProjectMailSignalsReplaceRouteHandler(pool: Pool) {
  return async (ctx: RouteParams & RouteBody): Promise<CustomRouteResult<ProjectMailSignalsBody>> => {
    const projectId = requireUuidParam(ctx.params, "projectId");
    const signals = parseMailSignalSet(ctx.body);
    const body = await withTransaction(pool, async (client) => {
      await requireLiveProject(client, projectId, true);
      const stored = await replaceProjectMailSignals(client, projectId, signals);
      const people = await listProjectPeopleAddresses(client, [projectId]);
      return signalsBody(projectId, stored, people.get(projectId) ?? []);
    });
    return { status: 200, body };
  };
}

function previewDraft(body: unknown): MailSignalSet | null {
  if (body === undefined || body === null) return null;
  if (typeof body !== "object" || Array.isArray(body))
    throw new ValidationError("The body must be a JSON object", { field: "draft" });
  const unknownKey = Object.keys(body).find((key) => key !== "draft");
  if (unknownKey !== undefined) throw new ValidationError("Unexpected preview field", { field: unknownKey });
  return "draft" in body ? parseMailSignalSet(body.draft) : null;
}

/**
 * The open threads (no project, no project link) the project's signals match, the newest `MAIL_SIGNAL_PREVIEW_LIMIT`
 * as thread list rows, with the count of all of them and of the matching threads that already have a project. An
 * optional `{ draft: { domains, addresses, keywords } }` is matched instead of the saved signals, so a setup can be
 * previewed before it is saved; the people's addresses count either way. Reads one snapshot and writes nothing. Counted
 * per user by the throttle (`mailSignalPreview`); a refusal is 429 `rate_limited`.
 */
export function createProjectMailSignalsPreviewRouteHandler(
  pool: Pool,
  dependencies: ProjectMailSignalsRouteDependencies,
) {
  return async (ctx: RouteParams & RouteBody & RouteUser) => {
    const projectId = requireUuidParam(ctx.params, "projectId");
    // Each preview matches the signals against the tenant's whole mail index, so each counts for the user; a mount
    // without a throttle fails (500).
    const { throttle } = dependencies;
    if (throttle === undefined) throw new Error('custom route dependency "throttle" is not configured');
    const attempt = throttle.tryAcquire("mailSignalPreview", ctx.identity.user.id);
    if (!attempt.granted) throw new RateLimitedError(attempt.retryAfterSeconds);
    const draft = previewDraft(ctx.body);
    const body = await withTransaction(
      pool,
      async (client) => {
        await requireLiveProject(client, projectId, false);
        const signals = draft ?? (await readProjectMailSignals(client, projectId)) ?? EMPTY_MAIL_SIGNALS;
        const people = (await listProjectPeopleAddresses(client, [projectId])).get(projectId) ?? [];
        const matches = await previewMailSignalMatches(client, projectId, signals, people, MAIL_SIGNAL_PREVIEW_LIMIT);
        const threads =
          matches.newestThreadIds.length === 0
            ? []
            : await listMailThreads(client, MAIL_SIGNAL_PREVIEW_LIMIT, null, {
                box: "inbox",
                folderId: null,
                unread: false,
                mailboxId: null,
                threadIds: matches.newestThreadIds,
              });
        return { total: matches.total, alreadyAssigned: matches.alreadyAssigned, threads };
      },
      { isolation: "repeatable_read" },
    );
    return { status: 200, body };
  };
}

const applyBodySchema = z.object({ threadIds: z.array(z.uuid()).min(1).max(MAX_APPLY_THREADS) }).strict();

/**
 * Gives each listed thread the project as the user's own value when the saved signals still match it and it is still
 * open (no project edge, no project link); every other id is skipped, an unknown or foreign one too. One transaction:
 * the mail thread guard (so no message joins or leaves a thread meanwhile), the project and its signals row `FOR
 * SHARE`, then each Threads item in id order, locked and rechecked before its edge is written through the choke point's
 * relation write as the session's user, as a user's own project edit is. A repeat assigns nothing.
 */
export function createProjectMailSignalsApplyRouteHandler(pool: Pool) {
  return async (
    ctx: RouteParams & RouteBody & RouteUser,
  ): Promise<CustomRouteResult<{ assigned: number; skipped: number }>> => {
    const projectId = requireUuidParam(ctx.params, "projectId");
    const parsed = applyBodySchema.safeParse(ctx.body);
    if (!parsed.success)
      throw new ValidationError(`The body must be { threadIds: [...] } with 1 to ${MAX_APPLY_THREADS} ids`, {
        field: "threadIds",
      });
    const threadIds = [...new Set(parsed.data.threadIds)];
    const userId = ctx.identity.user.id;
    const assigned = await withTransaction(pool, async (client) => {
      await lockMailThreadMutation(client);
      await requireLiveProject(client, projectId, true);
      const signals = (await readProjectMailSignals(client, projectId, "share")) ?? EMPTY_MAIL_SIGNALS;
      const people = (await listProjectPeopleAddresses(client, [projectId])).get(projectId) ?? [];
      const matched = await mailThreadsMatchingSignals(client, projectId, signals, people, threadIds);
      let count = 0;
      for (const thread of matched) {
        if (!thread.open) continue;
        const propertyId = await projectPropertyIdIfOpen(client, thread.threadItemId, true);
        if (propertyId === null) continue;
        await createRelationWithClient(
          client,
          { relationPropertyId: propertyId, callerItemId: thread.threadItemId, targetItemId: projectId },
          undefined,
          { writerKind: "user" },
          userId,
        );
        count += 1;
      }
      return count;
    });
    return { status: 200, body: { assigned, skipped: threadIds.length - assigned } };
  };
}
