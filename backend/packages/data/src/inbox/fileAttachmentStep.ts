import type { PoolClient } from "pg";
import { z } from "zod";
import * as databasesStore from "../chokePoint/databasesStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import { ValidationError } from "../errors.js";
import { FILES_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import type { DatabaseRow } from "../types.js";
import type { ProposalStep } from "./proposalEnvelope.js";
import {
  assertStepDatabaseWritable,
  assertValidEnvelopeRelations,
  existingItemRelations,
  withStepRef,
} from "./proposalEnvelopeValidation.js";
import { stepError } from "./proposalStepGraph.js";

// The `fileFromAttachment` step kind of a multi-step proposal envelope (issue #1703): on confirm it moves
// one attachment of the source Inbox item into Files. The shape is recorded in
// docs/adr/2026-10-29-file-from-attachment-proposal-step.md. Execution is in proposalSteps.ts.

/**
 * The only properties such a step may write. `file` and `type` are never part of the envelope: confirm
 * sets them from the attachment's blob, so a stored envelope cannot name a blob of its own.
 */
const fileFromAttachmentPropertiesSchema = z
  .object({
    attachmentId: z.string().uuid(),
    name: z.string().refine((value) => value.trim().length > 0, "must not be empty"),
    date: z.string().min(1).optional(),
  })
  .strict();

/** The validated properties of a `fileFromAttachment` step. */
export interface FileFromAttachmentProperties {
  attachmentId: string;
  name: string;
  date?: string;
}

/**
 * Checks a `fileFromAttachment` step's properties: exactly `attachmentId`, a non-empty `name` and an
 * optional `date`. Any other key, `file` and `type` included, is a `ValidationError` naming the step
 * `ref` and the offending `field`.
 */
export function parseFileFromAttachmentProperties(
  ref: string,
  properties: Record<string, unknown>,
): FileFromAttachmentProperties {
  const parsed = fileFromAttachmentPropertiesSchema.safeParse(properties);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  if (issue?.code === "unrecognized_keys") {
    const field = issue.keys[0] ?? "properties";
    throw new ValidationError(`Proposal step '${ref}': a fileFromAttachment step cannot write property '${field}'`, {
      ref,
      field,
    });
  }
  const field = String(issue?.path[0] ?? "properties");
  throw new ValidationError(`Proposal step '${ref}': property '${field}' is invalid (${issue?.message ?? "invalid"})`, {
    ref,
    field,
  });
}

/**
 * Validates a `fileFromAttachment` step (issue #1703): it names neither a `databaseKey` nor an `itemId`,
 * its properties are exactly the allowed fields, and its relations are checked as a create step's are.
 * The attachment itself is checked at confirm, where the proposal's source Inbox item is known.
 */
export async function assertValidFileFromAttachmentStep(client: PoolClient, step: ProposalStep): Promise<DatabaseRow> {
  if (step.databaseKey !== undefined)
    throw stepError(step, "a fileFromAttachment step cannot name a databaseKey", "databaseKey");
  if (step.itemId !== undefined) throw stepError(step, "a fileFromAttachment step cannot name an itemId", "itemId");
  parseFileFromAttachmentProperties(step.ref, step.properties ?? {});
  const database = assertStepDatabaseWritable(
    step,
    await databasesStore.getDatabaseByModuleId(client, FILES_MODULE_ID),
    "properties",
  );
  await withStepRef(step.ref, async () => {
    const byKey = new Map(
      (await propertiesStore.listPropertiesByDatabase(client, database.id)).map((property) => [property.key, property]),
    );
    await assertValidEnvelopeRelations(client, database.id, byKey, existingItemRelations(step));
  });
  return database;
}
