import type { PoolClient } from "pg";
import type { EditorSchemaDescriptor, ModuleRegistry } from "@semprec/module-registry";
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

/**
 * What a proposal card's editor schema asks of its values (issue #1928): the one evaluation that confirm and the
 * values edit share. Split out of `proposalActions.ts` to keep that file under the ESLint line cap.
 */

/** The editor schema of a card and the keys of it that the card's destination does not have as properties. */
export interface CardEditorRules {
  schema: EditorSchemaDescriptor;
  /** Editor fields that are no property of the destination (`allDay`, `followupTask`, `followDate`, `day`, ...): values for the editor only, never written to the created item. */
  pseudoKeys: ReadonlySet<string>;
  /** The keys the destination has as properties (for a Markdown `pageContent` envelope, the page-content keys and the envelope's own), which the schema's field keys are measured against. */
  destinationKeys: ReadonlySet<string>;
}

/** The keys of a v2 `pageContent` envelope, which an edit may set whether or not the assistant's envelope holds them yet. */
const PAGE_CONTENT_KEYS = ["markdown", "placement", "heading"];

/** What the rules read from the module registry: the editor schemas the modules declare. */
export type EditorSchemaSource = Pick<ModuleRegistry, "getEditorSchemas">;

let moduleRegistryPromise: Promise<ModuleRegistry> | undefined;

/**
 * The module registry the editor schemas are read from, loaded once per process by `loadFullModuleRegistry`. Confirm
 * and the values edit receive only a client, so they cannot take the composition root's registry. A failed load is
 * not cached, so the next call retries instead of failing until restart.
 */
function getModuleRegistry(): Promise<ModuleRegistry> {
  moduleRegistryPromise ??= loadFullModuleRegistry().catch((error: unknown) => {
    moduleRegistryPromise = undefined;
    throw error;
  });
  return moduleRegistryPromise;
}

/**
 * Whether the schema describes what the envelope writes. A `relation` envelope links an item and creates nothing; a
 * multi-step envelope whose primary step is an `update` or `link` edits an item that already has its values; and a
 * `pageContent` envelope without `markdown` is the legacy block shape, which the Markdown fields do not describe.
 */
function schemaDescribes(envelope: ProposalEnvelope): boolean {
  if (envelope.entityKind === "relation") return false;
  if (envelope.entityKind === "pageContent") return Object.hasOwn(envelope.properties, "markdown");
  return !envelope.operations || envelope.operations.find((step) => step.role === "primary")?.op === "create";
}

/**
 * The `databases.owner_module_id` of the envelope's destination: the target database, or the database of the target
 * page. `null` when the target is not an id (the envelope validation refuses that) or cannot be found.
 */
export async function destinationOwnerModuleId(client: PoolClient, envelope: ProposalEnvelope): Promise<string | null> {
  if (!UUID_RE.test(envelope.target)) return null;
  if (envelope.entityKind === "database")
    return (await databasesStore.getDatabase(client, envelope.target))?.ownerModuleId ?? null;
  const [page] = await itemsStore.getItemsByIds(client, [envelope.target]);
  return page ? ((await databasesStore.getDatabase(client, page.databaseId))?.ownerModuleId ?? null) : null;
}

/**
 * The editor schema of the card that `envelope` belongs to, with its pseudo keys, or `null` when the card has
 * none to apply: the base kind has no declaration, or the schema does not describe what the envelope writes
 * (`schemaDescribes`). The base kind is the card's, as the card list derives it for a `proposed` card
 * (`deriveInboxCardKind`); `storedKind` is the card's stored `kind` (`inbox` or `transcript`). `registry` is the
 * source of the declarations: the process-wide module registry unless a caller passes another, so a test can
 * drive a base kind that no module declares.
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
 * Refuses a confirm while a visible required field of the card's editor schema has no value: a `ValidationError`
 * naming the first one in schema order as `details.field`, with `details.ref` for a card of several steps. A card
 * whose base kind has no schema passes. Call it before any destination write. `registry` is as in
 * `loadCardEditorRules`.
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
