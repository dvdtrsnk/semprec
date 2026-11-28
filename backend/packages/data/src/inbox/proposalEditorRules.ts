import type { PoolClient } from "pg";
import type { EditorSchemaDescriptor, ModuleRegistry } from "@alldots/module-registry";
import * as databasesStore from "../chokePoint/databasesStore.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import { UUID_RE } from "../docs/pageOwnerDatabase.js";
import { ValidationError } from "../errors.js";
import { loadFullModuleRegistry } from "../manifest/fullModuleRegistry.js";
import { buildEditorValues, findMissingRequired } from "./editorSchema.js";
import { deriveInboxCardKind } from "./inboxCardKind.js";
import type { ProposalEnvelope } from "./proposalEnvelope.js";
import { parseUserOverrides } from "./proposalOverrides.js";

// What a proposal card's editor schema asks of its values: the one evaluation confirm and the values edit share.

export interface CardEditorRules {
  schema: EditorSchemaDescriptor;
  /** Editor-only fields that are not destination properties (`allDay`, `followDate`, `day`, ...); never written. */
  pseudoKeys: ReadonlySet<string>;
  /** The keys the schema's field keys are measured against (for Markdown `pageContent`, the page-content keys). */
  destinationKeys: ReadonlySet<string>;
}

/** The keys of a v2 `pageContent` envelope, which an edit may set even when the envelope does not hold them yet. */
const PAGE_CONTENT_KEYS = ["markdown", "placement", "heading"];

export type EditorSchemaSource = Pick<ModuleRegistry, "getEditorSchemas">;

let moduleRegistryPromise: Promise<ModuleRegistry> | undefined;

/**
 * Loaded once per process: confirm and the values edit receive only a client, not the composition root's registry. A
 * failed load is not cached, so the next call retries.
 */
function getModuleRegistry(): Promise<ModuleRegistry> {
  moduleRegistryPromise ??= loadFullModuleRegistry().catch((error: unknown) => {
    moduleRegistryPromise = undefined;
    throw error;
  });
  return moduleRegistryPromise;
}

/**
 * Whether the schema describes what the envelope writes. Not for `relation` (creates nothing), multi-step envelopes
 * whose primary step edits an existing item, legacy block `pageContent` without `markdown`, or `journalEntry` (its
 * `date`/`markdown` shape differs from the `journal` schema's, so the schema would call a complete card incomplete).
 */
function schemaDescribes(envelope: ProposalEnvelope): boolean {
  if (envelope.entityKind === "relation" || envelope.entityKind === "journalEntry") return false;
  if (envelope.entityKind === "pageContent") return Object.hasOwn(envelope.properties, "markdown");
  return !envelope.operations || envelope.operations.find((step) => step.role === "primary")?.op === "create";
}

/** The `owner_module_id` of the envelope's target database or target page's database; `null` when not found. */
export async function destinationOwnerModuleId(client: PoolClient, envelope: ProposalEnvelope): Promise<string | null> {
  if (!UUID_RE.test(envelope.target)) return null;
  if (envelope.entityKind === "database")
    return (await databasesStore.getDatabase(client, envelope.target))?.ownerModuleId ?? null;
  const [page] = await itemsStore.getItemsByIds(client, [envelope.target]);
  return page ? ((await databasesStore.getDatabase(client, page.databaseId))?.ownerModuleId ?? null) : null;
}

/**
 * The card's editor schema with its pseudo keys, or `null` when the base kind has none or the schema does not
 * describe what the envelope writes. `registry` defaults to the process-wide one; tests may pass another.
 */
export async function loadCardEditorRules(
  client: PoolClient,
  storedKind: unknown,
  envelope: ProposalEnvelope,
  registry?: EditorSchemaSource,
): Promise<CardEditorRules | null> {
  if (!schemaDescribes(envelope)) return null;
  const { cardKind, baseKind } = deriveInboxCardKind({
    kind: storedKind === "transcript" ? "transcript" : "inbox",
    status: "proposed",
    envelope,
    ownerModuleId: await destinationOwnerModuleId(client, envelope),
  });
  // A destination no module maps to a card kind is a `clarify` card; the card list shows it the page editor, but
  // what it writes is not a page, so that schema is not applied to it.
  if (cardKind === "clarify") return null;
  const declaration = (await (registry ?? (await getModuleRegistry())).getEditorSchemas()).find(
    (candidate) => candidate.baseKind === baseKind,
  );
  if (!declaration) return null;
  const destinationKeys = new Set(
    envelope.entityKind === "database"
      ? (await propertiesStore.listPropertiesByDatabase(client, envelope.target)).map((property) => property.key)
      : [...PAGE_CONTENT_KEYS, ...Object.keys(envelope.properties)],
  );
  const pseudoKeys = new Set(
    declaration.schema.groups
      .flatMap((group) => group.fields.map((field) => field.key))
      .filter((key) => !destinationKeys.has(key)),
  );
  return { schema: declaration.schema, pseudoKeys, destinationKeys };
}

/**
 * Refuses a confirm while a visible required field of the card's editor schema has no value (`details.field` the
 * first in schema order, plus `details.ref` for multi-step cards). Call before any destination write.
 */
export async function assertRequiredFieldsHaveValues(
  client: PoolClient,
  proposal: { id: string; properties: Record<string, unknown> },
  envelope: ProposalEnvelope,
  registry?: EditorSchemaSource,
): Promise<void> {
  const rules = await loadCardEditorRules(client, proposal.properties.kind, envelope, registry);
  if (!rules) return;
  const userOverrides = parseUserOverrides(proposal.properties.userOverrides, proposal.id);
  const [first] = findMissingRequired(rules.schema, buildEditorValues(envelope, userOverrides));
  if (!first) return;
  throw new ValidationError(`Required field '${first.field}' has no value`, {
    field: first.field,
    ...(first.ref === undefined ? {} : { ref: first.ref }),
  });
}
