import type { Pool } from "pg";
import {
  ApprovalRequiredError,
  ChokePointError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  computeDestructiveResourceProjection,
  createActionQueueAffinity,
  createPendingApprovalRequest,
  databaseArchiveWithClient,
  deleteRelationWithClient,
  getAgentRun,
  getApprovalRequest,
  getEarliestUserId,
  isGenericOperationApprovalRequestPayload,
  itemDeleteWithClient,
  propertyDeleteWithClient,
  requireAffectedRows,
  viewDeleteWithClient,
  withTransaction,
  writeNotification,
  type Actor,
  type ApprovalRequest,
  type DestructiveOperationCheck,
  type GenericOperationApprovalRequestPayload,
} from "@semprec/data";
import {
  GENERIC_OPERATION_BINDINGS,
  GENERIC_OPERATION_NAMES,
  OPERATION_METADATA,
  type AuthenticatedActor,
  type CapabilityId,
  type GenericApplicationPort,
  type GenericOperationName,
  type InputByOperation,
  type OutputByOperation,
} from "@semprec/shared";
import { createGenericApplicationService, toActor } from "./genericApplicationService.js";

/** The five destructive operations issue #89 covers — every other catalog entry never reaches this gate (`OPERATION_METADATA[...].requiresApproval` is `false`). */
type DestructiveOperationName =
  "database.archive" | "property.delete" | "view.delete" | "item.delete" | "relation.delete";

function isDestructiveOperationName(operation: GenericOperationName): operation is DestructiveOperationName {
  return (
    operation === "database.archive" ||
    operation === "property.delete" ||
    operation === "view.delete" ||
    operation === "item.delete" ||
    operation === "relation.delete"
  );
}

/** Maps one destructive operation's already-validated input (plus the data-layer `Actor` form of the caller, needed only by `view.delete`'s writability check) onto the shared projection/authorization check both request-time snapshotting and execution-time revalidation run. */
function buildDestructiveCheck(
  operation: DestructiveOperationName,
  input: unknown,
  actor: Actor,
): DestructiveOperationCheck {
  switch (operation) {
    case "database.archive":
      return { operation, input: input as { databaseId: string } };
    case "property.delete":
      return { operation, input: input as { propertyId: string } };
    case "view.delete":
      return { operation, input: input as { viewId: string }, actor };
    case "item.delete":
      return { operation, input: input as { itemId: string } };
    case "relation.delete":
      return {
        operation,
        input: input as { relationPropertyId: string; callerItemId: string; targetItemId: string },
      };
  }
}

/** Runs the actual destructive mutation on the caller's own transaction — the same `*WithClient` function the choke-point's public API delegates to, so approval-gated execution and a direct call share one implementation. */
async function executeDestructiveWithClient(
  client: Parameters<typeof databaseArchiveWithClient>[0],
  operation: DestructiveOperationName,
  input: unknown,
  actor: Actor,
  actingUserId: string | undefined,
  currentResource: unknown,
): Promise<unknown> {
  switch (operation) {
    case "database.archive":
      return databaseArchiveWithClient(client, (input as { databaseId: string }).databaseId, actingUserId);
    case "property.delete":
      return propertyDeleteWithClient(client, (input as { propertyId: string }).propertyId, actingUserId);
    case "view.delete":
      return viewDeleteWithClient(client, (input as { viewId: string }).viewId, actor, actingUserId);
    case "item.delete": {
      const databaseId = (currentResource as { databaseId: string }).databaseId;
      return itemDeleteWithClient(client, databaseId, (input as { itemId: string }).itemId, {
        queueAffinity: createActionQueueAffinity(),
        actingUserId,
      });
    }
    case "relation.delete":
      return deleteRelationWithClient(
        client,
        input as { relationPropertyId: string; callerItemId: string; targetItemId: string },
      );
  }
}

function isGranted(operation: GenericOperationName, grantedCapabilities: ReadonlySet<CapabilityId>): boolean {
  return grantedCapabilities.has(OPERATION_METADATA[operation].requiresCapability);
}

function assertCompleteAgentIdentity(actor: AuthenticatedActor): void {
  if ((actor.runId === undefined) !== (actor.agentProjectItemId === undefined)) {
    throw new ForbiddenError(
      "An agent actor must carry both runId and agentProjectItemId together, or neither",
      undefined,
      "owner_violation",
    );
  }
}

/** Validates a stored payload's `operationName` against the closed catalog instead of casting it straight to `GenericOperationName` — the payload came back through a `jsonb` column, a boundary this codebase's own types don't protect. */
function assertGenericOperationName(value: string): GenericOperationName {
  if (!(GENERIC_OPERATION_NAMES as readonly string[]).includes(value)) {
    throw new ValidationError(`Unknown operation '${value}' in approval request payload`);
  }
  return value as GenericOperationName;
}

function parseInput<K extends GenericOperationName>(operation: K, raw: unknown): InputByOperation[K] {
  const binding = GENERIC_OPERATION_BINDINGS[operation] as {
    input: {
      safeParse(
        value: unknown,
      ):
        | { success: true; data: InputByOperation[K] }
        | { success: false; error: { issues: { path: (string | number)[]; message: string }[] } };
    };
  };
  const parsed = binding.input.safeParse(raw);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const field = firstIssue !== undefined && firstIssue.path.length > 0 ? firstIssue.path.join(".") : undefined;
    throw new ValidationError(
      firstIssue?.message ?? "Request failed validation",
      field === undefined ? undefined : { field },
    );
  }
  return parsed.data;
}

async function invokeBinding<K extends GenericOperationName>(
  service: GenericApplicationPort,
  operation: K,
  actor: AuthenticatedActor,
  input: InputByOperation[K],
): Promise<OutputByOperation[K]> {
  const binding = GENERIC_OPERATION_BINDINGS[operation] as {
    invoke(
      service: GenericApplicationPort,
      actor: AuthenticatedActor,
      input: InputByOperation[K],
    ): Promise<OutputByOperation[K]>;
  };
  return binding.invoke(service, actor, input);
}

/**
 * `DestructiveApprovalPreflight` (issue #89): runs the exact resource authorization
 * (`computeDestructiveResourceProjection` — existence/ownership/locked/archive/version, the same
 * checks the destructive command itself would run) that a direct call to this operation would run,
 * and only on success — in the same transaction — inserts the pending approval request plus its
 * `approval_pending` notification, carrying the resulting `resourceSnapshot`. An unauthorized,
 * not-found, locked, or archived call therefore never creates a row or a notification at all: the
 * caller sees the domain `ChokePointError` `computeDestructiveResourceProjection` throws, propagated
 * out of this transaction (which rolls back), rather than a queued request nobody can act on.
 */
async function preflightDestructiveApproval(
  pool: Pool,
  operation: DestructiveOperationName,
  actor: AuthenticatedActor,
  input: unknown,
): Promise<ApprovalRequest> {
  const metadata = OPERATION_METADATA[operation];
  return withTransaction(pool, async (client) => {
    const check = buildDestructiveCheck(operation, input, toActor(actor));
    const { snapshot } = await computeDestructiveResourceProjection(client, check);

    const payload: GenericOperationApprovalRequestPayload = {
      operationName: operation,
      canonicalInput: input,
      actor: { runId: actor.runId!, agentProjectItemId: actor.agentProjectItemId!, userId: actor.userId },
    };
    const created = await createPendingApprovalRequest(client, {
      agentRunId: actor.runId!,
      toolName: operation,
      riskClass: metadata.riskClass!,
      payload,
      resourceSnapshot: snapshot,
    });

    const userId = await getEarliestUserId(client);
    if (userId) {
      await writeNotification(client, {
        userId,
        kind: "approval_pending",
        titleParams: { toolName: created.toolName },
        linkHref: `?page=approvals&user=${userId}`,
        sourceTable: "approval_requests",
        sourceId: created.id,
        transitionInstance: created.id,
      });
    }
    return created;
  });
}

export interface GenericOperationGateway {
  /** The operations visible given `grantedCapabilities` — an ungranted one is simply absent, never present-but-forbidden. */
  listOperations(grantedCapabilities: ReadonlySet<CapabilityId>): GenericOperationName[];
  /**
   * Dispatches one operation for an agent actor (`actor.runId`/`actor.agentProjectItemId` set):
   * capability-gates, then approval-gates a destructive operation by queuing a pending approval
   * request and throwing `ApprovalRequiredError` — the AgentTool composition root (#220) catches
   * that specifically and returns a synthetic success instead of surfacing it, matching
   * `mcpInvokeTool.ts`'s existing dual-path convention; MCP surfaces it as a JSON-RPC error, same
   * as REST does for its own (never approval-gated, since a REST actor never carries
   * `agentProjectItemId`) `ChokePointError`s.
   */
  invoke<K extends GenericOperationName>(
    operation: K,
    actor: AuthenticatedActor,
    grantedCapabilities: ReadonlySet<CapabilityId>,
    raw: unknown,
  ): Promise<OutputByOperation[K]>;
}

/**
 * The one gateway both the AgentTool (`packages/agent-runtime`) and MCP (`services/semprec-api`)
 * composition roots construct over their own injected `Pool` (issue #220), sitting between
 * capability/approval and the neutral `GenericApplicationPort` (#219). REST's own
 * `dispatchGenericOperation` (services/semprec-api/src/adapter/genericBinding.ts) calls the port
 * directly without this gate — a REST human actor never carries `agentProjectItemId`, the one
 * condition this gate's approval check keys on, so this gate would only ever be a no-op there.
 */
export function createGenericOperationGateway(pool: Pool): GenericOperationGateway {
  const service = createGenericApplicationService(pool);

  return {
    listOperations(grantedCapabilities) {
      return GENERIC_OPERATION_NAMES.filter((operation) => isGranted(operation, grantedCapabilities));
    },

    async invoke(operation, actor, grantedCapabilities, raw) {
      if (!isGranted(operation, grantedCapabilities)) {
        throw new NotFoundError(`Unknown operation '${operation}'`);
      }
      assertCompleteAgentIdentity(actor);

      const input = parseInput(operation, raw);
      const metadata = OPERATION_METADATA[operation];

      if (metadata.requiresApproval && actor.runId !== undefined && actor.agentProjectItemId !== undefined) {
        if (!isDestructiveOperationName(operation)) {
          throw new ValidationError(
            `Operation '${operation}' is flagged as approval-requiring but is not one of the five destructive kinds`,
          );
        }
        const request = await preflightDestructiveApproval(pool, operation, actor, input);
        throw new ApprovalRequiredError(`Operation '${operation}' requires human approval before it can run.`, {
          approvalRequestId: request.id,
          link: `?page=approvals&id=${request.id}`,
        });
      }

      return invokeBinding(service, operation, actor, input);
    },
  };
}

/** Writes the terminal `conflict` outcome on the already-locked row, inside the caller's own transaction, and returns the same shape a caller of this module gets back — never throws, so the transaction that wrote it commits. */
async function terminalizeConflict(
  client: Parameters<typeof databaseArchiveWithClient>[0],
  id: string,
  details: Record<string, unknown>,
): Promise<{ error: true; result: string }> {
  const executionResult = { error: { code: "version_conflict", details } };
  const result = await client.query(
    `UPDATE approval_requests
        SET execution_status = 'conflict', execution_result = $2::jsonb, executed_at = now()
      WHERE id = $1`,
    [id, JSON.stringify(executionResult)],
  );
  requireAffectedRows(result, `terminalizing approval request '${id}' as conflict`);
  return { error: true, result: JSON.stringify(executionResult) };
}

/**
 * `ApprovedOperationExecutor` (issue #89, the `approvalExecute` job's actual handler for a
 * generic-operation approval request — replacing this function's own former binding-replay
 * internals while keeping its exported name/signature so `worker.ts`'s
 * `GenericOperationApprovalReplay` contract, and every composition root injecting it, are
 * untouched): opens **one** transaction, row-locks the request (`getApprovalRequest(client, id,
 * true)`), and:
 *
 * - returns the persisted `execution_result` unmutated, without ever touching the resource, when
 *   the row is already `succeeded`/`conflict`/`legacy_terminal` — a redelivered queue job is a
 *   deterministic no-op, never a second mutation;
 * - rejects (throws, rolling back the transaction) when the row is missing/malformed or is not
 *   `approved`+`queued` — the caller (`handleApprovalRequestExecuteTask`) discards this function's
 *   resolved value and relies solely on whether the returned promise rejects to decide whether
 *   graphile-worker retries the job, so nothing here may swallow a thrown error into a normal-
 *   looking `{error: true, ...}` return: doing so would report success to graphile for a row that
 *   is, in fact, still stuck `queued` with no job left to ever retry it;
 * - otherwise revalidates the persisted actor provenance against the current `agent_run` row
 *   (`owner_violation` on drift, same as before), re-authorizes the resource with the exact same
 *   `computeDestructiveResourceProjection` check the request-time preflight ran, and requires the
 *   freshly computed `resourceSnapshot` to equal the one persisted at approval time;
 * - a snapshot mismatch, or any `ChokePointError` raised while revalidating (`not_found`,
 *   `owner_violation`, `schema_locked`, `property_locked`, `database_archived`,
 *   `version_conflict`, `validation_failed`, or any other code this catalog's checks might ever
 *   raise), terminalizes the request as `conflict` and commits — no mutation ever runs. Only an
 *   infrastructure failure (a lost connection, a bug) propagates out of the transaction, rolling
 *   it back so the row stays `queued` for graphile's own retry.
 * - on a clean revalidation, executes the same `*WithClient` function the choke-point's own public
 *   API delegates to, on this same transaction and client, then marks `succeeded` and commits — the
 *   mutation and its terminal-state write land in the same commit, so a crash before commit rolls
 *   both back together (staying `queued`) and a crash after commit is safe (nothing left to redo).
 */
export async function replayApprovedGenericOperation(
  pool: Pool,
  request: ApprovalRequest & { payload: GenericOperationApprovalRequestPayload },
): Promise<{ error: boolean; result: string }> {
  return await withTransaction(pool, async (client) => {
    const locked = await getApprovalRequest(client, request.id, true);
    if (!locked || !isGenericOperationApprovalRequestPayload(locked.payload)) {
      throw new NotFoundError(`Approval request '${request.id}' not found`);
    }

    if (
      locked.executionStatus === "succeeded" ||
      locked.executionStatus === "conflict" ||
      locked.executionStatus === "legacy_terminal"
    ) {
      return { error: locked.executionStatus !== "succeeded", result: JSON.stringify(locked.executionResult) };
    }
    if (locked.status !== "approved" || locked.executionStatus !== "queued") {
      throw new ForbiddenError(`Approval request '${request.id}' is not approved and queued for execution`);
    }

    // Every domain failure from here on (a malformed/no-longer-valid stored payload, drifted
    // actor provenance, or the resource's own authorization) is a terminal conflict, not a
    // reason to roll back and leave the row `queued` forever for graphile to retry
    // indefinitely against a request that can never revalidate cleanly — only an
    // infrastructure failure (a lost connection, a bug) should escape this transaction.
    try {
      const { actor, operationName, canonicalInput } = locked.payload;
      const operation = assertGenericOperationName(operationName);
      if (!isDestructiveOperationName(operation)) {
        throw new ValidationError(
          `Operation '${operation}' in approval request payload is not a destructive operation`,
        );
      }
      const input = parseInput(operation, canonicalInput);

      const run = await getAgentRun(client, locked.agentRunId, true);
      if (
        !run ||
        locked.agentRunId !== actor.runId ||
        run.projectItemId !== actor.agentProjectItemId ||
        run.actorUserId !== actor.userId
      ) {
        throw new ForbiddenError(
          `Approval request '${request.id}' no longer matches its run's persisted provenance`,
          undefined,
          "owner_violation",
        );
      }

      const dataActor = toActor({ userId: actor.userId, agentProjectItemId: actor.agentProjectItemId });
      const check = buildDestructiveCheck(operation, input, dataActor);
      const { currentResource, snapshot } = await computeDestructiveResourceProjection(client, check);

      if (
        snapshot.kind !== locked.resourceSnapshot.kind ||
        snapshot.resourceId !== locked.resourceSnapshot.resourceId ||
        snapshot.sha256 !== locked.resourceSnapshot.sha256
      ) {
        return await terminalizeConflict(client, locked.id, { currentResource });
      }

      const result = await executeDestructiveWithClient(
        client,
        operation,
        input,
        dataActor,
        actor.userId,
        currentResource,
      );
      const executionResult = { result };
      const updateResult = await client.query(
        `UPDATE approval_requests
            SET execution_status = 'succeeded', execution_result = $2::jsonb, executed_at = now()
          WHERE id = $1`,
        [locked.id, JSON.stringify(executionResult)],
      );
      requireAffectedRows(updateResult, `marking approval request '${locked.id}' succeeded`);
      return { error: false, result: JSON.stringify(executionResult) };
    } catch (err) {
      if (err instanceof ChokePointError) {
        return await terminalizeConflict(client, locked.id, { reason: err.code, currentResource: null });
      }
      throw err;
    }
  });
}
