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

// On confirm a `fileFromAttachment` step moves one attachment of the source Inbox item into Files; execution is in
// proposalSteps.ts.

/** `file` and `type` are set by confirm from the attachment's blob, so a stored envelope cannot name a blob of its own. */
const fileFromAttachmentPropertiesSchema = z
  .object({
    attachmentId: z.string().uuid(),
    name: z.string().refine((value) => value.trim().length > 0, "must not be empty"),
    date: z.string().min(1).optional(),
  })
  .strict();

export interface FileFromAttachmentProperties {
  attachmentId: string;
  name: string;
  date?: string;
}

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

/** The attachment itself is checked at confirm, where the proposal's source Inbox item is known. */
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
