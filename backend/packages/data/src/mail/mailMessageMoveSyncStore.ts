import { getRelationDefinitionByPropertyId, listRelationsForItem, otherSide } from "../chokePoint/relationsStore.js";
import { updateRelationWithClient } from "../chokePoint/relationOps.js";
import { EMAILS_RELATION_CONTEXT } from "./emailsRelationContext.js";
import type { PoolClient } from "pg";
import { z } from "zod";
import { currentTenantScope } from "@semprec/shared";
import { requireAffectedRows } from "../db/pool.js";
import { lockMailThreadMutation } from "./mailThreadMutationGuard.js";

export const MAIL_MOVE_PURPOSES = ["archive", "trash", "inbox", "sent"] as const;
export type MailMovePurpose = (typeof MAIL_MOVE_PURPOSES)[number];
export type MailMoveFailureReason = "messageMissing" | "providerRejected" | "unsupportedCapability";

const providerId = z.string().min(1).max(1024);
const uid = z.number().int().positive().max(4_294_967_295);
const uidValidity = z
  .string()
  .regex(/^[1-9]\d{0,9}$/)
  .refine((value) => Number(value) <= 4_294_967_295);
const sourceSchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("imap"), folderItemId: z.uuid(), path: providerId, uid, uidValidity }).strict(),
  z.object({ provider: z.literal("gmail"), providerMessageId: providerId }).strict(),
  z.object({ provider: z.literal("graph"), providerMessageId: providerId }).strict(),
]);
export type MailMoveSource = z.infer<typeof sourceSchema>;
const evidenceSchema = z.discriminatedUnion("provider", [
  z
    .object({
      provider: z.literal("imap"),
      sourceFolderId: z.uuid(),
      targetFolderId: z.uuid(),
      sourcePath: providerId,
      targetPath: providerId,
      sourceUid: uid,
      sourceUidValidity: uidValidity,
      targetUid: uid.optional(),
      targetUidValidity: uidValidity.optional(),
    })
    .strict(),
  z
    .object({
      provider: z.literal("gmail"),
      messageId: providerId,
      inTrash: z.boolean(),
      inInbox: z.boolean(),
      inSent: z.boolean(),
    })
    .strict(),
  z
    .object({
      provider: z.literal("graph"),
      sourceId: providerId,
      targetFolderId: providerId,
      resultId: providerId.optional(),
    })
    .strict(),
]);
const stepSchema = z.enum(["move", "copy", "mark_deleted", "expunge", "untrash", "modify_labels", "trash"]);
export type MailMoveEvidence = z.infer<typeof evidenceSchema>;
export type MailMoveStep = z.infer<typeof stepSchema>;

const rowSchema = z.object({
  message_item_id: z.uuid(),
  mailbox_item_id: z.uuid(),
  desired_purpose: z.enum(MAIL_MOVE_PURPOSES),
  source_evidence: sourceSchema,
  current_purpose: z.enum(MAIL_MOVE_PURPOSES).nullable(),
  desired_revision: z.string().regex(/^[1-9]\d*$/),
  operation_token: z.uuid().nullable(),
  captured_revision: z
    .string()
    .regex(/^[1-9]\d*$/)
    .nullable(),
  captured_purpose: z.enum(MAIL_MOVE_PURPOSES).nullable(),
  operation_phase: z.enum(["in_flight", "between_steps", "uncertain"]).nullable(),
  operation_step: stepSchema.nullable(),
  operation_evidence: evidenceSchema.nullable(),
  attempts: z.number().int().nonnegative(),
  status: z.enum(["pending", "done", "failed"]),
  failure_reason: z.enum(["messageMissing", "providerRejected", "unsupportedCapability"]).nullable(),
});

export type MailMessageMoveSyncRow = z.infer<typeof rowSchema>;
const COLUMNS = `message_item_id, mailbox_item_id, desired_purpose, source_evidence, current_purpose, desired_revision,
  operation_token, captured_revision, captured_purpose, operation_phase, operation_step, operation_evidence, attempts, status, failure_reason`;

const baselineRow = z.object({
  message_item_id: z.uuid(),
  mailbox_item_id: z.uuid(),
  desired_revision: z.string().regex(/^[1-9]\d*$/),
  status: z.enum(["pending", "done", "failed"]),
  operation_token: z.uuid().nullable(),
});
type BaselineRow = z.infer<typeof baselineRow>;
export type MailMoveBaseline = { tenantId: string; mailboxItemId: string; rows: ReadonlyMap<string, BaselineRow> };

export async function captureMailMoveBaseline(client: PoolClient, mailboxItemId: string): Promise<MailMoveBaseline> {
  const mailbox = z.uuid().parse(mailboxItemId);
  const scope = currentTenantScope();
  const tenant = await client.query<{ tenant_id: unknown }>("SELECT app_tenant_default()::text AS tenant_id");
  const tenantId = z.uuid().parse(tenant.rows[0]?.tenant_id);
  if (scope?.kind === "tenant" && tenantId !== scope.tenantId) throw new Error("Invalid mail move baseline scope");
  const result = await client.query<Record<string, unknown>>(
    `SELECT message_item_id, mailbox_item_id, desired_revision, status, operation_token
       FROM mail_message_move_sync_state WHERE tenant_id = app_tenant_default() AND mailbox_item_id = $1`,
    [mailbox],
  );
  const rows = result.rows.map((row) => baselineRow.parse(row));
  if (rows.some((row) => row.mailbox_item_id !== mailbox)) throw new Error("Invalid mail move baseline mailbox");
  return { tenantId, mailboxItemId: mailbox, rows: new Map(rows.map((row) => [row.message_item_id, row])) };
}

/** Called after acquiring the existing thread guard and before provider observations. */
export async function protectedMailMovesForPass(
  client: PoolClient,
  mailboxItemId: string,
  baseline?: MailMoveBaseline,
  existing?: ReadonlySet<string>,
): Promise<Set<string>> {
  const current = await captureMailMoveBaseline(client, mailboxItemId);
  const initial = baseline ?? current;
  if (initial.tenantId !== current.tenantId || initial.mailboxItemId !== current.mailboxItemId)
    throw new Error("Invalid mail move baseline scope");
  const protectedIds = new Set(existing);
  for (const [id, row] of initial.rows) {
    if (row.status !== "done" || row.operation_token !== null) protectedIds.add(id);
  }
  for (const [id, row] of current.rows) {
    const before = initial.rows.get(id);
    if (
      row.status !== "done" ||
      row.operation_token !== null ||
      !before ||
      before.desired_revision !== row.desired_revision ||
      before.status !== row.status ||
      before.operation_token !== row.operation_token
    )
      protectedIds.add(id);
  }
  return protectedIds;
}

/** Records a new desire without releasing an outstanding provider operation. */
export async function recordDesiredMailMessageMove(
  client: PoolClient,
  input: { messageItemId: string; mailboxItemId: string; desiredPurpose: MailMovePurpose; source?: MailMoveSource },
): Promise<MailMessageMoveSyncRow> {
  await lockMailThreadMutation(client);
  const previous = await client.query<{ source_evidence: unknown; status: string; operation_token: string | null }>(
    "SELECT source_evidence, status, operation_token FROM mail_message_move_sync_state WHERE tenant_id = app_tenant_default() AND message_item_id = $1 FOR UPDATE",
    [input.messageItemId],
  );
  const metadata = await client.query<{ provider_message_id: string | null }>(
    `SELECT provider_message_id FROM mail_message_meta WHERE tenant_id = app_tenant_default() AND item_id = $1 AND mailbox_item_id = $2 FOR UPDATE`,
    [input.messageItemId, input.mailboxItemId],
  );
  if (metadata.rowCount !== 1) throw new Error("Mail message is not available in this mailbox");
  const prior = previous.rows[0];
  const preserveSource = prior !== undefined && (prior.status === "pending" || prior.operation_token !== null);
  const source = preserveSource ? sourceSchema.parse(prior.source_evidence) : sourceSchema.parse(input.source);
  if (!preserveSource && source.provider === "imap") {
    const match = await client.query(
      `SELECT 1 FROM item_relations edge
       JOIN relation_definitions ed ON ed.id = edge.relation_definition_id
       JOIN items message ON message.id = $1 AND message.tenant_id = app_tenant_default() AND message.deleted_at IS NULL
       JOIN properties ep ON ep.id IN (ed.property_id_a, ed.property_id_b) AND ep.key = 'folder' AND ep.database_id = message.database_id
       JOIN items folder ON folder.id = $3 AND folder.tenant_id = app_tenant_default() AND folder.deleted_at IS NULL
       JOIN items mailbox ON mailbox.id = $2 AND mailbox.tenant_id = app_tenant_default() AND mailbox.deleted_at IS NULL
       JOIN mail_folder_sync_state state ON state.item_id = folder.id AND state.tenant_id = app_tenant_default()
       JOIN item_relations membership ON (membership.item_a = folder.id OR membership.item_b = folder.id)
         AND (membership.item_a = $2 OR membership.item_b = $2)
       JOIN relation_definitions md ON md.id = membership.relation_definition_id
       JOIN properties mp ON mp.id IN (md.property_id_a, md.property_id_b) AND mp.key = 'mailbox' AND mp.database_id = folder.database_id
       WHERE edge.tenant_id = app_tenant_default() AND membership.tenant_id = app_tenant_default()
         AND (edge.item_a = $1 OR edge.item_b = $1) AND (edge.item_a = folder.id OR edge.item_b = folder.id)
         AND edge.metadata ->> 'uid' = $4 AND folder.properties ->> 'providerId' = $5 AND state.uidvalidity = $6
       FOR UPDATE OF edge, folder, state, membership, message, mailbox`,
      [
        input.messageItemId,
        input.mailboxItemId,
        source.folderItemId,
        String(source.uid),
        source.path,
        source.uidValidity,
      ],
    );
    if (match.rowCount !== 1) throw new Error("Mail move source is not verified");
  } else if (
    !preserveSource &&
    source.provider !== "imap" &&
    metadata.rows[0]?.provider_message_id !== source.providerMessageId
  ) {
    throw new Error("Mail move source is not verified");
  }
  const result = await client.query<Record<string, unknown>>(
    `INSERT INTO mail_message_move_sync_state (message_item_id, mailbox_item_id, desired_purpose, source_evidence)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (tenant_id, message_item_id) DO UPDATE SET
       desired_purpose = EXCLUDED.desired_purpose, desired_revision = mail_message_move_sync_state.desired_revision + 1,
       source_evidence = EXCLUDED.source_evidence,
       attempts = 0, status = 'pending', failure_reason = NULL, updated_at = now()
     WHERE mail_message_move_sync_state.mailbox_item_id = EXCLUDED.mailbox_item_id
     RETURNING ${COLUMNS}`,
    [input.messageItemId, input.mailboxItemId, input.desiredPurpose, JSON.stringify(source)],
  );
  if (!result.rows[0]) throw new Error("Mail move mailbox does not match the existing intent");
  return rowSchema.parse(result.rows[0]);
}

export async function listPendingMoves(client: PoolClient, mailboxItemId: string): Promise<MailMessageMoveSyncRow[]> {
  const result = await client.query<Record<string, unknown>>(
    `SELECT ${COLUMNS} FROM mail_message_move_sync_state
     WHERE tenant_id = app_tenant_default() AND mailbox_item_id = $1 AND status = 'pending' ORDER BY created_at, message_item_id`,
    [mailboxItemId],
  );
  return result.rows.map((row) => rowSchema.parse(row));
}

/** Commits ownership of one provider step before its caller dispatches it. */
export async function claimMailMoveStep(
  client: PoolClient,
  input: { messageItemId: string; revision: string; token: string; step: MailMoveStep; evidence: MailMoveEvidence },
): Promise<boolean> {
  await lockMailThreadMutation(client);
  const evidence = evidenceSchema.parse(input.evidence);
  const step = stepSchema.parse(input.step);
  const result = await client.query(
    `UPDATE mail_message_move_sync_state SET operation_token = $3::uuid, captured_revision = $2::bigint,
       captured_purpose = COALESCE(captured_purpose, desired_purpose),
       operation_phase = 'in_flight', operation_step = $4, operation_evidence = $5::jsonb, updated_at = now()
     WHERE tenant_id = app_tenant_default() AND message_item_id = $1 AND status = 'pending'
       AND ((operation_token IS NULL AND desired_revision = $2::bigint
             AND (source_evidence ->> 'provider' = 'imap' OR EXISTS (
               SELECT 1 FROM mail_message_meta m WHERE m.tenant_id = app_tenant_default()
                 AND m.item_id = mail_message_move_sync_state.message_item_id
                 AND m.mailbox_item_id = mail_message_move_sync_state.mailbox_item_id
                 AND m.provider_message_id = source_evidence ->> 'providerMessageId'
             )))
         OR (operation_token = $3::uuid AND captured_revision = $2::bigint
             AND operation_phase = 'between_steps' AND operation_step = $4 AND operation_evidence = $5::jsonb))`,
    [input.messageItemId, input.revision, input.token, step, JSON.stringify(evidence)],
  );
  return result.rowCount === 1;
}

/** Stores an acknowledged result and the next step before another remote mutation. */
export async function checkpointMailMoveStep(
  client: PoolClient,
  input: { messageItemId: string; token: string; nextStep: MailMoveStep; evidence: MailMoveEvidence },
): Promise<boolean> {
  await lockMailThreadMutation(client);
  const result = await client.query(
    `UPDATE mail_message_move_sync_state SET operation_phase = 'between_steps', operation_step = $3,
       operation_evidence = $4::jsonb, updated_at = now()
     WHERE tenant_id = app_tenant_default() AND message_item_id = $1
       AND operation_token = $2::uuid AND operation_phase = 'in_flight'`,
    [
      input.messageItemId,
      input.token,
      stepSchema.parse(input.nextStep),
      JSON.stringify(evidenceSchema.parse(input.evidence)),
    ],
  );
  return result.rowCount === 1;
}

/** Leaves a step blocked after a provider outcome that cannot be established. */
export async function markMailMoveUncertain(
  client: PoolClient,
  messageItemId: string,
  token: string,
): Promise<boolean> {
  await lockMailThreadMutation(client);
  const result = await client.query(
    `UPDATE mail_message_move_sync_state SET operation_phase = 'uncertain', updated_at = now()
     WHERE tenant_id = app_tenant_default() AND message_item_id = $1
       AND operation_token = $2::uuid AND operation_phase = 'in_flight'`,
    [messageItemId, token],
  );
  return result.rowCount === 1;
}

/** Confirms only the same unclaimed revision that was observed. */
export async function markMoveConfirmed(client: PoolClient, messageItemId: string, revision: string): Promise<boolean> {
  await lockMailThreadMutation(client);
  const result = await client.query(
    `UPDATE mail_message_move_sync_state SET current_purpose = desired_purpose, status = 'done',
       failure_reason = NULL, updated_at = now()
     WHERE tenant_id = app_tenant_default() AND message_item_id = $1 AND desired_revision = $2::bigint
       AND status = 'pending' AND operation_token IS NULL`,
    [messageItemId, revision],
  );
  return result.rowCount === 1;
}

/** Records a definite failure of the same unclaimed revision; an uncertain operation is never retried here. */
export async function markMoveAttemptFailed(
  client: PoolClient,
  messageItemId: string,
  revision: string,
  reason: MailMoveFailureReason,
  limit = 5,
): Promise<boolean> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid mail move attempt limit");
  await lockMailThreadMutation(client);
  const result = await client.query(
    `UPDATE mail_message_move_sync_state SET attempts = attempts + 1,
       status = CASE WHEN attempts + 1 >= $4 THEN 'failed' ELSE 'pending' END,
       failure_reason = CASE WHEN attempts + 1 >= $4 THEN $3 ELSE NULL END, updated_at = now()
     WHERE tenant_id = app_tenant_default() AND message_item_id = $1 AND desired_revision = $2::bigint
       AND status = 'pending' AND operation_token IS NULL`,
    [messageItemId, revision, reason, limit],
  );
  return result.rowCount === 1;
}

/** Retains an acknowledged Graph identity even if the desire changed during the request. */
export async function completeGraphMove(
  client: PoolClient,
  input: { messageItemId: string; token: string; resultId: string },
): Promise<"confirmed" | "pending" | "conflict"> {
  const resultId = providerId.parse(input.resultId);
  await lockMailThreadMutation(client);
  const selected = await client.query<Record<string, unknown>>(
    `SELECT ${COLUMNS} FROM mail_message_move_sync_state
     WHERE tenant_id = app_tenant_default() AND message_item_id = $1 FOR UPDATE`,
    [input.messageItemId],
  );
  const row = rowSchema.parse(selected.rows[0]);
  if (
    row.operation_token !== input.token ||
    row.operation_phase !== "in_flight" ||
    row.operation_evidence?.provider !== "graph" ||
    row.captured_revision === null ||
    row.captured_purpose === null
  )
    throw new Error("Mail move operation is no longer owned");
  const evidence = { ...row.operation_evidence, resultId };
  const metadata = await client.query(
    `UPDATE mail_message_meta SET provider_message_id = $4
     WHERE tenant_id = app_tenant_default() AND item_id = $1 AND mailbox_item_id = $2
       AND provider_message_id = $3`,
    [row.message_item_id, row.mailbox_item_id, evidence.sourceId, resultId],
  );
  if (metadata.rowCount !== 1) {
    requireAffectedRows(
      await client.query(
        `UPDATE mail_message_move_sync_state SET operation_phase = 'uncertain', operation_evidence = $3::jsonb,
         updated_at = now() WHERE tenant_id = app_tenant_default() AND message_item_id = $1 AND operation_token = $2::uuid`,
        [row.message_item_id, input.token, JSON.stringify(evidence)],
      ),
      "mail move outcome",
    );
    return "conflict";
  }
  const matched = row.desired_revision === row.captured_revision;
  requireAffectedRows(
    await client.query(
      `UPDATE mail_message_move_sync_state SET source_evidence = $3::jsonb, current_purpose = captured_purpose,
       status = CASE WHEN desired_revision = captured_revision THEN 'done' ELSE 'pending' END,
       operation_token = NULL, captured_revision = NULL, captured_purpose = NULL, operation_phase = NULL,
       operation_step = NULL, operation_evidence = NULL, failure_reason = NULL, updated_at = now()
     WHERE tenant_id = app_tenant_default() AND message_item_id = $1 AND operation_token = $2::uuid`,
      [row.message_item_id, input.token, JSON.stringify({ provider: "graph", providerMessageId: resultId })],
    ),
    "mail move outcome",
  );
  return matched ? "confirmed" : "pending";
}

/** Checks whether a local placement is awaiting provider convergence or recovery. */
export async function hasUnsettledMailMove(client: PoolClient, messageItemId: string): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM mail_message_move_sync_state
     WHERE tenant_id = app_tenant_default() AND message_item_id = $1
       AND (status <> 'done' OR operation_token IS NOT NULL)`,
    [messageItemId],
  );
  return result.rowCount !== 0;
}

/** Settles a Gmail command only while the stable provider identity still matches. */
export async function completeGmailMove(
  client: PoolClient,
  input: { messageItemId: string; token: string; evidence: MailMoveEvidence },
): Promise<"confirmed" | "pending" | "conflict"> {
  const evidence = evidenceSchema.parse(input.evidence);
  if (evidence.provider !== "gmail") throw new Error("Invalid Gmail move evidence");
  await lockMailThreadMutation(client);
  const selected = await client.query<Record<string, unknown>>(
    `SELECT ${COLUMNS} FROM mail_message_move_sync_state
     WHERE tenant_id = app_tenant_default() AND message_item_id = $1 FOR UPDATE`,
    [input.messageItemId],
  );
  const row = rowSchema.parse(selected.rows[0]);
  if (
    row.operation_token !== input.token ||
    row.operation_phase !== "in_flight" ||
    row.operation_evidence?.provider !== "gmail" ||
    row.operation_evidence.messageId !== evidence.messageId ||
    row.captured_revision === null ||
    row.captured_purpose === null
  ) {
    throw new Error("Mail move operation is no longer owned");
  }
  const matches =
    row.captured_purpose === "trash"
      ? evidence.inTrash
      : row.captured_purpose === "inbox"
        ? !evidence.inTrash && evidence.inInbox
        : row.captured_purpose === "sent"
          ? !evidence.inTrash && evidence.inSent
          : !evidence.inInbox;
  if (!matches) {
    requireAffectedRows(
      await client.query(
        `UPDATE mail_message_move_sync_state SET operation_phase = 'uncertain', operation_evidence = $3::jsonb,
       updated_at = now() WHERE tenant_id = app_tenant_default() AND message_item_id = $1 AND operation_token = $2::uuid`,
        [row.message_item_id, input.token, JSON.stringify(evidence)],
      ),
      "mail move outcome",
    );
    return "conflict";
  }
  const metadata = await client.query(
    `SELECT 1 FROM mail_message_meta WHERE tenant_id = app_tenant_default() AND item_id = $1
     AND mailbox_item_id = $2 AND provider_message_id = $3 FOR UPDATE`,
    [row.message_item_id, row.mailbox_item_id, evidence.messageId],
  );
  if (metadata.rowCount !== 1) {
    requireAffectedRows(
      await client.query(
        `UPDATE mail_message_move_sync_state SET operation_phase = 'uncertain', operation_evidence = $3::jsonb,
       updated_at = now() WHERE tenant_id = app_tenant_default() AND message_item_id = $1 AND operation_token = $2::uuid`,
        [row.message_item_id, input.token, JSON.stringify(evidence)],
      ),
      "mail move outcome",
    );
    return "conflict";
  }
  const matched = row.desired_revision === row.captured_revision;
  requireAffectedRows(
    await client.query(
      `UPDATE mail_message_move_sync_state SET current_purpose = captured_purpose,
       status = CASE WHEN desired_revision = captured_revision THEN 'done' ELSE 'pending' END,
       operation_token = NULL, captured_revision = NULL, captured_purpose = NULL, operation_phase = NULL,
       operation_step = NULL, operation_evidence = NULL, failure_reason = NULL, updated_at = now()
     WHERE tenant_id = app_tenant_default() AND message_item_id = $1 AND operation_token = $2::uuid`,
      [row.message_item_id, input.token],
    ),
    "mail move outcome",
  );
  return matched ? "confirmed" : "pending";
}

/** Confirms a read-only observation only if its source identity is still current. */
export async function confirmObservedProviderMove(
  client: PoolClient,
  input: { messageItemId: string; revision: string; providerMessageId: string },
): Promise<boolean> {
  const providerMessageId = providerId.parse(input.providerMessageId);
  await lockMailThreadMutation(client);
  const result = await client.query(
    `UPDATE mail_message_move_sync_state s SET current_purpose = desired_purpose, status = 'done',
       failure_reason = NULL, updated_at = now()
     WHERE s.tenant_id = app_tenant_default() AND s.message_item_id = $1 AND s.desired_revision = $2::bigint
       AND s.status = 'pending' AND s.operation_token IS NULL
       AND s.source_evidence ->> 'providerMessageId' = $3
       AND EXISTS (SELECT 1 FROM mail_message_meta m WHERE m.tenant_id = s.tenant_id AND m.item_id = s.message_item_id
         AND m.mailbox_item_id = s.mailbox_item_id AND m.provider_message_id = $3)`,
    [input.messageItemId, input.revision, providerMessageId],
  );
  return result.rowCount === 1;
}

/** Persists an IMAP result without replacing a newer edge identity. */
export async function completeImapMove(
  client: PoolClient,
  input: { messageItemId: string; token: string; evidence: MailMoveEvidence; folderRelationPropertyId: string },
): Promise<"confirmed" | "pending" | "conflict"> {
  const evidence = evidenceSchema.parse(input.evidence);
  if (evidence.provider !== "imap" || !evidence.targetUid || !evidence.targetUidValidity)
    throw new Error("Invalid IMAP result evidence");
  await lockMailThreadMutation(client);
  const selected = await client.query<Record<string, unknown>>(
    `SELECT ${COLUMNS} FROM mail_message_move_sync_state
     WHERE tenant_id = app_tenant_default() AND message_item_id = $1 FOR UPDATE`,
    [input.messageItemId],
  );
  const row = rowSchema.parse(selected.rows[0]);
  if (
    row.operation_token !== input.token ||
    row.operation_phase !== "in_flight" ||
    row.operation_evidence?.provider !== "imap" ||
    row.operation_evidence.sourceFolderId !== evidence.sourceFolderId ||
    row.operation_evidence.targetFolderId !== evidence.targetFolderId ||
    row.operation_evidence.sourcePath !== evidence.sourcePath ||
    row.operation_evidence.targetPath !== evidence.targetPath ||
    row.operation_evidence.sourceUid !== evidence.sourceUid ||
    row.operation_evidence.sourceUidValidity !== evidence.sourceUidValidity ||
    row.captured_revision === null ||
    row.captured_purpose === null
  )
    throw new Error("Mail move operation is no longer owned");
  const state = await client.query<{ uidvalidity: string | null }>(
    `SELECT uidvalidity FROM mail_folder_sync_state WHERE tenant_id = app_tenant_default() AND item_id = $1 FOR UPDATE`,
    [evidence.targetFolderId],
  );
  const definition = await getRelationDefinitionByPropertyId(client, input.folderRelationPropertyId);
  if (!definition) throw new Error("Mail folder relation is missing");
  const edges = await listRelationsForItem(client, definition.id, row.message_item_id);
  const edge = edges.find((value) => otherSide(value, row.message_item_id) === evidence.targetFolderId);
  const edgeUid = edge?.metadata.uid;
  const unchangedEdge = edge !== undefined && (edgeUid === undefined || edgeUid === evidence.targetUid);
  const targetMatches = state.rows[0]?.uidvalidity === evidence.targetUidValidity;
  const newer = row.desired_revision !== row.captured_revision;
  if (!targetMatches || (edge && !unchangedEdge) || (!edge && !newer)) {
    requireAffectedRows(
      await client.query(
        `UPDATE mail_message_move_sync_state SET operation_phase = 'uncertain', operation_evidence = $3::jsonb,
       updated_at = now() WHERE tenant_id = app_tenant_default() AND message_item_id = $1 AND operation_token = $2::uuid`,
        [row.message_item_id, input.token, JSON.stringify(evidence)],
      ),
      "mail move outcome",
    );
    return "conflict";
  }
  if (edge && unchangedEdge) {
    await updateRelationWithClient(
      client,
      {
        relationPropertyId: input.folderRelationPropertyId,
        callerItemId: row.message_item_id,
        targetItemId: evidence.targetFolderId,
        metadata: { ...edge.metadata, uid: evidence.targetUid },
      },
      EMAILS_RELATION_CONTEXT,
    );
  }
  const source = {
    provider: "imap",
    folderItemId: evidence.targetFolderId,
    path: evidence.targetPath,
    uid: evidence.targetUid,
    uidValidity: evidence.targetUidValidity,
  };
  requireAffectedRows(
    await client.query(
      `UPDATE mail_message_move_sync_state SET source_evidence = $3::jsonb, current_purpose = captured_purpose,
       status = CASE WHEN desired_revision = captured_revision THEN 'done' ELSE 'pending' END,
       operation_token = NULL, captured_revision = NULL, captured_purpose = NULL, operation_phase = NULL,
       operation_step = NULL, operation_evidence = NULL, failure_reason = NULL, updated_at = now()
     WHERE tenant_id = app_tenant_default() AND message_item_id = $1 AND operation_token = $2::uuid`,
      [row.message_item_id, input.token, JSON.stringify(source)],
    ),
    "mail move outcome",
  );
  return newer ? "pending" : "confirmed";
}

/** Releases a claimed command only when its capability check refused before dispatch. */
export async function refuseClaimedImapCapability(
  client: PoolClient,
  messageItemId: string,
  token: string,
): Promise<boolean> {
  await lockMailThreadMutation(client);
  const result = await client.query(
    `UPDATE mail_message_move_sync_state SET
       attempts = CASE WHEN desired_revision = captured_revision THEN attempts + 1 ELSE attempts END,
       status = CASE WHEN desired_revision = captured_revision AND attempts + 1 >= 5 THEN 'failed' ELSE 'pending' END,
       failure_reason = CASE WHEN desired_revision = captured_revision AND attempts + 1 >= 5 THEN 'unsupportedCapability' ELSE NULL END,
       operation_token = NULL, captured_revision = NULL, captured_purpose = NULL, operation_phase = NULL,
       operation_step = NULL, operation_evidence = NULL, updated_at = now()
     WHERE tenant_id = app_tenant_default() AND message_item_id = $1 AND operation_token = $2::uuid
       AND operation_phase = 'in_flight' AND operation_step IN ('move', 'copy')
       AND NOT (operation_evidence ? 'targetUid')`,
    [messageItemId, token],
  );
  return result.rowCount === 1;
}

/** Keeps a previously acknowledged copy at its safe continuation when no command was dispatched. */
export async function retainImapCapabilityCheckpoint(
  client: PoolClient,
  messageItemId: string,
  token: string,
): Promise<boolean> {
  await lockMailThreadMutation(client);
  const result = await client.query(
    `UPDATE mail_message_move_sync_state SET operation_phase = 'between_steps', updated_at = now()
     WHERE tenant_id = app_tenant_default() AND message_item_id = $1 AND operation_token = $2::uuid
       AND operation_phase = 'in_flight' AND operation_step IN ('mark_deleted', 'expunge')
       AND operation_evidence ? 'targetUid'`,
    [messageItemId, token],
  );
  return result.rowCount === 1;
}
