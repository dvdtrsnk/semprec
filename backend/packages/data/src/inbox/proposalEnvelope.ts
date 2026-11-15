import { z } from "zod";

/**
 * The generic proposal envelope (issue #100/#223): `entityKind`, `target`, `properties` and, for
 * `'database'` only, optional `relations`.
 * `'relation'` (issue #184) links the card's source item to the existing item `target` through the
 * relation property named by `properties.propertyKey`, with `properties.metadata` (optional) as
 * the edge's metadata — never computed by the Inbox tick. A transcript card reaches the
 * Event-link shape only through a human `revise`; its speaker-mapping shape (issue #185) is
 * proposed by the transcription pipeline. `'transcription'` (issue gh-1978) proposes transcribing the audio attachment
 * `target` of the card's source Inbox item with the recording parameters in `properties`; the Inbox tick produces it
 * from the attachment without a model call (`recordingCardProducer.ts`). `'journalEntry'` (issue gh-1975) proposes an
 * entry on the Journal day `properties.date`: `target` is the Journal database, `properties` are `{ date, markdown,
 * areaId?, projectId? }` (`journalEntryEnvelope.ts`); the Inbox tick produces it for the `journal` processing method, with the
 * server supplying `target` (issue gh-1982).
 */
export type ProposalEntityKind = "pageContent" | "database" | "relation" | "transcription" | "journalEntry";

/** The entity kinds the Inbox tick's model computation produces, one per `processingMethod`. */
export type ComputedProposalEntityKind = Exclude<ProposalEntityKind, "relation" | "transcription">;

/** A relation target inside a step: an existing item id, or the `ref` of another step of the same proposal. */
const stepRelationTargetSchema = z.union([z.string().min(1), z.object({ ref: z.string().min(1) })]);

const stepRelationsSchema = z.record(z.string(), z.array(stepRelationTargetSchema));

/**
 * One step of a multi-step envelope (`docs/adr/2026-10-25-multi-step-proposal-envelope.md`).
 * `create` names its database by `databaseKey`; `update` and `link` name an existing item by `itemId`.
 * `fileFromAttachment` names neither: it writes the system Files database, and its `properties` are
 * the attachment to move and the Files item's name and date. It is never the primary step
 * (`docs/adr/2026-10-29-file-from-attachment-proposal-step.md`).
 * `enabled` defaults to true and `optional` to false when absent. `before` holds the current values
 * of the properties and relations an `update` step changes, `after` the values it writes.
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

/** The longest heading, in characters, a proposed page section has (the page heading limit of a proposal's `heading`). */
export const MAX_PAGE_SECTION_HEADING_CHARS = 200;
/** The most items a proposed page section lists, and the longest item in characters. */
export const MAX_PAGE_SECTION_ITEMS = 100;
export const MAX_PAGE_SECTION_ITEM_CHARS = 500;
/** The most sections one envelope proposes. */
export const MAX_PAGE_SECTIONS = 4;

/**
 * One section of the page a created item gets when its card is confirmed (issue gh-1974): a heading block followed by
 * one `blockType` block per item, `bullet` for a bulleted list and `number` for a numbered one. Plain text, never
 * Markdown: a line of a recipe that reads like Markdown is written as the text it is.
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

/** The most new select options one envelope proposes (issue gh-1994). */
export const MAX_PROPOSAL_NEW_OPTIONS = 3;

/**
 * One select option an envelope proposes to create when its card is confirmed (issue gh-1994): the `select` or
 * `multi_select` property of the target database it joins, the label the option shows and an optional color. Only the
 * shape is the schema's: the length of the label, the color and every other rule are checked by
 * `assertValidEnvelopeNewOptions`, so that a stored envelope that breaks one still parses and is refused with a
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
  /**
   * `'database'` envelopes only: item ids of the targets per relation property key on the target
   * database. An empty array means no edge. Written on confirm, not by this module.
   */
  relations: z.record(z.string(), z.array(z.string().min(1))).optional(),
  /**
   * Every step of a multi-step proposal, the primary one included; the top-level `entityKind`,
   * `target` and `properties` mirror the primary step. Absent for a single-step envelope.
   */
  operations: z.array(proposalStepSchema).optional(),
  /**
   * `'database'` envelopes without `operations` only: the sections of the page the created item gets on confirm,
   * written after the item and authored by the confirming user (`proposalPageSections.ts`). Absent when the item gets
   * no page content.
   */
  pageSections: z.array(proposalPageSectionSchema).min(1).max(MAX_PAGE_SECTIONS).optional(),
  /**
   * `'database'` envelopes without `operations` only: the select options the confirm creates before it creates the
   * item (issue gh-1994, `proposalNewOptions.ts`). A value in `properties` names one by its label as
   * `{ newOption: "<label>" }` in the place of an option key. Absent when the proposal creates no option.
   */
  newOptions: z.array(proposalNewOptionSchema).optional(),
});

export type ProposalEnvelope = z.infer<typeof proposalEnvelopeSchema>;

/**
 * A stored envelope that is well-formed but whose `entityKind` this release does not know (a kind
 * written by a newer release, kept readable for one-release rollback). It is displayed, never
 * executed: confirm and revise refuse it. `proposalEnvelopeSchema` stays strict for writing.
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

/** The `entityKind` of a stored envelope that is well-formed but of a kind this release does not know; `null` for a known kind or a malformed value. */
export function unknownStoredEntityKind(value: unknown): string | null {
  if (proposalEnvelopeSchema.safeParse(value).success) return null;
  const shape = storedEnvelopeShapeSchema.safeParse(value);
  if (!shape.success) return null;
  return (proposalEnvelopeSchema.shape.entityKind.options as readonly string[]).includes(shape.data.entityKind)
    ? null
    : shape.data.entityKind;
}

/**
 * Parses a Processing proposal's stored `proposal` JSONB property: `null`/`undefined` (no
 * envelope computed yet) → `null`; a well-formed envelope of an unknown `entityKind` → the
 * `UnknownKindProposalEnvelope` shape; anything else that is not a well-formed envelope throws.
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

/** `action_config` is a raw JSONB column (a module boundary) — validated, not just cast. */
export const semprecTickActionConfigSchema = z.object({
  inboxDatabaseId: z.string().uuid(),
  inboxItemTypesDatabaseId: z.string().uuid(),
  processingProposalsDatabaseId: z.string().uuid(),
});

export type SemprecTickActionConfig = z.infer<typeof semprecTickActionConfigSchema>;

/**
 * The `aiProposal` and `aiVersion` an automated writer stores with a Processing proposal: the
 * assistant's output `envelope` (`null` for `needsClarification`) and the version counter, one above
 * the row's previous `aiVersion`. A row without a counter counts as 0, so a legacy card gets 1 on its
 * next automated write. `existingProperties` is the row as read under its row lock in the write's own
 * transaction; a row being created passes `{}`.
 */
export function aiProposalPatch(
  existingProperties: Record<string, unknown>,
  envelope: ProposalEnvelope | null,
): { aiProposal: ProposalEnvelope | null; aiVersion: number } {
  const previousVersion = existingProperties.aiVersion;
  return { aiProposal: envelope, aiVersion: (typeof previousVersion === "number" ? previousVersion : 0) + 1 };
}

/**
 * The assistant's last proposal of a Processing proposal row: its `aiProposal` when that is set, else its
 * stored `proposal`. A row written before `aiProposal` existed has none, and its `proposal` is the
 * assistant's output because no user override could exist yet. `null` when neither holds an envelope.
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
