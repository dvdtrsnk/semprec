import type { CollectionMetadataResolver } from "@semprec/data";
import type { Pool, PoolClient } from "pg";
import {
  ApprovalRequiredError,
  ApprovalResourceBusyError,
  ApprovalRequiredForWrite,
  ChokePointError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  computeDestructiveResourceProjection,
  computePageRestoreProjection,
  createActionQueueAffinity,
  createPendingApprovalRequest,
  approvalNotificationBody,
  buildDestructiveApprovalDescription,
  databaseArchiveWithClient,
  createRelationWithClient,
  deleteRelationWithClient,
  getAgentRun,
  getApprovalRequest,
  getTenantUserId,
  isGenericOperationApprovalRequestPayload,
  itemDeleteWithClient,
  markApprovalRequestExecutionSucceeded,
  propertyDeleteWithClient,
  postApprovalOutcomeMessage,
  restorePageVersionWithClient,
  setRelationWithClient,
  terminalizeApprovalRequestAsConflict,
  viewDeleteWithClient,
  updateItemWithClient,
  withTransaction,
  writeNotification,
  type Actor,
  type WriterIdentity,
  type ApprovalRequest,
  type DestructiveOperationCheck,
  type DestructiveResourceProjection,
  type GenericOperationApprovalRequestPayload,
  type PageRestoreCheck,
} from "@semprec/data";
import {
  GENERIC_OPERATION_BINDINGS,
  GENERIC_OPERATION_NAMES,
  OPERATION_METADATA,
  REST_ONLY_OPERATION_NAMES,
  type AuthenticatedActor,
  type CapabilityId,
  type GenericApplicationPort,
  type GenericOperationName,
  type InputByOperation,
  type OutputByOperation,
  type ValidationIssueLike,
  validationIssueField,
} from "@semprec/shared";
import { createGenericApplicationService, toActor } from "./genericApplicationService.js";

/** Operations whose approval snapshots and transactional replay are supported. */
type DestructiveOperationName =
  | "database.archive"
  | "property.delete"
  | "view.delete"
  | "item.delete"
  | "relation.delete"
  | "page.restoreVersion"
  | "item.patch"
  | "relation.put"
  | "relation.set";

function isDestructiveOperationName(operation: GenericOperationName): operation is DestructiveOperationName {
  return (
    operation === "database.archive" ||
    operation === "property.delete" ||
    operation === "view.delete" ||
    operation === "item.delete" ||
    operation === "relation.delete" ||
    operation === "page.restoreVersion" ||
    operation === "item.patch" ||
    operation === "relation.put" ||
    operation === "relation.set"
  );
}

/** A destructive check the choke point's own projection covers, or the page restore's, which the docs module projects (`chokePoint` may not import `docs`). */
type GatewayCheck = DestructiveOperationCheck | PageRestoreCheck;

/** The approval snapshot of one destructive check, computed by the module that owns the resource. */
function projectCheck(client: PoolClient, check: GatewayCheck): Promise<DestructiveResourceProjection> {
  return check.operation === "page.restoreVersion"
    ? computePageRestoreProjection(client, check)
    : computeDestructiveResourceProjection(client, check);
}

/** Maps one destructive operation's already-validated input (plus the data-layer `Actor` form of the caller, needed only by `view.delete`'s writability check) onto the shared projection/authorization check both request-time snapshotting and execution-time revalidation run. */
function buildDestructiveCheck(operation: DestructiveOperationName, input: unknown, actor: Actor): GatewayCheck {
  switch (operation) {
    case "page.restoreVersion":
      return { operation, input: input as { itemId: string; at: string } };
    case "database.archive":
      return { operation, input: input as { databaseId: string } };
    case "property.delete":
      return { operation, input: input as { propertyId: string } };
    case "view.delete":
      return { operation, input: input as { viewId: string }, actor };
    case "item.delete":
      return { operation, input: input as { itemId: string } };
    case "item.patch":
      return { operation, input: input as InputByOperation["item.patch"] };
    case "relation.put":
      return { operation, input: input as { relationPropertyId: string; callerItemId: string; targetItemId: string } };
    case "relation.set":
      return {
        operation,
        input: input as { relationPropertyId: string; callerItemId: string; targetItemId: string | null },
      };
    case "relation.delete":
      return {
        operation,
        input: input as { relationPropertyId: string; callerItemId: string; targetItemId: string },
      };
  }
}

/** Runs the actual destructive mutation on the caller's own transaction — the same `*WithClient` function the choke-point's public API delegates to, so approval-gated execution and a direct call share one implementation. */
async function executeDestructiveWithClient(
  client: PoolClient,
  operation: DestructiveOperationName,
  input: unknown,
  actor: Actor,
  actingUserId: string | undefined,
  currentResource: unknown,
  writer: WriterIdentity,
): Promise<unknown> {
  switch (operation) {
    case "item.patch": {
      const { item } = currentResource as { item: { databaseId: string } };
      const patch = input as InputByOperation["item.patch"];
      const commandSnapshot =
        typeof currentResource === "object" && currentResource !== null && "command" in currentResource;
      return updateItemWithClient(
        client,
        {
          databaseId: item.databaseId,
          itemId: patch.itemId,
          propertiesPatch: patch.properties,
          ...(commandSnapshot ? { ifVersion: patch.ifVersion } : {}),
        },
        { writer, queueAffinity: createActionQueueAffinity() },
      );
    }
    case "relation.put":
      return createRelationWithClient(
        client,
        input as InputByOperation["relation.put"],
        undefined,
        writer,
        actingUserId,
      );
    case "relation.set":
      return setRelationWithClient(client, input as InputByOperation["relation.set"], writer, actingUserId);
    case "page.restoreVersion": {
      // Authored `user`: the approver's decision is the user's (issue #1617).
      const { itemId, at } = input as { itemId: string; at: string };
      return restorePageVersionWithClient(client, itemId, new Date(at));
    }
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
        writer,
      });
    }
    case "relation.delete":
      return deleteRelationWithClient(
        client,
        input as { relationPropertyId: string; callerItemId: string; targetItemId: string },
        undefined,
        writer,
        actingUserId,
      );
  }
}

/**
 * Extracts the `currentResource` projection `computeDestructiveResourceProjection` attaches to a
 * non-not-found domain error's `details` (issue #89: "otherwise it is the current projection"), so
 * `replayApprovedGenericOperation`'s conflict terminalization can report it instead of always
 * reporting `null`. A `details` shape without `currentResource` (e.g. `not_found`, which never
 * loads a resource to report) falls back to `null`, matching the spec's `not_found` case exactly.
 */
function currentResourceFromErrorDetails(details: unknown): unknown {
  if (typeof details === "object" && details !== null && "currentResource" in details) {
    return details.currentResource;
  }
  return null;
}

/**
 * Whether this gateway serves `operation` under `grantedCapabilities`. A REST-only operation
 * (`REST_ONLY_OPERATION_NAMES`: adding and changing select options, issue #1699) is served under no grant, so the
 * AgentTool and MCP transports, which reach the catalog through this gateway, neither list nor call it. The
 * assistant will propose a new option on an Inbox proposal instead (#1994).
 */
function isGranted(operation: GenericOperationName, grantedCapabilities: ReadonlySet<CapabilityId>): boolean {
  if (REST_ONLY_OPERATION_NAMES.some((restOnly) => restOnly === operation)) return false;
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
        | { success: false; error: { issues: (ValidationIssueLike & { message: string })[] } };
    };
  };
  const parsed = binding.input.safeParse(raw);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const field = validationIssueField(parsed.error.issues);
    if (operation === "database.patch" && firstIssue?.params?.reason === "empty_patch") {
      throw new ValidationError(firstIssue.message, { reason: "empty_patch" });
    }
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
 * `DestructiveApprovalPreflight` (issue #89): revalidates the persisted actor provenance against
 * the current `agent_run` row first — the same check execution later repeats — so a request whose
 * actor can never pass that check at execution time is rejected here instead of being queued for a
 * human to approve something that can only end in `owner_violation`. Only then runs the exact
 * resource projection and its guards before, in the same transaction, inserting the pending
 * approval request plus its `approval_pending` notification, carrying the resulting
 * `resourceSnapshot`. For a flagged non-destructive write the original transaction has already
 * reached the flag after its preceding write guards; replay also runs the actual writer's guards.
 */
async function preflightDestructiveApproval(
  pool: Pool,
  operation: DestructiveOperationName,
  actor: AuthenticatedActor,
  input: unknown,
  reason: string | null,
  toolCallId: string | null,
): Promise<ApprovalRequest> {
  const metadata = OPERATION_METADATA[operation];
  return withTransaction(pool, async (client) => {
    const run = await getAgentRun(client, actor.runId!);
    if (!run || run.projectItemId !== actor.agentProjectItemId || run.actorUserId !== actor.userId) {
      throw new ForbiddenError(
        `Actor for operation '${operation}' does not match run '${actor.runId}'s persisted provenance`,
        undefined,
        "owner_violation",
      );
    }

    const check = buildDestructiveCheck(operation, input, toActor(actor));
    const { snapshot, currentResource } = await projectCheck(client, check);

    const payload: GenericOperationApprovalRequestPayload = {
      operationName: operation,
      canonicalInput: input,
      actor: { runId: actor.runId!, agentProjectItemId: actor.agentProjectItemId, userId: actor.userId },
      resourceSnapshot: snapshot,
    };
    const description = await buildDestructiveApprovalDescription(client, check, currentResource);
    const created = await createPendingApprovalRequest(client, {
      agentRunId: actor.runId!,
      toolName: operation,
      riskClass: metadata.riskClass,
      payload,
      resourceSnapshot: snapshot,
      reason,
      toolCallId,
      description,
    });

    const userId = await getTenantUserId(client);
    if (userId) {
      await writeNotification(client, {
        userId,
        kind: "approval_pending",
        ...approvalNotificationBody(created),
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
  /** The operations visible given `grantedCapabilities` — an ungranted one is simply absent, never present-but-forbidden, and so is a REST-only one under every grant. */
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
    /**
     * `reason`: the agent's reason for an approval-gated call, already stripped from `raw`; stored on the request only, never in the operation input.
     * `toolCallId`: the model-runtime tool call, stored on a created approval request; REST and `/mcp` pass none.
     */
    options?: { reason?: string; toolCallId?: string },
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
export function createGenericOperationGateway(
  pool: Pool,
  resolver: CollectionMetadataResolver,
): GenericOperationGateway {
  const service = createGenericApplicationService(pool, resolver);

  return {
    listOperations(grantedCapabilities) {
      return GENERIC_OPERATION_NAMES.filter((operation) => isGranted(operation, grantedCapabilities));
    },

    async invoke(operation, actor, grantedCapabilities, raw, options) {
      if (!isGranted(operation, grantedCapabilities)) {
        throw new NotFoundError(`Unknown operation '${operation}'`);
      }
      assertCompleteAgentIdentity(actor);

      const input = parseInput(operation, raw);
      const metadata = OPERATION_METADATA[operation];

      if (metadata.requiresApproval && actor.runId !== undefined && actor.agentProjectItemId !== undefined) {
        if (!isDestructiveOperationName(operation)) {
          throw new ValidationError(
            `Operation '${operation}' is flagged as approval-requiring but is not a destructive kind`,
          );
        }
        const request = await preflightDestructiveApproval(
          pool,
          operation,
          actor,
          input,
          options?.reason ?? null,
          options?.toolCallId ?? null,
        );
        throw new ApprovalRequiredError(`Operation '${operation}' requires human approval before it can run.`, {
          approvalRequestId: request.id,
          link: `?page=approvals&id=${request.id}`,
        });
      }

      try {
        return await invokeBinding(service, operation, actor, input);
      } catch (err) {
        if (!(err instanceof ApprovalRequiredForWrite)) throw err;
        if (
          !isDestructiveOperationName(operation) ||
          actor.runId === undefined ||
          actor.agentProjectItemId === undefined
        )
          throw err;
        const request = await preflightDestructiveApproval(
          pool,
          operation,
          actor,
          input,
          options?.reason ?? null,
          options?.toolCallId ?? null,
        );
        throw new ApprovalRequiredError(`Operation '${operation}' requires human approval before it can run.`, {
          approvalRequestId: request.id,
          link: `?page=approvals&id=${request.id}`,
        });
      }
    },
  };
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
 * - a snapshot mismatch or revalidation domain error terminalizes the request as `conflict`
 *   before mutation. A transient approval reservation refusal or infrastructure failure escapes,
 *   so the transaction rolls back and the row stays `queued` for graphile's own retry.
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
    const lockedPayload = locked.payload;

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

    // Only revalidation errors become terminal conflicts. A mutation error must escape so
    // the managed transaction discards writes and its registered after-commit effects.
    const checked = await (async () => {
      try {
        const { actor, operationName, canonicalInput } = lockedPayload;
        const operation = assertGenericOperationName(operationName);
        if (!isDestructiveOperationName(operation)) {
          throw new ValidationError(
            `Operation '${operation}' in approval request payload is not a supported operation`,
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
        const { currentResource, snapshot } = await projectCheck(
          client,
          buildDestructiveCheck(operation, input, dataActor),
        );
        if (
          snapshot.kind !== locked.resourceSnapshot.kind ||
          snapshot.resourceId !== locked.resourceSnapshot.resourceId ||
          snapshot.sha256 !== locked.resourceSnapshot.sha256
        ) {
          return { kind: "conflict" as const, details: { currentResource } };
        }
        return { kind: "ready" as const, operation, input, actor, dataActor, currentResource };
      } catch (err) {
        if (err instanceof ApprovalResourceBusyError) throw err;
        if (err instanceof ChokePointError) {
          return {
            kind: "conflict" as const,
            details: { reason: err.code, currentResource: currentResourceFromErrorDetails(err.details) },
          };
        }
        throw err;
      }
    })();
    if (checked.kind === "conflict") {
      const outcome = await terminalizeApprovalRequestAsConflict(client, locked.id, checked.details);
      await postApprovalOutcomeMessage(client, locked, "conflict");
      return outcome;
    }
    const { operation, input, actor, dataActor, currentResource } = checked;
    const result = await executeDestructiveWithClient(
      client,
      operation,
      input,
      dataActor,
      actor.userId,
      currentResource,
      {
        writerKind: "agent",
        agentRunId: locked.agentRunId,
        agentProjectItemId: actor.agentProjectItemId,
        onBehalfOfUserId: actor.userId,
        ...(operation === "item.patch" || operation === "relation.put" || operation === "relation.set"
          ? { approvedRequestId: locked.id }
          : {}),
      },
    );
    const outcome = await markApprovalRequestExecutionSucceeded(client, locked.id, result);
    await postApprovalOutcomeMessage(client, locked, "executed");
    return outcome;
  });
}
