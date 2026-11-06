import { z } from "zod";

/**
 * The generic proposal envelope (issue #100/#223): `entityKind`, `target`, `properties` and, for
 * `'database'` only, optional `relations`.
 * `'relation'` (issue #184) links the card's source item to the existing item `target` through the
 * relation property named by `properties.propertyKey`, with `properties.metadata` (optional) as
 * the edge's metadata — never computed by the Inbox tick. A transcript card reaches the
 * Event-link shape only through a human `revise`; its speaker-mapping shape (issue #185) is
 * proposed by the transcription pipeline.
 */
export type ProposalEntityKind = "pageContent" | "database" | "relation";

/** The entity kinds the Inbox tick itself computes, one per `processingMethod`. */
export type ComputedProposalEntityKind = Exclude<ProposalEntityKind, "relation">;

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

export const proposalEnvelopeSchema = z.object({
  entityKind: z.enum(["pageContent", "database", "relation"]),
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
