import type { PoolClient } from "pg";
import { resolveCatalogLabel, type ModuleCatalogs } from "@semprec/module-registry";
import { getDatabase, getDatabaseByKey, getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { getItemsByIds, getItemsByIdsIncludingDeleted } from "../chokePoint/itemsStore.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import { getRelationDefinitionByPropertyId, listRelationsForItems, otherSide } from "../chokePoint/relationsStore.js";
import { assertKnownValue } from "../dbRowValidation.js";
import { toManifestLocale, type ManifestLocale } from "../manifest/catalogResolution.js";
import {
  listApprovalRequestsPage,
  parseApprovalRequestListCursor,
  type ApprovalRequestSourceKind,
} from "../mcp/approvalRequestsStore.js";
import { listApprovalRequestsQueuePage } from "../mcp/approvalRequestsQueue.js";
import { INBOX_MODULE_ID, PROCESSING_PROPOSALS_MODULE_ID } from "../seed/inboxPipelineKeys.js";
import { FILES_MODULE_ID, TRANSCRIPTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import type { DatabaseRow, ItemRow } from "../types.js";
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
import { selectActiveSteps } from "./proposalStepGraph.js";

/** The most cards `GET /api/inbox/cards` returns; `total` still counts every open card. */
export const INBOX_CARDS_LIMIT = 200;

/** The kinds of source whose pending approval requests are cards (chat approvals are not). */
const APPROVAL_CARD_SOURCE_KINDS: readonly ApprovalRequestSourceKind[] = ["tick", "mcp"];

/** The stored statuses of an open Processing proposals card: not confirmed, rejected or deleted. */
const OPEN_CARD_STATUSES = ["proposed", "computing", "computeFailed", "needsClarification", "invalid"] as const;
type OpenCardStatus = (typeof OPEN_CARD_STATUSES)[number];

/** Cards in these states are listed but not counted in `total`: they have no proposal to decide yet. */
const UNCOUNTED_STATUSES: readonly OpenCardStatus[] = ["computing", "computeFailed"];

const CARD_KINDS = ["inbox", "transcript"] as const;

/** The card kinds whose targets carry a label, one catalog entry `card.target.<baseKind>` each. */
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

/** Where the approvals are counted past the first page: one page is this many requests. */
const APPROVAL_COUNT_PAGE_SIZE = 500;

export interface InboxCardType {
  id: string;
  name: string;
  emoji: string;
}

/**
 * What a card was made from. `inboxItem` is the capture of an Inbox card (also when the item is in the
 * Trash, because the card of a deleted source is `invalid` and still names it), `transcript` the source of
 * a transcript card, `run` the run that raised an approval request. A source that cannot be read (a hard
 * deleted item) is `null` on the card.
 */
export type InboxCardResolvedSource =
  | {
      kind: "inboxItem";
      id: string;
      text: string | null;
      date: string | null;
      time: string | null;
      type: InboxCardType | null;
    }
  | {
      kind: "transcript";
      id: string;
      name: string | null;
      /** The transcript's `date` until the transcript has a finish time of its own. */
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
  /** The `databases.key` of the database the card writes or edits. */
  databaseKey: string;
  /** The label of the target's kind (not a database name for a page or a speaker) in the caller's locale. */
  label: string;
}

/**
 * Why an `invalid` card cannot be confirmed (issue #2027). `code`, `field`, `itemId` and `label` are the stored
 * reason; a card with no readable stored reason has the code `unknown`, an empty `field` and `label` and a null
 * `itemId`. `text` is the sentence for that code in the caller's locale.
 */
export interface InboxCardInvalidReason {
  code: InvalidReason["code"] | "unknown";
  field: string;
  itemId: string | null;
  label: string;
  text: string;
}

export interface InboxCard {
  /** The Processing proposals item id of a proposal card, the approval request id of an approval card. */
  cardId: string;
  source: "proposal" | "approval";
  cardKind: InboxCardKind;
  baseKind: InboxCardKind;
  /** The stored proposal status, or `pending` for an approval request. */
  status: string;
  /** The item's `updatedAt`, usable as `ifVersion`; `null` for an approval request, which has no item. */
  version: string | null;
  resolvedSource: InboxCardResolvedSource | null;
  /** The card's `context` property as stored (producer-written, opaque here); `null` when unset. */
  context: unknown;
  targets: InboxCardTarget[];
  /** The effective envelope (the stored `proposal`); `null` before one was computed and for an approval. */
  envelope: ProposalEnvelope | UnknownKindProposalEnvelope | null;
  /** Present on a card whose status is `invalid` and absent on every other card. */
  invalidReason?: InboxCardInvalidReason;
}

export interface InboxCardList {
  cards: InboxCard[];
  total: number;
}

export interface ListInboxCardsInput {
  ownerUserId: string;
  /** The caller's `users.locale`; labels are resolved in it, English is the fallback. */
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
  /** `YYYY-MM-DD` and `HH:MM` as the Inbox item stores them; `null` sorts last. */
  captureDate: string | null;
  captureTime: string | null;
  /** The transcript's date as an instant; `null` (also for a value that is no date) sorts last. */
  transcriptInstant: number | null;
}

/**
 * The group of a card in the stack: proposed (with `computing` and `computeFailed`), invalid,
 * needsClarification, and last every transcript card. Approvals come before all of them.
 */
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

/** Group, then capture time (Inbox `date` and `time`, the transcript's date for a transcript card), then id. */
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

/** The relation definition behind `propertyKey` of `databaseId`, or `null` when the property or its relation is missing. */
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
 * Every open card with just what orders it: its group and the date and time of its source. The
 * source is the Inbox item a `sourceInbox` edge points at (a trashed one included) and the transcript
 * a `sourceTranscript` edge points at; a card with several edges takes the one with the lowest id.
 * Nothing else is read here, so the whole open set is cheap to order before the page is cut.
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
      WHERE p.database_id = $1 AND p.deleted_at IS NULL
        AND p.properties ->> 'kind' = ANY($6::text[])
        AND p.properties ->> 'status' = ANY($7::text[])`,
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

/** Databases by id and by key, each read once however many cards name it. */
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

/** The active steps of a multi-step envelope; `null` for a single-step envelope, an unknown kind and no envelope. */
function activeStepsOf(envelope: CardEnvelope): ProposalStep[] | null {
  if (!envelope || "unknownKind" in envelope || !envelope.operations) return null;
  return selectActiveSteps(envelope.operations);
}

/** The item ids whose database an envelope's kind or targets depend on. */
function targetItemIdsOf(envelope: CardEnvelope, steps: ProposalStep[] | null): string[] {
  if (!envelope || "unknownKind" in envelope) return [];
  const ids = envelope.entityKind === "database" ? [] : [envelope.target];
  for (const step of steps ?? []) if (step.itemId !== undefined) ids.push(step.itemId);
  return ids;
}

interface PageContext {
  databases: DatabaseLookup;
  /** The live items an envelope points at, by id. */
  targetItems: Map<string, ItemRow>;
  catalogs: ModuleCatalogs;
  locale: ManifestLocale;
}

function targetLabel(context: PageContext, kind: InboxCardKind): string {
  return resolveCatalogLabel(null, context.catalogs[context.locale], context.catalogs.en, `card.target.${kind}`);
}

/** The kind of a database as a target: the kind of the module that owns it, a page for any other. */
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

/**
 * The databases a card writes or edits, each once, the primary one first. A multi-step envelope names
 * one per active step; a single-step envelope names its own target, labelled by the card's `baseKind`.
 * A database without a `key` (a user database) has no `databaseKey` to name and is left out.
 */
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
  } else if (envelope.entityKind === "database") {
    add(await context.databases.id(envelope.target), baseKind);
  } else {
    const item = context.targetItems.get(envelope.target);
    add(item ? await context.databases.id(item.databaseId) : null, baseKind);
  }
  return [...targets].map(([databaseKey, label]) => ({ databaseKey, label }));
}

/** `databases.owner_module_id` of the envelope's target, the input `deriveInboxCardKind` documents; `null` when unknown. */
async function ownerModuleIdOf(context: PageContext, envelope: CardEnvelope): Promise<string | null> {
  if (!envelope || "unknownKind" in envelope) return null;
  if (envelope.entityKind === "database") return (await context.databases.id(envelope.target))?.ownerModuleId ?? null;
  if (envelope.entityKind === "pageContent") {
    const page = context.targetItems.get(envelope.target);
    return page ? ((await context.databases.id(page.databaseId))?.ownerModuleId ?? null) : null;
  }
  return null;
}

/** The Inbox item types of `inboxItems`, by Inbox item id: one edge read and one item read for the whole page. */
async function loadItemTypes(
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

/**
 * The reason of an `invalid` card with its sentence in `locale`. A stored reason is read through the schema of
 * issue #1482. A card without one (written before the reason existed) and a stored value that does not parse
 * both give the `unknown` reason: the card is still listed, with the generic sentence.
 */
async function buildInvalidReason(stored: unknown, locale: string): Promise<InboxCardInvalidReason> {
  const parsed = invalidReasonSchema.safeParse(stored);
  const reason = parsed.success ? parsed.data : { code: "unknown" as const, field: "", itemId: null, label: "" };
  return { ...reason, text: await renderInvalidReason(reason, locale) };
}

/** Builds the cards of one page of candidates. A card trashed after the candidates were read is left out. */
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
  const typeByInboxItemId = await loadItemTypes(
    client,
    inboxDatabaseId,
    candidates.flatMap((c) => sourceItems.get(c.inboxItemId ?? "") ?? []),
  );

  const envelopes = new Map<string, { envelope: CardEnvelope; steps: ProposalStep[] | null }>();
  for (const item of cardItems.values()) {
    const envelope = parseStoredProposalEnvelope(item.properties.proposal, item.id);
    envelopes.set(item.id, { envelope, steps: activeStepsOf(envelope) });
  }
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

  const cards: InboxCard[] = [];
  for (const candidate of candidates) {
    const item = cardItems.get(candidate.id);
    if (!item) continue;
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
      };
    } else if (candidate.kind === "transcript" && transcript) {
      resolvedSource = {
        kind: "transcript",
        id: transcript.id,
        name: stringOrNull(transcript.properties.name),
        completedAt: stringOrNull(transcript.properties.date),
      };
    }
    cards.push({
      cardId: item.id,
      source: "proposal",
      cardKind,
      baseKind,
      status: candidate.status,
      version: item.updatedAt,
      resolvedSource,
      context: item.properties.context ?? null,
      targets: await buildTargets(context, baseKind, envelope, steps),
      envelope,
      ...(candidate.status === "invalid"
        ? { invalidReason: await buildInvalidReason(item.properties.invalidReason, locale) }
        : {}),
    });
  }
  return cards;
}

interface ApprovalCards {
  cards: InboxCard[];
  /** Every pending approval of a tick or MCP run, also the ones past the first page that are not returned. */
  total: number;
}

/**
 * The pending approval requests whose source is a tick or MCP, oldest first, through the resolver of
 * `GET /api/approval-requests?status=pending&source=tick,mcp`, so both lists agree. A delegated run is
 * resolved to the source of its root run there. At most `limit` are returned; the rest are only counted.
 */
async function listApprovalCards(client: PoolClient, input: ListInboxCardsInput): Promise<ApprovalCards> {
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
  let total = page.rows.length;
  for (let nextCursor = page.nextCursor; nextCursor !== null;) {
    const rest = await listApprovalRequestsPage(client, {
      ownerUserId: input.ownerUserId,
      status: "pending",
      sourceKinds: APPROVAL_CARD_SOURCE_KINDS,
      search: null,
      order: "asc",
      cursor: parseApprovalRequestListCursor(nextCursor),
      limit: APPROVAL_COUNT_PAGE_SIZE,
    });
    total += rest.requests.length;
    nextCursor = rest.nextCursor;
  }
  const { cardKind, baseKind } = deriveApprovalCardKind();
  return {
    cards: page.rows.map((row) => ({
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
    })),
    total,
  };
}

/**
 * The Inbox stack: pending approvals of ticks and MCP clients, then the open Processing proposals cards
 * of kind `inbox` and `transcript`, in the order approval, proposed (`computing` and `computeFailed`
 * included), invalid, needsClarification, transcript. Inside a group the order is chronological by capture
 * time (an approval by `requested_at`, a transcript card by its transcript's date), then by id. At most
 * `INBOX_CARDS_LIMIT` cards are returned. `total` counts every open card of the set except those in
 * `computing` and `computeFailed`, which are listed but not counted. The caller owns the tenant
 * transaction, and `ownerUserId` decides whose approvals are read.
 */
export async function listInboxCards(client: PoolClient, input: ListInboxCardsInput): Promise<InboxCardList> {
  const approvals = await listApprovalCards(client, input);
  const proposalsDatabase = await getDatabaseByModuleId(client, PROCESSING_PROPOSALS_MODULE_ID);
  const inboxDatabase = await getDatabaseByModuleId(client, INBOX_MODULE_ID);
  if (!proposalsDatabase || !inboxDatabase) return { cards: approvals.cards, total: approvals.total };

  const transcriptsDatabase = await getDatabaseByModuleId(client, TRANSCRIPTS_MODULE_ID);
  const candidates = await listCandidates(
    client,
    proposalsDatabase.id,
    inboxDatabase.id,
    transcriptsDatabase?.id ?? null,
  );
  const counted = candidates.filter((candidate) => !UNCOUNTED_STATUSES.includes(candidate.status)).length;
  const page = candidates.slice(0, INBOX_CARDS_LIMIT - approvals.cards.length);
  const proposals = await buildProposalCards(client, page, inboxDatabase.id, input.locale);
  return { cards: [...approvals.cards, ...proposals], total: approvals.total + counted };
}
