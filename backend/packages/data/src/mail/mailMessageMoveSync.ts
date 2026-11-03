import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { logger } from "./logger.js";
import { lockMailThreadMutation } from "./mailThreadMutationGuard.js";
import { withTransaction } from "../db/pool.js";
import type { ImapMailClient } from "./imapReconcile.js";
import {
  hasGmailMovePreparer,
  hasGraphMovePreparer,
  prepareGmailMove,
  prepareGraphMove,
  selectImapMoveProtocol,
} from "./mailMoveProviderAdapters.js";
import type { GmailMailClient } from "./gmailReconcile.js";
import type { GmailMoveResult } from "./mailMoveProviderAdapters.js";
import {
  checkpointMailMoveStep,
  claimMailMoveStep,
  completeGmailMove,
  completeGraphMove,
  completeImapMove,
  markMoveConfirmed,
  refuseClaimedImapCapability,
  retainImapCapabilityCheckpoint,
  confirmObservedProviderMove,
  listPendingMoves,
  markMailMoveUncertain,
  markMoveAttemptFailed,
  type MailMessageMoveSyncRow,
  type MailMoveEvidence,
  type MailMovePurpose,
  type MailMoveStep,
} from "./mailMessageMoveSyncStore.js";

function gmailMatches(
  purpose: MailMovePurpose,
  state: Extract<GmailMoveResult, { kind: "found" | "acknowledged" }>,
): boolean {
  switch (purpose) {
    case "archive":
      return !state.inInbox;
    case "trash":
      return state.inTrash;
    case "inbox":
      return !state.inTrash && state.inInbox;
    case "sent":
      return !state.inTrash && state.inSent;
  }
}

function gmailEvidence(
  id: string,
  state: Extract<GmailMoveResult, { kind: "found" | "acknowledged" }>,
): MailMoveEvidence {
  return { provider: "gmail", messageId: id, inTrash: state.inTrash, inInbox: state.inInbox, inSent: state.inSent };
}

/** Drains Gmail moves in short transactions around separately owned provider commands. */
export async function drainGmailMoves(pool: Pool, mailboxItemId: string, gmail: GmailMailClient): Promise<void> {
  const rows = await withTransaction(pool, (client) => listPendingMoves(client, mailboxItemId));
  if (rows.length === 0) return;
  if (!gmail.observeMoveMessage || !hasGmailMovePreparer(gmail)) throw new Error("Gmail move adapter is unavailable");
  for (const row of rows) await drainGmailMove(pool, gmail, row);
}

async function drainGmailMove(pool: Pool, gmail: GmailMailClient, row: MailMessageMoveSyncRow): Promise<void> {
  if (row.source_evidence.provider !== "gmail" || !gmail.observeMoveMessage || !hasGmailMovePreparer(gmail)) return;
  const sourceId = row.source_evidence.providerMessageId;
  if (row.operation_phase === "in_flight" || row.operation_phase === "uncertain") return;
  let token = row.operation_token;
  let revision = row.captured_revision;
  let purpose = row.captured_purpose;
  let step: MailMoveStep;
  let evidence: MailMoveEvidence;
  if (row.operation_phase === "between_steps") {
    if (!token || !revision || !purpose || row.operation_evidence?.provider !== "gmail" || !row.operation_step) return;
    step = row.operation_step;
    evidence = row.operation_evidence;
  } else {
    const observed = await gmail.observeMoveMessage(sourceId);
    if (observed.kind === "missing") {
      await withTransaction(pool, (client) =>
        markMoveAttemptFailed(client, row.message_item_id, row.desired_revision, "messageMissing"),
      );
      return;
    }
    if (observed.kind !== "found") return;
    if (gmailMatches(row.desired_purpose, observed)) {
      await withTransaction(pool, (client) =>
        confirmObservedProviderMove(client, {
          messageItemId: row.message_item_id,
          revision: row.desired_revision,
          providerMessageId: sourceId,
        }),
      );
      return;
    }
    if (row.desired_purpose === "sent" && !observed.inSent) {
      await withTransaction(pool, (client) =>
        markMoveAttemptFailed(client, row.message_item_id, row.desired_revision, "providerRejected"),
      );
      return;
    }
    token = randomUUID();
    revision = row.desired_revision;
    purpose = row.desired_purpose;
    evidence = gmailEvidence(sourceId, observed);
    step =
      purpose === "trash"
        ? "trash"
        : (purpose === "inbox" || purpose === "sent") && observed.inTrash
          ? "untrash"
          : "modify_labels";
  }
  if (!token || !revision || !purpose || evidence.provider !== "gmail") return;
  const command =
    step === "trash"
      ? "trash"
      : step === "untrash"
        ? "untrash"
        : step === "modify_labels" && purpose === "archive"
          ? "remove_inbox"
          : step === "modify_labels" && purpose === "inbox"
            ? "add_inbox"
            : null;
  if (!command) throw new Error("Invalid Gmail move step");
  const dispatch = await prepareGmailMove(gmail, evidence.messageId, command);
  const claimed = await withTransaction(pool, (client) =>
    claimMailMoveStep(client, {
      messageItemId: row.message_item_id,
      revision,
      token,
      step,
      evidence,
    }),
  );
  if (!claimed) return;
  const result = await dispatch();
  if (result.kind !== "acknowledged") {
    await withTransaction(pool, (client) => markMailMoveUncertain(client, row.message_item_id, token));
    return;
  }
  const nextEvidence = gmailEvidence(evidence.messageId, result);
  if (step === "untrash" && purpose === "inbox" && !result.inTrash && !result.inInbox) {
    const checkpointed = await withTransaction(pool, (client) =>
      checkpointMailMoveStep(client, {
        messageItemId: row.message_item_id,
        token,
        nextStep: "modify_labels",
        evidence: nextEvidence,
      }),
    );
    if (checkpointed) {
      const current = (await withTransaction(pool, (client) => listPendingMoves(client, row.mailbox_item_id))).find(
        (candidate) =>
          candidate.message_item_id === row.message_item_id &&
          candidate.operation_token === token &&
          candidate.operation_phase === "between_steps",
      );
      if (current) await drainGmailMove(pool, gmail, current);
    }
    return;
  }

  await withTransaction(pool, (client) =>
    completeGmailMove(client, {
      messageItemId: row.message_item_id,
      token,
      evidence: nextEvidence,
    }),
  );
}

/** Drains Graph moves using a verified local destination and durable request ownership. */
export async function drainGraphMoves(
  pool: Pool,
  mailboxItemId: string,
  graph: import("./graphReconcile.js").GraphMailClient,
  foldersDatabaseId: string,
  mailboxFolderPropertyId: string,
): Promise<void> {
  const rows = await withTransaction(pool, (client) => listPendingMoves(client, mailboxItemId));
  if (rows.length === 0) return;
  if (!graph.observeMoveMessage || !hasGraphMovePreparer(graph)) throw new Error("Graph move adapter is unavailable");
  const destinations = { archive: "archive", trash: "deleteditems", inbox: "inbox", sent: "sentitems" } as const;
  for (const row of rows) {
    if (row.source_evidence.provider !== "graph" || row.operation_token !== null) continue;
    const sourceId = row.source_evidence.providerMessageId;
    const target = await withTransaction(pool, (client) =>
      graphTarget(
        client,
        foldersDatabaseId,
        mailboxFolderPropertyId,
        mailboxItemId,
        row.message_item_id,
        row.desired_purpose,
      ),
    );
    if (!target) continue;
    const observed = await graph.observeMoveMessage(sourceId);
    if (observed.kind === "missing") {
      await withTransaction(pool, (client) =>
        markMoveAttemptFailed(client, row.message_item_id, row.desired_revision, "messageMissing"),
      );
      continue;
    }
    if (observed.kind !== "found") continue;
    if (observed.parentFolderId === target) {
      await withTransaction(pool, async (client) => {
        const current = await graphTarget(
          client,
          foldersDatabaseId,
          mailboxFolderPropertyId,
          mailboxItemId,
          row.message_item_id,
          row.desired_purpose,
        );
        if (current !== target) return false;
        return confirmObservedProviderMove(client, {
          messageItemId: row.message_item_id,
          revision: row.desired_revision,
          providerMessageId: sourceId,
        });
      });
      continue;
    }
    const token = randomUUID();
    const evidence: MailMoveEvidence = { provider: "graph", sourceId, targetFolderId: target };
    const dispatch = await prepareGraphMove(graph, sourceId, destinations[row.desired_purpose]);
    const claimed = await withTransaction(pool, async (client) => {
      const current = await graphTarget(
        client,
        foldersDatabaseId,
        mailboxFolderPropertyId,
        mailboxItemId,
        row.message_item_id,
        row.desired_purpose,
      );
      if (current !== target) return false;
      return claimMailMoveStep(client, {
        messageItemId: row.message_item_id,
        revision: row.desired_revision,
        token,
        step: "move",
        evidence,
      });
    });
    if (!claimed) continue;
    const result = await dispatch();
    if (result.kind !== "moved") {
      await withTransaction(pool, (client) => markMailMoveUncertain(client, row.message_item_id, token));
      continue;
    }
    await withTransaction(pool, (client) =>
      completeGraphMove(client, {
        messageItemId: row.message_item_id,
        token,
        resultId: result.id,
      }),
    );
  }
}

async function graphTarget(
  client: PoolClient,
  foldersDatabaseId: string,
  mailboxFolderPropertyId: string,
  mailboxItemId: string,
  messageItemId: string,
  purpose: MailMovePurpose,
): Promise<string | null> {
  await lockMailThreadMutation(client);
  await client.query(
    "SELECT 1 FROM mail_message_move_sync_state WHERE tenant_id = app_tenant_default() AND message_item_id = $1 FOR UPDATE",
    [messageItemId],
  );
  const found = await client.query<{ provider_id: unknown }>(
    `SELECT i.properties ->> 'providerId' AS provider_id FROM items i
     JOIN item_relations r ON (r.item_a = i.id OR r.item_b = i.id)
     JOIN relation_definitions d ON d.id = r.relation_definition_id
     WHERE i.tenant_id = app_tenant_default() AND r.tenant_id = app_tenant_default()
       AND i.database_id = $1 AND i.deleted_at IS NULL AND i.properties ->> 'specialPurpose' = $2
       AND (r.item_a = $3 OR r.item_b = $3) AND (d.property_id_a = $4 OR d.property_id_b = $4)
     LIMIT 2 FOR UPDATE OF i, r`,
    [foldersDatabaseId, purpose, mailboxItemId, mailboxFolderPropertyId],
  );
  const id = found.rows[0]?.provider_id;
  return found.rowCount === 1 && typeof id === "string" && id.length > 0 && id.length <= 1024 ? id : null;
}

/** Runs an IMAP move on a separately opened, exclusively owned connection. */
export async function drainImapMoves(
  pool: Pool,
  mailboxItemId: string,
  createClient: () => Promise<ImapMailClient>,
  foldersDatabaseId: string,
  mailboxFolderPropertyId: string,
  folderRelationPropertyId: string,
): Promise<void> {
  const rows = await withTransaction(pool, (client) => listPendingMoves(client, mailboxItemId));
  for (const row of rows) {
    if (
      row.source_evidence.provider !== "imap" ||
      row.operation_phase === "in_flight" ||
      row.operation_phase === "uncertain"
    )
      continue;
    const source = row.source_evidence;
    const imap = await createClient();
    let providerFailure: { value: unknown } | undefined;
    let operationFailure: { value: unknown } | undefined;
    let cleanupFailure: { value: unknown } | undefined;
    let markUncertain = false;
    let refusedCapability = false;
    let refusedAfterCopy = false;
    let token = row.operation_token;
    const perform = async (): Promise<void> => {
      if (!imap.prepareMove || !imap.executeMoveStep) throw new Error("IMAP move adapter is unavailable");
      const target = await withTransaction(pool, (client) =>
        imapTarget(
          client,
          foldersDatabaseId,
          mailboxFolderPropertyId,
          mailboxItemId,
          row.message_item_id,
          row.captured_purpose ?? row.desired_purpose,
        ),
      );
      if (!target) return;
      let prepared: Awaited<ReturnType<NonNullable<ImapMailClient["prepareMove"]>>>;
      try {
        prepared = await imap.prepareMove(source.path, source.uid);
      } catch (error) {
        providerFailure = { value: error };
        // The provider failure remains owned through connection cleanup.
        // eslint-disable-next-line preserve-caught-error
        throw new Error("IMAP move provider operation failed unexpectedly");
      }
      if (!prepared || prepared.uidValidity !== source.uidValidity) return;
      if (!prepared.found) return;
      const protocol = selectImapMoveProtocol(prepared.capabilities);
      if (row.operation_token === null && source.folderItemId === target.id) {
        await withTransaction(pool, async (client) => {
          const current = await imapTarget(
            client,
            foldersDatabaseId,
            mailboxFolderPropertyId,
            mailboxItemId,
            row.message_item_id,
            row.desired_purpose,
          );
          if (!current || current.id !== source.folderItemId || current.path !== source.path) return false;
          const verified = await client.query(
            `SELECT 1 FROM mail_folder_sync_state state
             JOIN item_relations edge ON (edge.item_a = state.item_id OR edge.item_b = state.item_id)
             JOIN relation_definitions def ON def.id = edge.relation_definition_id
             WHERE state.tenant_id = app_tenant_default() AND edge.tenant_id = app_tenant_default()
               AND state.item_id = $1 AND state.uidvalidity = $2 AND (edge.item_a = $3 OR edge.item_b = $3)
               AND edge.metadata ->> 'uid' = $4 AND (def.property_id_a = $5 OR def.property_id_b = $5)
             FOR UPDATE OF state, edge`,
            [
              source.folderItemId,
              source.uidValidity,
              row.message_item_id,
              String(source.uid),
              folderRelationPropertyId,
            ],
          );
          return (
            verified.rowCount === 1 && (await markMoveConfirmed(client, row.message_item_id, row.desired_revision))
          );
        });
        return;
      }
      if (protocol === "unsupportedCapability") {
        if (row.operation_token === null) {
          await withTransaction(pool, (client) =>
            markMoveAttemptFailed(client, row.message_item_id, row.desired_revision, "unsupportedCapability"),
          );
        }
        return;
      }
      const revision = row.captured_revision ?? row.desired_revision;
      const initialStep: MailMoveStep = row.operation_step ?? (protocol === "move" ? "move" : "copy");
      if (
        initialStep !== "move" &&
        initialStep !== "copy" &&
        initialStep !== "mark_deleted" &&
        initialStep !== "expunge"
      )
        return;
      let step: "move" | "copy" | "mark_deleted" | "expunge" = initialStep;
      let evidence: MailMoveEvidence = row.operation_evidence ?? {
        provider: "imap",
        sourceFolderId: source.folderItemId,
        targetFolderId: target.id,
        sourcePath: source.path,
        targetPath: target.path,
        sourceUid: source.uid,
        sourceUidValidity: source.uidValidity,
      };
      token ??= randomUUID();
      if (
        evidence.provider !== "imap" ||
        (step !== "move" && step !== "copy" && step !== "mark_deleted" && step !== "expunge")
      )
        return;
      for (;;) {
        const activeToken = token;
        const activeEvidence: Extract<MailMoveEvidence, { provider: "imap" }> = evidence;
        const claimed = await withTransaction(pool, async (client) => {
          const currentTarget = await imapTarget(
            client,
            foldersDatabaseId,
            mailboxFolderPropertyId,
            mailboxItemId,
            row.message_item_id,
            row.captured_purpose ?? row.desired_purpose,
          );
          if (
            !currentTarget ||
            currentTarget.id !== activeEvidence.targetFolderId ||
            currentTarget.path !== activeEvidence.targetPath ||
            (activeEvidence.targetUidValidity !== undefined &&
              currentTarget.uidValidity !== activeEvidence.targetUidValidity)
          )
            return false;
          return claimMailMoveStep(client, {
            messageItemId: row.message_item_id,
            revision,
            token: activeToken,
            step,
            evidence: activeEvidence,
          });
        });
        if (!claimed) break;
        markUncertain = true;
        let result: Awaited<ReturnType<NonNullable<ImapMailClient["executeMoveStep"]>>>;
        try {
          result = await imap.executeMoveStep(
            step,
            activeEvidence.sourcePath,
            activeEvidence.sourceUid,
            activeEvidence.sourceUidValidity,
            activeEvidence.targetPath,
          );
        } catch (error) {
          providerFailure = { value: error };
          break;
        }
        if (result.kind !== "acknowledged") {
          if (result.kind === "unsupportedCapability") {
            refusedCapability = true;
            refusedAfterCopy = activeEvidence.targetUid !== undefined;
            markUncertain = false;
          } else providerFailure = { value: undefined };
          break;
        }
        if ((step === "move" || step === "copy") && (!result.targetUid || !result.targetUidValidity)) break;
        evidence = {
          ...activeEvidence,
          ...(result.targetUid ? { targetUid: result.targetUid } : {}),
          ...(result.targetUidValidity ? { targetUidValidity: result.targetUidValidity } : {}),
        };
        if (step === "move" || step === "expunge") {
          await withTransaction(pool, (client) =>
            completeImapMove(client, {
              messageItemId: row.message_item_id,
              token: activeToken,
              evidence,
              folderRelationPropertyId,
            }),
          );
          markUncertain = false;
          break;
        }
        const nextStep: "mark_deleted" | "expunge" = step === "copy" ? "mark_deleted" : "expunge";
        const checkpointed = await withTransaction(pool, (client) =>
          checkpointMailMoveStep(client, {
            messageItemId: row.message_item_id,
            token: activeToken,
            nextStep,
            evidence,
          }),
        );
        markUncertain = false;
        if (!checkpointed) break;
        step = nextStep;
      }
    };
    try {
      await perform();
    } catch (error) {
      operationFailure = { value: error };
    } finally {
      try {
        await imap.close();
      } catch (error) {
        cleanupFailure = { value: error };
      }
    }
    if (operationFailure) {
      void providerFailure;
      void cleanupFailure;
      throw operationFailure.value;
    }
    if (cleanupFailure) {
      void cleanupFailure;
      throw new Error("IMAP move provider cleanup failed unexpectedly");
    }
    const finalToken = token;
    if (refusedCapability && finalToken) {
      await withTransaction(pool, (client) =>
        refusedAfterCopy
          ? retainImapCapabilityCheckpoint(client, row.message_item_id, finalToken)
          : refuseClaimedImapCapability(client, row.message_item_id, finalToken),
      );
    }
    if (providerFailure) {
      const observed: unknown[] = [providerFailure.value];
      try {
        logger.warn({ mailboxItemId, stage: "imap_move", category: "failure" }, "Mail move provider operation failed");
      } catch (error) {
        observed.push(error);
      }
      void observed;
    }
    if (markUncertain && finalToken)
      await withTransaction(pool, (client) => markMailMoveUncertain(client, row.message_item_id, finalToken));
    if (providerFailure && !markUncertain) {
      void providerFailure;
      throw new Error("IMAP move provider operation failed unexpectedly");
    }
  }
}

async function imapTarget(
  client: PoolClient,
  foldersDatabaseId: string,
  mailboxFolderPropertyId: string,
  mailboxItemId: string,
  messageItemId: string,
  purpose: MailMovePurpose,
): Promise<{ id: string; path: string; uidValidity: string | null } | null> {
  await lockMailThreadMutation(client);
  await client.query(
    "SELECT 1 FROM mail_message_move_sync_state WHERE tenant_id = app_tenant_default() AND message_item_id = $1 FOR UPDATE",
    [messageItemId],
  );
  const found = await client.query<{ id: string; path: unknown }>(
    `SELECT i.id, i.properties ->> 'providerId' AS path FROM items i
     JOIN item_relations r ON (r.item_a = i.id OR r.item_b = i.id)
     JOIN relation_definitions d ON d.id = r.relation_definition_id
     WHERE i.tenant_id = app_tenant_default() AND r.tenant_id = app_tenant_default()
       AND i.database_id = $1 AND i.deleted_at IS NULL AND i.properties ->> 'specialPurpose' = $2
       AND (r.item_a = $3 OR r.item_b = $3) AND (d.property_id_a = $4 OR d.property_id_b = $4)
     LIMIT 2 FOR UPDATE OF i, r`,
    [foldersDatabaseId, purpose, mailboxItemId, mailboxFolderPropertyId],
  );
  const item = found.rows[0];
  if (found.rowCount !== 1 || !item || typeof item.path !== "string" || !item.path || item.path.length > 1024)
    return null;
  const state = await client.query<{ uidvalidity: string | null }>(
    "SELECT uidvalidity FROM mail_folder_sync_state WHERE tenant_id = app_tenant_default() AND item_id = $1 FOR UPDATE",
    [item.id],
  );
  if (state.rowCount !== 1) return null;
  return { id: item.id, path: item.path, uidValidity: state.rows[0]?.uidvalidity ?? null };
}
