import type { PoolClient } from "pg";
import { resolveCatalogLabel, type ModuleCatalogs } from "@semprec/module-registry";
import { getDatabase, getDatabaseByKey, getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { getItemsByIds, getItemsByIdsIncludingDeleted } from "../chokePoint/itemsStore.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import { getRelationDefinitionByPropertyId, listRelationsForItems, otherSide } from "../chokePoint/relationsStore.js";
import { requireSingleRow } from "../db/pool.js";
import { assertKnownValue } from "../dbRowValidation.js";
import { toManifestLocale, type ManifestLocale } from "../manifest/catalogResolution.js";
import { countPendingApprovalRequests, type ApprovalRequestSourceKind } from "../mcp/approvalRequestsStore.js";
import { listApprovalRequestsQueuePage } from "../mcp/approvalRequestsQueue.js";
import { INBOX_MODULE_ID, PROCESSING_PROPOSALS_MODULE_ID } from "../seed/inboxPipelineKeys.js";
import { FILES_MODULE_ID, TRANSCRIPTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import type { DatabaseRow, ItemRow } from "../types.js";
import { parseOccurrenceId } from "../calendar/eventOccurrenceId.js";
import { getInboxCatalogs } from "./inboxCatalogs.js";
import { renderInvalidReason } from "./invalidReason.js";
import { invalidReasonSchema, type InvalidReason } from "./inboxTickAction.js";
import { deriveApprovalCardKind, deriveInboxCardKind, type InboxCardKind } from "./inboxCardKind.js";
import {
  parseStoredProposalEnvelope,
  type ProposalEnvelope,
  type ProposalStep,
  type UnknownKindProposalEnvelope,
} from "./proposalEnvelope.js";
import { describeUpdateSteps, type ProposalChange } from "./proposalChanges.js";
import { listInboxAttachmentSummaries, type JournalInboxAttachmentSummary } from "./journalInboxCompute.js";
import { selectActiveSteps } from "./proposalStepGraph.js";

/** `total` still counts every open card. */
export const INBOX_CARDS_LIMIT = 200;

const APPROVAL_CARD_SOURCE_KINDS: readonly ApprovalRequestSourceKind[] = ["tick", "mcp"];

const OPEN_CARD_STATUSES = ["proposed", "computing", "computeFailed", "needsClarification", "invalid"] as const;
type OpenCardStatus = (typeof OPEN_CARD_STATUSES)[number];

/** Listed but not counted in `total`: they have no proposal to decide yet. */
const UNCOUNTED_STATUSES: readonly OpenCardStatus[] = ["computing", "computeFailed"];
const COUNTED_STATUSES: readonly OpenCardStatus[] = OPEN_CARD_STATUSES.filter(
  (status) => !UNCOUNTED_STATUSES.includes(status),
);

const CARD_KINDS = ["inbox", "transcript"] as const;

/** Nothing is written when it passes; the list only reports the card as failed (`isComputingTimedOut`). */
export const COMPUTING_TIMEOUT_MS = 10 * 60 * 1000;

/** Exactly at the timeout is not timed out; an unparseable `updatedAt` never times out. */
export function isComputingTimedOut(card: Pick<ItemRow, "properties" | "updatedAt">, now: Date): boolean {
  return card.properties.status === "computing" && Date.parse(card.updatedAt) < now.getTime() - COMPUTING_TIMEOUT_MS;
}

export const INBOX_CARD_TARGET_LABEL_KINDS: readonly InboxCardKind[] = [
  "task",
  "event",
  "page",
  "journal",
  "project",
  "area",
  "company",
  "person",
  "health",
  "file",
  "speaker",
];

export interface InboxCardType {
  id: string;
  name: string;
  emoji: string;
}

/**
 * `inboxItem` includes trashed items, because the card of a deleted source is `invalid` and still names it. A
 * hard-deleted source is `null`.
 */
export type InboxCardResolvedSource =
  | {
      kind: "inboxItem";
      id: string;
      text: string | null;
      date: string | null;
      time: string | null;
      type: InboxCardType | null;
      /** In the diary's order; `[]` for an item without attachments. */
      attachments: JournalInboxAttachmentSummary[];
    }
  | {
      kind: "transcript";
      id: string;
      name: string | null;
      completedAt: string | null;
    }
  | {
      kind: "run";
      sourceKind: ApprovalRequestSourceKind;
      threadId: string | null;
      threadTitle: string | null;
      heartbeatId: string | null;
      heartbeatName: string | null;
      mcpClientName: string | null;
    };

export interface InboxCardTarget {
  databaseKey: string;
  label: string;
}

/** A card with no readable stored reason gets code `unknown`, empty `field`/`label` and null `itemId`. */
export interface InboxCardInvalidReason {
  code: InvalidReason["code"] | "unknown";
  field: string;
  itemId: string | null;
  label: string;
  text: string;
}

export interface InboxCard {
  cardId: string;
  source: "proposal" | "approval";
  cardKind: InboxCardKind;
  baseKind: InboxCardKind;
  /** `pending` for an approval request. A timed-out `computing` card is listed as `computeFailed`. */
  status: string;
  computeTimedOut?: true;
  /** Usable as `ifVersion`; `null` for an approval request. */
  version: string | null;
  resolvedSource: InboxCardResolvedSource | null;
  /** Producer-written and opaque here. */
  context: unknown;
  targets: InboxCardTarget[];
  envelope: ProposalEnvelope | UnknownKindProposalEnvelope | null;
  invalidReason?: InboxCardInvalidReason;
  /** Absent without an active `update` step. Resolved on read, never stored. */
  changes?: ProposalChange[];
}

export interface InboxCardList {
  cards: InboxCard[];
  total: number;
}

export interface ListInboxCardsInput {
  ownerUserId: string;
  locale: string;
}

interface CandidateRow {
  id: string;
  kind: string;
  status: string;
  inbox_item_id: string | null;
  inbox_date: string | null;
  inbox_time: string | null;
  transcript_item_id: string | null;
  transcript_date: string | null;
}

interface Candidate {
  id: string;
  kind: (typeof CARD_KINDS)[number];
  status: OpenCardStatus;
  group: number;
  inboxItemId: string | null;
  transcriptItemId: string | null;
  /** `null` sorts last. */
  captureDate: string | null;
  captureTime: string | null;
  /** `null` (also for a value that is no date) sorts last. */
  transcriptInstant: number | null;
}

function groupOf(kind: Candidate["kind"], status: OpenCardStatus): number {
  if (kind === "transcript") return 4;
  switch (status) {
    case "proposed":
    case "computing":
    case "computeFailed":
      return 1;
    case "invalid":
      return 2;
    case "needsClarification":
      return 3;
  }
}

function compareNullable<T extends string | number>(a: T | null, b: T | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

function compareCandidates(a: Candidate, b: Candidate): number {
  return (
    a.group - b.group ||
    compareNullable(a.captureDate, b.captureDate) ||
    compareNullable(a.captureTime, b.captureTime) ||
    compareNullable(a.transcriptInstant, b.transcriptInstant) ||
    compareNullable(a.id, b.id)
  );
}

function toCandidate(row: CandidateRow): Candidate {
  const kind = assertKnownValue(CARD_KINDS, row.kind, "proposal card kind");
  const status = assertKnownValue(OPEN_CARD_STATUSES, row.status, "proposal card status");
  const instant = row.transcript_date === null ? Number.NaN : Date.parse(row.transcript_date);
  return {
    id: row.id,
    kind,
    status,
    group: groupOf(kind, status),
    inboxItemId: row.inbox_item_id,
    transcriptItemId: row.transcript_item_id,
    captureDate: row.inbox_date,
    captureTime: row.inbox_time,
    transcriptInstant: Number.isNaN(instant) ? null : instant,
  };
}

/**
 * Shared by the list and the count so the filter cannot drift between them. The arguments are SQL placeholders.
 */
function openProposalCardsPredicate(database: string, kinds: string, statuses: string): string {
  return `p.database_id = ${database}::uuid AND p.deleted_at IS NULL
        AND p.properties ->> 'kind' = ANY(${kinds}::text[])
        AND p.properties ->> 'status' = ANY(${statuses}::text[])`;
}

async function relationDefinitionId(
  client: PoolClient,
  databaseId: string,
  propertyKey: string,
): Promise<string | null> {
  const property = await getPropertyByKey(client, databaseId, propertyKey);
  if (!property) return null;
  return (await getRelationDefinitionByPropertyId(client, property.id))?.id ?? null;
}

/**
 * Reads only what orders the cards, so the whole open set is cheap to order before the page is cut. A card with
 * several source edges takes the one with the lowest id.
 */
async function listCandidates(
  client: PoolClient,
  proposalsDatabaseId: string,
  inboxDatabaseId: string | null,
  transcriptsDatabaseId: string | null,
): Promise<Candidate[]> {
  const sourceInboxDefinitionId = inboxDatabaseId
    ? await relationDefinitionId(client, proposalsDatabaseId, "sourceInbox")
    : null;
  const sourceTranscriptDefinitionId = transcriptsDatabaseId
    ? await relationDefinitionId(client, proposalsDatabaseId, "sourceTranscript")
    : null;
  const { rows } = await client.query<CandidateRow>(
    `SELECT p.id,
            p.properties ->> 'kind' AS kind,
            p.properties ->> 'status' AS status,
            inbox.id AS inbox_item_id, inbox.date AS inbox_date, inbox.time AS inbox_time,
            transcript.id AS transcript_item_id, transcript.date AS transcript_date
       FROM items p
       LEFT JOIN LATERAL (
         SELECT o.id, o.properties ->> 'date' AS date, o.properties ->> 'time' AS time
           FROM item_relations r
           JOIN items o ON o.database_id = $3::uuid AND o.id = CASE WHEN r.item_a = p.id THEN r.item_b ELSE r.item_a END
          WHERE r.relation_definition_id = $2::uuid AND (r.item_a = p.id OR r.item_b = p.id)
          ORDER BY o.id LIMIT 1
       ) inbox ON true
       LEFT JOIN LATERAL (
         SELECT o.id, o.properties ->> 'date' AS date
           FROM item_relations r
           JOIN items o ON o.database_id = $5::uuid AND o.id = CASE WHEN r.item_a = p.id THEN r.item_b ELSE r.item_a END
          WHERE r.relation_definition_id = $4::uuid AND (r.item_a = p.id OR r.item_b = p.id)
          ORDER BY o.id LIMIT 1
       ) transcript ON true
      WHERE ${openProposalCardsPredicate("$1", "$6", "$7")}`,
    [
      proposalsDatabaseId,
      sourceInboxDefinitionId,
      inboxDatabaseId,
      sourceTranscriptDefinitionId,
      transcriptsDatabaseId,
      [...CARD_KINDS],
      [...OPEN_CARD_STATUSES],
    ],
  );
  return rows.map(toCandidate).sort(compareCandidates);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

class DatabaseLookup {
  private readonly byId = new Map<string, DatabaseRow | null>();
  private readonly byKey = new Map<string, DatabaseRow | null>();

  constructor(private readonly client: PoolClient) {}

  async id(id: string): Promise<DatabaseRow | null> {
    if (!this.byId.has(id)) this.byId.set(id, await getDatabase(this.client, id));
    return this.byId.get(id) ?? null;
  }

  async key(key: string): Promise<DatabaseRow | null> {
    if (!this.byKey.has(key)) this.byKey.set(key, await getDatabaseByKey(this.client, key));
    return this.byKey.get(key) ?? null;
  }
}

type CardEnvelope = ProposalEnvelope | UnknownKindProposalEnvelope | null;

function activeStepsOf(envelope: CardEnvelope): ProposalStep[] | null {
  if (!envelope || "unknownKind" in envelope || !envelope.operations) return null;
  return selectActiveSteps(envelope.operations);
}

/** A synthetic occurrence id with no item yet is read from its series Event, which is in the same database. */
function targetItemIdOf(target: string): string {
  return parseOccurrenceId(target)?.seriesId ?? target;
}

function targetItemIdsOf(envelope: CardEnvelope, steps: ProposalStep[] | null): string[] {
  if (!envelope || "unknownKind" in envelope) return [];
  const ids = envelope.entityKind === "database" ? [] : [targetItemIdOf(envelope.target)];
  for (const step of steps ?? []) if (step.itemId !== undefined) ids.push(step.itemId);
  return ids;
}

interface PageContext {
  databases: DatabaseLookup;
  targetItems: Map<string, ItemRow>;
  catalogs: ModuleCatalogs;
  locale: ManifestLocale;
}

function targetLabel(context: PageContext, kind: InboxCardKind): string {
  return resolveCatalogLabel(null, context.catalogs[context.locale], context.catalogs.en, `card.target.${kind}`);
}

function databaseTargetKind(database: DatabaseRow): InboxCardKind {
  return deriveInboxCardKind({
    kind: "inbox",
    status: "proposed",
    envelope: { entityKind: "database", target: database.id, properties: {} },
    ownerModuleId: database.ownerModuleId,
  }).baseKind;
}

async function stepDatabase(context: PageContext, step: ProposalStep): Promise<DatabaseRow | null> {
  if (step.op === "create") return step.databaseKey ? context.databases.key(step.databaseKey) : null;
  if (step.op === "fileFromAttachment") return context.databases.key(FILES_MODULE_ID);
  const item = step.itemId ? context.targetItems.get(step.itemId) : undefined;
  return item ? context.databases.id(item.databaseId) : null;
}

/** Primary first. A database without a `key` (a user database) is left out. */
async function buildTargets(
  context: PageContext,
  baseKind: InboxCardKind,
  envelope: CardEnvelope,
  steps: ProposalStep[] | null,
): Promise<InboxCardTarget[]> {
  if (!envelope || "unknownKind" in envelope) return [];
  const targets = new Map<string, string>();
  const add = (database: DatabaseRow | null, kind: InboxCardKind) => {
    if (database?.key && INBOX_CARD_TARGET_LABEL_KINDS.includes(kind) && !targets.has(database.key)) {
      targets.set(database.key, targetLabel(context, kind));
    }
  };
  if (steps) {
    for (const step of steps) {
      const database = await stepDatabase(context, step);
      add(database, database ? databaseTargetKind(database) : baseKind);
    }
  } else if (envelope.entityKind === "database" || envelope.entityKind === "journalEntry") {
    add(await context.databases.id(envelope.target), baseKind);
  } else {
    const item = context.targetItems.get(targetItemIdOf(envelope.target));
    add(item ? await context.databases.id(item.databaseId) : null, baseKind);
  }
  return [...targets].map(([databaseKey, label]) => ({ databaseKey, label }));
}

async function ownerModuleIdOf(context: PageContext, envelope: CardEnvelope): Promise<string | null> {
  if (!envelope || "unknownKind" in envelope) return null;
  if (envelope.entityKind === "database") return (await context.databases.id(envelope.target))?.ownerModuleId ?? null;
  if (envelope.entityKind === "pageContent") {
    const page = context.targetItems.get(envelope.target);
    return page ? ((await context.databases.id(page.databaseId))?.ownerModuleId ?? null) : null;
  }
  return null;
}

/** One edge read and one item read for the whole page. */
export async function loadItemTypes(
  client: PoolClient,
  inboxDatabaseId: string,
  inboxItems: ItemRow[],
): Promise<Map<string, InboxCardType>> {
  const typeDefinitionId = await relationDefinitionId(client, inboxDatabaseId, "type");
  if (!typeDefinitionId || inboxItems.length === 0) return new Map();
  const inboxItemIds = new Set(inboxItems.map((item) => item.id));
  const edges = await listRelationsForItems(client, typeDefinitionId, [...inboxItemIds]);
  const typeIdByInboxItemId = new Map(
    edges.map((edge) => {
      const inboxItemId = inboxItemIds.has(edge.itemA) ? edge.itemA : edge.itemB;
      return [inboxItemId, otherSide(edge, inboxItemId)] as const;
    }),
  );
  const typeItems = new Map(
    (await getItemsByIds(client, [...new Set(typeIdByInboxItemId.values())])).map((item) => [item.id, item] as const),
  );
  const typeByInboxItemId = new Map<string, InboxCardType>();
  for (const [inboxItemId, typeId] of typeIdByInboxItemId) {
    const typeItem = typeItems.get(typeId);
    if (typeItem) {
      typeByInboxItemId.set(inboxItemId, {
        id: typeItem.id,
        name: stringOrNull(typeItem.properties.name) ?? "",
        emoji: stringOrNull(typeItem.properties.emoji) ?? "",
      });
    }
  }
  return typeByInboxItemId;
}

/** A missing or unparseable stored reason gives `unknown`: the card is still listed with the generic sentence. */
async function buildInvalidReason(stored: unknown, locale: string): Promise<InboxCardInvalidReason> {
  const parsed = invalidReasonSchema.safeParse(stored);
  const reason = parsed.success ? parsed.data : { code: "unknown" as const, field: "", itemId: null, label: "" };
  return { ...reason, text: await renderInvalidReason(reason, locale) };
}

/** A card trashed after the candidates were read is left out. */
async function buildProposalCards(
  client: PoolClient,
  candidates: Candidate[],
  inboxDatabaseId: string,
  locale: string,
): Promise<InboxCard[]> {
  const cardItems = new Map(
    (
      await getItemsByIds(
        client,
        candidates.map((c) => c.id),
      )
    ).map((i) => [i.id, i] as const),
  );
  const sourceItems = new Map(
    (
      await getItemsByIdsIncludingDeleted(
        client,
        candidates.flatMap((c) => [c.inboxItemId, c.transcriptItemId].filter((id): id is string => id !== null)),
      )
    ).map((item) => [item.id, item] as const),
  );
  const inboxItems = candidates.flatMap((c) => sourceItems.get(c.inboxItemId ?? "") ?? []);
  const typeByInboxItemId = await loadItemTypes(client, inboxDatabaseId, inboxItems);
  const attachmentsByInboxItemId = await listInboxAttachmentSummaries(
    client,
    inboxItems.map((item) => item.id),
  );

  const envelopes = new Map<string, { envelope: CardEnvelope; steps: ProposalStep[] | null }>();
  for (const item of cardItems.values()) {
    const envelope = parseStoredProposalEnvelope(item.properties.proposal, item.id);
    envelopes.set(item.id, { envelope, steps: activeStepsOf(envelope) });
  }
  const changesByCardId = await describeUpdateSteps(
    client,
    new Map([...envelopes].flatMap(([cardId, { steps }]) => (steps ? [[cardId, steps] as const] : []))),
    locale,
  );
  const targetItemIds = new Set([...envelopes.values()].flatMap((e) => targetItemIdsOf(e.envelope, e.steps)));
  const targetItems = new Map(
    (await getItemsByIds(client, [...targetItemIds])).map((item) => [item.id, item] as const),
  );
  const context: PageContext = {
    databases: new DatabaseLookup(client),
    targetItems,
    catalogs: await getInboxCatalogs(),
    locale: toManifestLocale(locale),
  };

  const now = new Date();
  const cards: InboxCard[] = [];
  for (const candidate of candidates) {
    const item = cardItems.get(candidate.id);
    if (!item) continue;
    const timedOut = isComputingTimedOut(item, now);
    const { envelope, steps } = envelopes.get(item.id) ?? { envelope: null, steps: null };
    const { cardKind, baseKind } = deriveInboxCardKind({
      kind: candidate.kind,
      status: candidate.status,
      envelope,
      ownerModuleId: await ownerModuleIdOf(context, envelope),
    });
    const inboxItem = candidate.inboxItemId ? sourceItems.get(candidate.inboxItemId) : undefined;
    const transcript = candidate.transcriptItemId ? sourceItems.get(candidate.transcriptItemId) : undefined;
    let resolvedSource: InboxCardResolvedSource | null = null;
    if (candidate.kind === "inbox" && inboxItem) {
      resolvedSource = {
        kind: "inboxItem",
        id: inboxItem.id,
        text: stringOrNull(inboxItem.properties.text),
        date: stringOrNull(inboxItem.properties.date),
        time: stringOrNull(inboxItem.properties.time),
        type: typeByInboxItemId.get(inboxItem.id) ?? null,
        attachments: attachmentsByInboxItemId.get(inboxItem.id) ?? [],
      };
    } else if (candidate.kind === "transcript" && transcript) {
      resolvedSource = {
        kind: "transcript",
        id: transcript.id,
        name: stringOrNull(transcript.properties.name),
        completedAt: stringOrNull(transcript.properties.date),
      };
    }
    const changes = changesByCardId.get(item.id);
    cards.push({
      cardId: item.id,
      source: "proposal",
      cardKind,
      baseKind,
      status: timedOut ? "computeFailed" : candidate.status,
      ...(timedOut ? { computeTimedOut: true as const } : {}),
      version: item.version,
      resolvedSource,
      context: item.properties.context ?? null,
      targets: await buildTargets(context, baseKind, envelope, steps),
      envelope,
      ...(changes ? { changes } : {}),
      ...(candidate.status === "invalid"
        ? { invalidReason: await buildInvalidReason(item.properties.invalidReason, locale) }
        : {}),
    });
  }
  return cards;
}

/** Uses the resolver of `GET /api/approval-requests` so both lists agree. */
async function listApprovalCards(client: PoolClient, input: ListInboxCardsInput): Promise<InboxCard[]> {
  const page = await listApprovalRequestsQueuePage(client, {
    ownerUserId: input.ownerUserId,
    status: "pending",
    sourceKinds: APPROVAL_CARD_SOURCE_KINDS,
    search: null,
    order: "asc",
    cursor: null,
    limit: INBOX_CARDS_LIMIT,
    locale: input.locale,
  });
  const { cardKind, baseKind } = deriveApprovalCardKind();
  return page.rows.map((row) => ({
    cardId: row.id,
    source: "approval",
    cardKind,
    baseKind,
    status: "pending",
    version: null,
    resolvedSource: {
      kind: "run",
      sourceKind: row.source.kind,
      threadId: row.source.threadId,
      threadTitle: row.source.threadTitle,
      heartbeatId: row.source.heartbeatId,
      heartbeatName: row.source.heartbeatName,
      mcpClientName: row.source.mcpClientName,
    },
    context: null,
    targets: [],
    envelope: null,
  }));
}

export interface CountOpenInboxCardsInput {
  ownerUserId: string;
}

/**
 * The single definition of the open Inbox count: pending tick/MCP approvals of `ownerUserId` plus open `inbox` and
 * `transcript` cards, excluding `computing` and `computeFailed`. The caller owns the tenant transaction.
 */
export async function countOpenInboxCards(client: PoolClient, input: CountOpenInboxCardsInput): Promise<number> {
  const approvals = await countPendingApprovalRequests(client, {
    ownerUserId: input.ownerUserId,
    sourceKinds: APPROVAL_CARD_SOURCE_KINDS,
  });
  const proposalsDatabase = await getDatabaseByModuleId(client, PROCESSING_PROPOSALS_MODULE_ID);
  const inboxDatabase = await getDatabaseByModuleId(client, INBOX_MODULE_ID);
  if (!proposalsDatabase || !inboxDatabase) return approvals;

  const { rows } = await client.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM items p WHERE ${openProposalCardsPredicate("$1", "$2", "$3")}`,
    [proposalsDatabase.id, [...CARD_KINDS], [...COUNTED_STATUSES]],
  );
  return approvals + requireSingleRow(rows, "open Inbox proposal cards count").count;
}

/**
 * Order: approvals, proposed (incl. `computing`/`computeFailed`), invalid, needsClarification, transcript; within a
 * group by capture time, then id. A timed-out `computing` card is listed as `computeFailed` in its stored group and
 * stays uncounted; the stored card is not changed. The caller owns the tenant transaction.
 */
export async function listInboxCards(client: PoolClient, input: ListInboxCardsInput): Promise<InboxCardList> {
  const approvalCards = await listApprovalCards(client, input);
  const proposalsDatabase = await getDatabaseByModuleId(client, PROCESSING_PROPOSALS_MODULE_ID);
  const inboxDatabase = await getDatabaseByModuleId(client, INBOX_MODULE_ID);
  if (!proposalsDatabase || !inboxDatabase)
    return { cards: approvalCards, total: await countOpenInboxCards(client, input) };

  const transcriptsDatabase = await getDatabaseByModuleId(client, TRANSCRIPTS_MODULE_ID);
  const candidates = await listCandidates(
    client,
    proposalsDatabase.id,
    inboxDatabase.id,
    transcriptsDatabase?.id ?? null,
  );
  const page = candidates.slice(0, INBOX_CARDS_LIMIT - approvalCards.length);
  const proposals = await buildProposalCards(client, page, inboxDatabase.id, input.locale);
  return { cards: [...approvalCards, ...proposals], total: await countOpenInboxCards(client, input) };
}
