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
  createPendingApprovalRequestAndPublish,
  publishApprovalRequestChange,
  approvalNotificationBody,
  approvalNotificationLinkHref,
  buildDestructiveApprovalDescription,
  changeValueLinkWithClient,
  computeJournalMergeProjection,
  computePageConvertProjection,
  computePageReplaceProjection,
  convertPageToBlockWithClient,
  databaseArchiveWithClient,
  createRelationWithClient,
  deleteRelationWithClient,
  getAgentRun,
  getApprovalRequest,
  getApprovalRequestSourceKind,
  getTenantUserId,
  isGenericOperationApprovalRequestPayload,
  itemDeleteWithClient,
  markApprovalRequestExecutionSucceeded,
  mergeApprovedJournalDuplicates,
  propertyDeleteWithClient,
  postApprovalOutcomeMessage,
  replacePageMarkdown,
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
  type JournalMergeCheck,
  type PageConvertCheck,
  type PageReplaceCheck,
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
  | "page.replace"
  | "page.convertToBlock"
  | "page.mergeJournalDuplicates"
  | "item.patch"
  | "relation.put"
  | "relation.set"
  | "link.unlink";

/** The operations whose request, when it ends value links, is a `breaksLink` request. */
const LINK_DEFERRAL_OPERATIONS: readonly GenericOperationName[] = [
  "item.patch",
  "relation.put",
  "relation.set",
  "link.unlink",
];

function isDestructiveOperationName(operation: GenericOperationName): operation is DestructiveOperationName {
  return (
    operation === "database.archive" ||
    operation === "property.delete" ||
    operation === "view.delete" ||
    operation === "item.delete" ||
    operation === "relation.delete" ||
    operation === "page.restoreVersion" ||
    operation === "page.replace" ||
    operation === "page.convertToBlock" ||
    operation === "page.mergeJournalDuplicates" ||
    operation === "item.patch" ||
    operation === "relation.put" ||
    operation === "relation.set" ||
    operation === "link.unlink"
  );
}

/** A destructive check projected by the choke point, the docs module (page restore/replace/convert) or the Journal module (merge); `chokePoint` may not import `docs` or `journal`. */
type GatewayCheck =
  DestructiveOperationCheck | PageRestoreCheck | PageReplaceCheck | PageConvertCheck | JournalMergeCheck;

/** The approval snapshot of one destructive check, computed by the module that owns the resource. */
function projectCheck(client: PoolClient, check: GatewayCheck): Promise<DestructiveResourceProjection> {
  switch (check.operation) {
    case "page.restoreVersion":
      return computePageRestoreProjection(client, check);
    case "page.replace":
      return computePageReplaceProjection(client, check);
    case "page.convertToBlock":
      return computePageConvertProjection(client, check);
    case "page.mergeJournalDuplicates":
      return computeJournalMergeProjection(client, check);
    default:
      return computeDestructiveResourceProjection(client, check);
  }
}

/** Maps a destructive operation's validated input onto the check both request-time snapshotting and execution-time revalidation run; `actor` is used only by `view.delete`. */
function buildDestructiveCheck(operation: DestructiveOperationName, input: unknown, actor: Actor): GatewayCheck {
  switch (operation) {
    case "page.restoreVersion":
      return {
        operation,
        input: input as { itemId: string; at: string },
        agentProjectItemId: actor.agentProjectItemId,
      };
    case "page.replace":
      return {
        operation,
        input: input as InputByOperation["page.replace"],
        agentProjectItemId: actor.agentProjectItemId,
      };
    case "page.convertToBlock":
      return {
        operation,
        input: input as InputByOperation["page.convertToBlock"],
        agentProjectItemId: actor.agentProjectItemId,
      };
    case "page.mergeJournalDuplicates":
      return {
        operation,
        input: input as InputByOperation["page.mergeJournalDuplicates"],
        agentProjectItemId: actor.agentProjectItemId,
      };
    case "database.archive":
      return { operation, input: input as { databaseId: string } };
    case "property.delete":
      return { operation, input: input as { propertyId: string } };
    case "view.delete":
      return { operation, input: input as { viewId: string }, actor };
    case "item.delete":
      return { operation, input: input as { itemId: string }, agentProjectItemId: actor.agentProjectItemId };
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
        agentProjectItemId: actor.agentProjectItemId,
      };
    case "link.unlink":
      return {
        operation,
        input: input as InputByOperation["link.unlink"],
        agentProjectItemId: actor.agentProjectItemId,
      };
  }
}

/** Runs the destructive mutation on the caller's transaction through the same `*WithClient` function the choke point's public API uses. */
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
        { writer, queueAffinity: createActionQueueAffinity(), actingUserId },
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
      // Authored `user`: the approver's decision is the user's.
      const { itemId, at } = input as { itemId: string; at: string };
      return restorePageVersionWithClient(client, itemId, new Date(at));
    }
    case "page.replace": {
      // Authored `user`, as the restore: the approver's decision is the user's.
      const { itemId, markdown, expectedEtag } = input as InputByOperation["page.replace"];
      return replacePageMarkdown(client, itemId, { markdown, expectedEtag, origin: "user", writer, actingUserId });
    }
    case "page.convertToBlock":
      // Authored `user`, as the replace; the page tree is trashed as the agent that asked, so the trash hooks and the
      // grant check see it.
      return convertPageToBlockWithClient(client, input as InputByOperation["page.convertToBlock"], {
        origin: "user",
        writer,
        actingUserId,
      });
    case "page.mergeJournalDuplicates":
      // The replay must merge the entries its projection found; a drift throws and rolls back, and the next attempt
      // ends the request as a conflict.
      return mergeApprovedJournalDuplicates(
        client,
        input as InputByOperation["page.mergeJournalDuplicates"],
        currentResource,
        writer,
      );
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
    case "link.unlink": {
      // An approved request is only ever replayed as the agent that asked.
      if (writer.writerKind === "system") throw new Error("link.unlink is not replayed as a system write");
      return changeValueLinkWithClient(
        client,
        input as InputByOperation["link.unlink"],
        "unlink",
        { ...writer, writerKind: writer.writerKind },
        actingUserId,
      );
    }
  }
}

/**
 * The `currentResource` projection a non-not-found domain error carries in `details`, reported on a
 * conflict; `null` when absent (e.g. `not_found`, which loads no resource).
 */
function currentResourceFromErrorDetails(details: unknown): unknown {
  if (typeof details === "object" && details !== null && "currentResource" in details) {
    return details.currentResource;
  }
  return null;
}

/**
 * Whether this gateway serves `operation` under `grantedCapabilities`. REST-only operations
 * (`REST_ONLY_OPERATION_NAMES`: adding and changing select options) are served under no grant, so
 * AgentTool and MCP neither list nor call them.
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

/** Checks a stored `operationName` against the closed catalog: it came back through a `jsonb` column. */
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
 * `DestructiveApprovalPreflight`: first revalidates the persisted actor provenance against the
 * current `agent_run` row (as execution will), so a request that could only end in
 * `owner_violation` is rejected instead of queued for approval. Then runs the resource projection
 * and its guards and, in the same transaction, inserts the pending request and its
 * `approval_pending` notification (link from `approvalNotificationLinkHref`). For a flagged
 * non-destructive write the original transaction already passed its preceding guards; replay runs
 * the writer's guards again. The request is announced after commit; a replayed tool call announces
 * nothing.
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
    const { snapshot, currentResource, valueLinks } = await projectCheck(client, check);

    const payload: GenericOperationApprovalRequestPayload = {
      operationName: operation,
      canonicalInput: input,
      actor: { runId: actor.runId!, agentProjectItemId: actor.agentProjectItemId, userId: actor.userId },
      resourceSnapshot: snapshot,
    };
    const description = await buildDestructiveApprovalDescription(client, check, currentResource, valueLinks);
    // A write that would end a value link is a `breaksLink` request; a `relation.delete` that ends one stays
    // `destructive` and only carries the link lists in its description.
    const endsLinks = valueLinks !== undefined && LINK_DEFERRAL_OPERATIONS.includes(operation);
    const created = await createPendingApprovalRequestAndPublish(client, {
      agentRunId: actor.runId!,
      toolName: operation,
      riskClass: endsLinks ? "breaksLink" : metadata.riskClass,
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
        linkHref: approvalNotificationLinkHref(
          await getApprovalRequestSourceKind(client, created.agentRunId),
          created.id,
        ),
        sourceTable: "approval_requests",
        sourceId: created.id,
        transitionInstance: created.id,
      });
    }
    return created;
  });
}

export interface GenericOperationGateway {
  /** The operations visible under `grantedCapabilities`; ungranted and REST-only ones are absent, never forbidden. */
  listOperations(grantedCapabilities: ReadonlySet<CapabilityId>): GenericOperationName[];
  /**
   * Dispatches one operation for an agent actor: capability-gates, then for a destructive operation
   * queues a pending approval request and throws `ApprovalRequiredError`. The AgentTool root turns
   * that into a synthetic success; MCP surfaces it as a JSON-RPC error.
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
 * The gateway the AgentTool and MCP composition roots build over their `Pool`, between
 * capability/approval and `GenericApplicationPort`. REST calls the port directly: a REST actor
 * never carries `agentProjectItemId`, which is what the approval check keys on.
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
        // An operation outside the deferrable set (`item.create` with initial relations) has no snapshot or replay, so
        // its flagged write is refused with a defined error; the transaction rolled back and no request exists.
        if (!isDestructiveOperationName(operation)) {
          throw new ValidationError(
            `Operation '${operation}' cannot ask for the approval this write requires; write the parts that need approval with their own operations`,
            { reasons: err.reasons },
          );
        }
        if (actor.runId === undefined || actor.agentProjectItemId === undefined) throw err;
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
 * `ApprovedOperationExecutor`, the `approvalExecute` handler for a generic-operation request. In
 * one transaction it row-locks the request and:
 *
 * - returns the persisted `execution_result` untouched when the row is already
 *   `succeeded`/`conflict`, so a redelivered job never mutates twice;
 * - throws when the row is missing, malformed, or not `approved`+`queued`. The caller retries
 *   solely on rejection, so no error may be turned into a normal-looking return, or a row could
 *   stay `queued` with no job left to retry it;
 * - otherwise revalidates actor provenance against `agent_run` (`owner_violation` on drift),
 *   reruns the preflight's `computeDestructiveResourceProjection`, and requires the snapshot to
 *   equal the persisted one. A mismatch or revalidation domain error ends the request as
 *   `conflict` before mutation; a transient reservation refusal or infrastructure failure escapes
 *   so the row stays `queued` for retry;
 * - on success runs the `*WithClient` mutation on the same transaction and marks `succeeded`, so
 *   mutation and terminal state commit together.
 *
 * Each terminal write is announced to the owner after commit; an already-terminal request writes
 * and announces nothing.
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

    if (locked.executionStatus === "succeeded" || locked.executionStatus === "conflict") {
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
      await publishApprovalRequestChange(client, locked);
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
        ...(LINK_DEFERRAL_OPERATIONS.includes(operation) ? { approvedRequestId: locked.id } : {}),
      },
    );
    const outcome = await markApprovalRequestExecutionSucceeded(client, locked.id, result);
    await postApprovalOutcomeMessage(client, locked, "executed");
    await publishApprovalRequestChange(client, locked);
    return outcome;
  });
}
