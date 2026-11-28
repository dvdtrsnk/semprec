import { z } from "zod";

/**
 * `'relation'` links the card's source item to `target` through `properties.propertyKey`, never computed by the tick.
 * `'transcription'` proposes transcribing the audio attachment `target`, produced by the tick without a model call.
 * `'journalEntry'` proposes an entry on the Journal day `properties.date` with `target` the Journal database.
 */
export type ProposalEntityKind = "pageContent" | "database" | "relation" | "transcription" | "journalEntry";

export type ComputedProposalEntityKind = Exclude<ProposalEntityKind, "relation" | "transcription">;

const stepRelationTargetSchema = z.union([z.string().min(1), z.object({ ref: z.string().min(1) })]);

const stepRelationsSchema = z.record(z.string(), z.array(stepRelationTargetSchema));

/**
 * One step of a multi-step envelope. `create` names a `databaseKey`; `update` and `link` an `itemId`;
 * `fileFromAttachment` neither: it writes the system Files database and is never the primary step. `before`/`after`
 * hold the current and written values of what an `update` changes.
 */
const proposalStepSchema = z.object({
  ref: z.string().min(1),
  op: z.enum(["create", "update", "link", "fileFromAttachment"]),
  databaseKey: z.string().min(1).optional(),
  itemId: z.string().min(1).optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
  relations: stepRelationsSchema.optional(),
  role: z.enum(["primary", "secondary"]),
  optional: z.boolean().optional(),
  enabled: z.boolean().optional(),
  before: z
    .object({
      properties: z.record(z.string(), z.unknown()).optional(),
      relations: z.record(z.string(), z.array(z.string().min(1))).optional(),
    })
    .optional(),
  after: z
    .object({
      properties: z.record(z.string(), z.unknown()).optional(),
      relations: stepRelationsSchema.optional(),
    })
    .optional(),
});

export type ProposalStep = z.infer<typeof proposalStepSchema>;

/** Validated only for Markdown page-content envelopes; legacy block properties stay unchanged. */
export const pageContentV2Schema = z
  .object({
    markdown: z.string().refine((value) => value.trim().length > 0),
    placement: z.union([z.literal("start"), z.literal("end"), z.object({ afterHeading: z.string().min(1) }).strict()]),
    heading: z
      .string()
      .max(200)
      .regex(/^[^\r\n\u2028\u2029]*$/)
      .optional(),
  })
  .strict();

export type PageContentV2 = z.infer<typeof pageContentV2Schema>;

export const MAX_PAGE_SECTION_HEADING_CHARS = 200;
export const MAX_PAGE_SECTION_ITEMS = 100;
export const MAX_PAGE_SECTION_ITEM_CHARS = 500;
export const MAX_PAGE_SECTIONS = 4;

/**
 * One section of the created item's page: a heading then one `blockType` block per item. Plain text, never Markdown,
 * even when a line looks like Markdown.
 */
export const proposalPageSectionSchema = z.strictObject({
  heading: z
    .string()
    .trim()
    .min(1)
    .max(MAX_PAGE_SECTION_HEADING_CHARS)
    .regex(/^[^\r\n\u2028\u2029]*$/),
  blockType: z.enum(["bullet", "number"]),
  items: z.array(z.string().min(1).max(MAX_PAGE_SECTION_ITEM_CHARS)).min(1).max(MAX_PAGE_SECTION_ITEMS),
});

export type ProposalPageSection = z.infer<typeof proposalPageSectionSchema>;

export const MAX_PROPOSAL_NEW_OPTIONS = 3;

/**
 * A select option to create on confirm for a `select`/`multi_select` property of the target. Only the shape is checked
 * here; the rules are in `assertValidEnvelopeNewOptions`, so a stored envelope that breaks one is refused with a
 * message instead of reading back as malformed.
 */
export const proposalNewOptionSchema = z.strictObject({
  propertyKey: z.string().min(1),
  label: z.string(),
  color: z.string().optional(),
});

export type ProposalNewOption = z.infer<typeof proposalNewOptionSchema>;

export const proposalEnvelopeSchema = z.object({
  entityKind: z.enum(["pageContent", "database", "relation", "transcription", "journalEntry"]),
  target: z.string().min(1),
  properties: z.record(z.string(), z.unknown()),
  /** `'database'` only: target item ids per relation property key, written on confirm. Empty array means no edge. */
  relations: z.record(z.string(), z.array(z.string().min(1))).optional(),
  /** Every step of a multi-step proposal; the top-level fields mirror the primary step. Absent for single-step. */
  operations: z.array(proposalStepSchema).optional(),
  /** Single-step `'database'` only: page sections written after the item, authored by the confirming user. */
  pageSections: z.array(proposalPageSectionSchema).min(1).max(MAX_PAGE_SECTIONS).optional(),
  /**
   * Single-step `'database'` only: options the confirm creates before the item. A property value names one as
   * `{ newOption: "<label>" }` in place of an option key.
   */
  newOptions: z.array(proposalNewOptionSchema).optional(),
});

export type ProposalEnvelope = z.infer<typeof proposalEnvelopeSchema>;

/**
 * A well-formed stored envelope of an `entityKind` this release does not know (written by a newer release, kept
 * readable for rollback). Displayed, never executed. `proposalEnvelopeSchema` stays strict for writing.
 */
export interface UnknownKindProposalEnvelope {
  unknownKind: true;
  entityKind: string;
  target: string;
  properties: Record<string, unknown>;
}

const storedEnvelopeShapeSchema = z.object({
  entityKind: z.string(),
  target: z.string(),
  properties: z.record(z.string(), z.unknown()),
});

export function unknownStoredEntityKind(value: unknown): string | null {
  if (proposalEnvelopeSchema.safeParse(value).success) return null;
  const shape = storedEnvelopeShapeSchema.safeParse(value);
  if (!shape.success) return null;
  return (proposalEnvelopeSchema.shape.entityKind.options as readonly string[]).includes(shape.data.entityKind)
    ? null
    : shape.data.entityKind;
}

/**
 * Parses a stored `proposal`: `null`/`undefined` gives `null`, a well-formed envelope of an unknown kind gives
 * `UnknownKindProposalEnvelope`, and anything else malformed throws.
 */
export function parseStoredProposalEnvelope(
  value: unknown,
  proposalId: string,
): ProposalEnvelope | UnknownKindProposalEnvelope | null {
  if (value === null || value === undefined) return null;
  const parsed = proposalEnvelopeSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  if (unknownStoredEntityKind(value) !== null) return { unknownKind: true, ...storedEnvelopeShapeSchema.parse(value) };
  throw new Error(`Malformed proposal envelope on proposal ${proposalId}`);
}

/** `action_config` is a raw JSONB column (a module boundary): validated, not just cast. */
export const alldotsTickActionConfigSchema = z.object({
  inboxDatabaseId: z.string().uuid(),
  inboxItemTypesDatabaseId: z.string().uuid(),
  processingProposalsDatabaseId: z.string().uuid(),
});

export type AlldotsTickActionConfig = z.infer<typeof alldotsTickActionConfigSchema>;

/**
 * The `aiProposal` and next `aiVersion` (previous + 1, missing counts as 0) an automated writer stores.
 * `existingProperties` is the row as read under its row lock in the same transaction; `{}` for a new row.
 */
export function aiProposalPatch(
  existingProperties: Record<string, unknown>,
  envelope: ProposalEnvelope | null,
): { aiProposal: ProposalEnvelope | null; aiVersion: number } {
  const previousVersion = existingProperties.aiVersion;
  return { aiProposal: envelope, aiVersion: (typeof previousVersion === "number" ? previousVersion : 0) + 1 };
}

/**
 * The assistant's last proposal: `aiProposal` when set, else the stored `proposal` (a row predating `aiProposal` can
 * have no user override). `null` when neither holds an envelope.
 */
export function readAiProposal(
  properties: Record<string, unknown>,
  proposalId: string,
): ProposalEnvelope | UnknownKindProposalEnvelope | null {
  return (
    parseStoredProposalEnvelope(properties.aiProposal, proposalId) ??
    parseStoredProposalEnvelope(properties.proposal, proposalId)
  );
}
