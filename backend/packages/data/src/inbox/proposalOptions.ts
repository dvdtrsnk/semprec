import type { PoolClient } from "pg";
import { z } from "zod";
import { resolveCatalogLabel } from "@semprec/module-registry";
import * as databasesStore from "../chokePoint/databasesStore.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import { relationTargetBlock } from "../chokePoint/relationTargetState.js";
import { UUID_RE } from "../docs/pageOwnerDatabase.js";
import { NotFoundError } from "../errors.js";
import { toManifestLocale } from "../manifest/catalogResolution.js";
import { PAGES_MODULE_ID } from "../seed/pagesModuleKey.js";
import { AREAS_MODULE_ID, COMPANIES_MODULE_ID, PEOPLE_MODULE_ID, PROJECTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import type { DatabaseRow, ItemRow } from "../types.js";
import { buildEditorValues } from "./editorSchema.js";
import { getInboxCatalogs } from "./inboxCatalogs.js";
import type { ProposalActionConfig } from "./proposalActions.js";
import { readAiProposal, parseStoredProposalEnvelope, type ProposalEnvelope } from "./proposalEnvelope.js";
import { parseUserOverrides, type UserOverrides } from "./proposalOverrides.js";
import { effectiveStepRelations, selectActiveSteps } from "./proposalStepGraph.js";

// The choices a card's picker offers for one field (`GET /api/proposals/:id/options`). Read-only.

export const PROPOSAL_OPTION_FIELDS = ["project", "area", "people", "company", "page", "mcpProjects"] as const;
export type ProposalOptionField = (typeof PROPOSAL_OPTION_FIELDS)[number];

export function isProposalOptionField(value: string): value is ProposalOptionField {
  return (PROPOSAL_OPTION_FIELDS as readonly string[]).includes(value);
}

export interface ProposalOption {
  /** `null` for the none choice and for a step that would create the item (`ref` names it). */
  id: string | null;
  ref?: string;
  label: string;
  color?: string;
  initials?: string;
  disabled: boolean;
  disabledReason?: "archived" | "deleted";
  hint?: string;
  suggested: boolean;
  none?: true;
}

interface FieldSpec {
  sourceModuleIds: readonly string[];
  /** Where the none choice sits, `null` when the field has none. */
  none: "first" | "last" | null;
  /** Whether usage is the card relation's edge count; other fields have no such relation. */
  countsEdges: boolean;
}

const FIELD_SPECS: Readonly<Record<ProposalOptionField, FieldSpec>> = {
  project: { sourceModuleIds: [PROJECTS_MODULE_ID], none: "last", countsEdges: true },
  area: { sourceModuleIds: [AREAS_MODULE_ID], none: "first", countsEdges: true },
  people: { sourceModuleIds: [PEOPLE_MODULE_ID], none: null, countsEdges: true },
  company: { sourceModuleIds: [COMPANIES_MODULE_ID], none: "last", countsEdges: true },
  page: { sourceModuleIds: [PROJECTS_MODULE_ID, AREAS_MODULE_ID, PAGES_MODULE_ID], none: null, countsEdges: false },
  mcpProjects: { sourceModuleIds: [PROJECTS_MODULE_ID], none: null, countsEdges: false },
};

const relationConfigSchema = z.object({ targetDatabaseId: z.string() });

interface FieldReferences {
  itemIds: ReadonlySet<string>;
  stepRefs: ReadonlySet<string>;
}

const NO_REFERENCES: FieldReferences = { itemIds: new Set(), stepRefs: new Set() };

function idsOf(value: unknown): string[] {
  const candidates = Array.isArray(value) ? (value as unknown[]) : [value];
  return candidates.filter(
    (candidate): candidate is string => typeof candidate === "string" && UUID_RE.test(candidate),
  );
}

/**
 * The item ids and step refs `envelope` (with `overrides` over it) holds for `field`: from the primary step's relation
 * lists and the field's own key. The caller decides which belong to the field's database.
 */
function readReferences(
  envelope: ProposalEnvelope | null,
  overrides: UserOverrides,
  field: ProposalOptionField,
): FieldReferences {
  if (!envelope) return NO_REFERENCES;
  const primary = envelope.operations ? selectActiveSteps(envelope.operations).find((s) => s.role === "primary") : null;
  const lists = Object.values(primary ? effectiveStepRelations(primary) : (envelope.relations ?? {}));
  const targets = lists.flat();
  const values = buildEditorValues(envelope, overrides)[0]?.values ?? {};
  return {
    itemIds: new Set([...targets.filter((target) => typeof target === "string"), ...idsOf(values[field])]),
    stepRefs: new Set(targets.flatMap((target) => (typeof target === "string" ? [] : [target.ref]))),
  };
}

/** The target database of a `database` envelope, else the database of the target item. */
async function destinationDatabaseId(client: PoolClient, envelope: ProposalEnvelope | null): Promise<string | null> {
  if (!envelope || !UUID_RE.test(envelope.target)) return null;
  if (envelope.entityKind === "database") return envelope.target;
  const [target] = await itemsStore.getItemsByIdsIncludingDeleted(client, [envelope.target]);
  return target?.databaseId ?? null;
}

/**
 * Edge counts per candidate over the relations between the card's destination and the field's source databases, in
 * one grouped query.
 */
async function countUsage(
  client: PoolClient,
  destinationDatabaseId: string | null,
  sourceDatabaseIds: ReadonlySet<string>,
  candidateIds: readonly string[],
): Promise<Map<string, number>> {
  if (destinationDatabaseId === null) return new Map();
  const properties = (await propertiesStore.listPropertiesByDatabase(client, destinationDatabaseId)).filter(
    (property) => {
      const config = property.type === "relation" ? relationConfigSchema.safeParse(property.config) : null;
      return config?.success === true && sourceDatabaseIds.has(config.data.targetDatabaseId);
    },
  );
  const definitions = await relationsStore.getRelationDefinitionsByPropertyIds(
    client,
    properties.map((property) => property.id),
  );
  const targetOnSideB: string[] = [];
  const targetOnSideA: string[] = [];
  for (const property of properties) {
    const definition = definitions.get(property.id);
    if (!definition) continue;
    (definition.propertyIdA === property.id ? targetOnSideB : targetOnSideA).push(definition.id);
  }
  return relationsStore.countRelationEdgesToTargets(client, { targetOnSideB, targetOnSideA }, candidateIds);
}

function stringProperty(item: ItemRow, key: string | null): string {
  const value = key === null ? undefined : item.properties[key];
  return typeof value === "string" ? value : "";
}

function initialsOf(name: string): string {
  const words = name.split(/\s+/).filter((word) => word.length > 0);
  const first = words[0];
  const last = words.at(-1);
  if (first === undefined || last === undefined) return "";
  const letter = (word: string): string => (Array.from(word)[0] ?? "").toLocaleUpperCase();
  return words.length === 1 ? letter(first) : `${letter(first)}${letter(last)}`;
}

interface RankedOption {
  option: ProposalOption;
  rank: 0 | 1 | 2;
  edges: number;
}

/**
 * The picker choices of `field` for the card, in display order: current value, then the assistant's suggestion
 * (`aiProposal`), then by edge usage, then by name. The none choice is last for `project`/`company`, first for
 * `area`, absent otherwise. A trashed or archived target is listed only as the current value, `disabled`; a `done`
 * project only as the current value or with `includeDone`. Steps that would create an item in the field's database
 * are listed by `ref`. Read-only, unlocked; unknown, trashed and other-tenant cards (RLS) are all `NotFoundError`.
 */
export async function listProposalOptions(
  client: PoolClient,
  config: ProposalActionConfig,
  proposalId: string,
  field: ProposalOptionField,
  locale: string,
  includeDone: boolean,
): Promise<ProposalOption[]> {
  const card = await itemsStore.getItemById(client, config.processingProposalsDatabaseId, proposalId);
  if (!card || card.deletedAt) throw new NotFoundError(`Processing proposal ${proposalId} not found`);
  const spec = FIELD_SPECS[field];
  const manifestLocale = toManifestLocale(locale);
  const catalogs = await getInboxCatalogs();
  const text = (key: string): string => resolveCatalogLabel(null, catalogs[manifestLocale], catalogs.en, key);

  const stored = parseStoredProposalEnvelope(card.properties.proposal, card.id);
  const effective = stored && !("unknownKind" in stored) ? stored : null;
  const assistant = readAiProposal(card.properties, card.id);
  const suggestedEnvelope = assistant && !("unknownKind" in assistant) ? assistant : null;
  const current = readReferences(effective, parseUserOverrides(card.properties.userOverrides, card.id), field);
  const suggested = readReferences(suggestedEnvelope, {}, field);

  const sources: DatabaseRow[] = [];
  for (const moduleId of spec.sourceModuleIds) {
    const database = await databasesStore.getDatabaseByModuleId(client, moduleId);
    if (database) sources.push(database);
  }
  const moduleOfDatabase = new Map(sources.map((database) => [database.id, database.ownerModuleId]));
  const titleKeys = new Map(
    (await databasesStore.listDatabaseLabelsByIds(client, [...moduleOfDatabase.keys()])).map((label) => [
      label.id,
      label.titlePropertyKey,
    ]),
  );
  const items = (
    await Promise.all(sources.map((database) => itemsStore.getAllItemsInDatabase(client, database.id)))
  ).flat();

  const candidates = items.flatMap((item) => {
    const isCurrent = current.itemIds.has(item.id);
    const ownerModuleId = moduleOfDatabase.get(item.databaseId) ?? null;
    const block = relationTargetBlock(item, ownerModuleId);
    const isDoneProject = ownerModuleId === PROJECTS_MODULE_ID && item.properties.status === "done";
    if (!isCurrent && (block !== null || (isDoneProject && !includeDone))) return [];
    return [{ item, isCurrent, block, ownerModuleId }];
  });

  const usage = spec.countsEdges
    ? await countUsage(
        client,
        await destinationDatabaseId(client, effective),
        new Set(moduleOfDatabase.keys()),
        candidates.map(({ item }) => item.id),
      )
    : new Map<string, number>();

  const ranked: RankedOption[] = candidates.map(({ item, isCurrent, block, ownerModuleId }) => {
    const label = stringProperty(item, titleKeys.get(item.databaseId) ?? null);
    const color =
      ownerModuleId === PROJECTS_MODULE_ID || ownerModuleId === AREAS_MODULE_ID ? item.properties.color : null;
    const isSuggested = suggested.itemIds.has(item.id);
    return {
      option: {
        id: item.id,
        label,
        ...(typeof color === "string" && color.length > 0 ? { color } : {}),
        ...(ownerModuleId === PEOPLE_MODULE_ID ? { initials: initialsOf(label) } : {}),
        disabled: block !== null,
        ...(block === null
          ? {}
          : { disabledReason: block === "targetDeleted" ? ("deleted" as const) : ("archived" as const) }),
        suggested: isSuggested,
      },
      rank: isCurrent ? 0 : isSuggested ? 1 : 2,
      edges: usage.get(item.id) ?? 0,
    };
  });

  const sourceKeys = new Set(sources.map((database) => database.key));
  const steps = effective?.operations ? selectActiveSteps(effective.operations) : [];
  for (const step of steps) {
    if (step.op !== "create" || step.role === "primary" || !step.databaseKey || !sourceKeys.has(step.databaseKey))
      continue;
    const name = step.properties?.name;
    ranked.push({
      option: {
        id: null,
        ref: step.ref,
        label: typeof name === "string" && name.trim().length > 0 ? name : step.ref,
        disabled: false,
        hint: text("options.newStep.hint"),
        suggested: true,
      },
      rank: current.stepRefs.has(step.ref) ? 0 : 1,
      edges: 0,
    });
  }

  const collator = new Intl.Collator(manifestLocale);
  ranked.sort(
    (a, b) =>
      a.rank - b.rank ||
      b.edges - a.edges ||
      collator.compare(a.option.label, b.option.label) ||
      (a.option.id ?? a.option.ref ?? "").localeCompare(b.option.id ?? b.option.ref ?? ""),
  );
  const options = ranked.map(({ option }) => option);
  if (spec.none === null) return options;
  const none: ProposalOption = {
    id: null,
    label: text(`options.none.${field}`),
    disabled: false,
    suggested: false,
    none: true,
  };
  return spec.none === "first" ? [none, ...options] : [...options, none];
}
