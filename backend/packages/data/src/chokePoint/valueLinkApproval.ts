// Which agent writes wait for approval because they would end a value link, and the links such a
// write ends. An agent write under a run that changes a value an active link feeds raises
// `ApprovalRequiredForWrite` (`breaksLinks`) inside the write's transaction, before the link is
// broken; user, system and run-less agent writes never defer. The approved replay carries
// `approvedRequestId` and passes. Nothing here writes.
import { DatabaseError, type PoolClient } from "pg";
import { markManagedTransactionRollbackOnly } from "../db/pool.js";
import { ApprovalResourceBusyError } from "../errors.js";
import type { RelationDefinitionRow } from "../types.js";
import {
  listValueLinkSourcesByLinkIds,
  lockOnValueLinksOfProperties,
  type ValueLinkRow,
  type ValueLinkSourceRow,
} from "./valueLinksStore.js";
import { relationEdgeLinkTargets } from "./valueLinkWrites.js";
import { requireApprovalForWrite, writerNeedsWriteApproval } from "./writeApproval.js";
import type { WriterIdentity } from "./writerKind.js";

export interface LinkTarget {
  itemId: string;
  propertyKey: string;
}

export interface BreaksLinksReason {
  kind: "breaksLinks";
  links: LinkTarget[];
}

export interface BreakingLink {
  id: string;
  itemId: string;
  propertyKey: string;
  ruleKey: string;
  sources: ValueLinkSourceRow[];
}

/** The value links a destructive-operation check would end; hashed into the approval snapshot. */
export interface BreakingValueLinks {
  links: BreakingLink[];
}

interface EdgeEnds {
  itemA: string;
  itemB: string;
}

function distinct(targets: LinkTarget[]): LinkTarget[] {
  const seen = new Map<string, LinkTarget>();
  for (const target of targets) seen.set(JSON.stringify([target.itemId, target.propertyKey]), target);
  return [...seen.values()];
}

async function edgeTargets(client: PoolClient, reldef: RelationDefinitionRow, edges: EdgeEnds[]) {
  const targets: LinkTarget[] = [];
  for (const edge of edges) {
    for (const side of await relationEdgeLinkTargets(client, { reldef, ...edge })) {
      targets.push({ itemId: side.itemId, propertyKey: side.propertyKey });
    }
  }
  return distinct(targets);
}

function throwIfAny(client: PoolClient, writer: WriterIdentity, links: ValueLinkRow[]): void {
  if (links.length === 0) return;
  const reason: BreaksLinksReason = {
    kind: "breaksLinks",
    links: links.map((link) => ({ itemId: link.itemId, propertyKey: link.propertyKey })),
  };
  requireApprovalForWrite(client, writer, [reason]);
}

export async function requireApprovalForChangedItemLinks(
  client: PoolClient,
  writer: WriterIdentity,
  input: { itemId: string; changedKeys: string[] },
): Promise<void> {
  if (!writerNeedsWriteApproval(writer)) return;
  const targets = input.changedKeys.map((propertyKey) => ({ itemId: input.itemId, propertyKey }));
  throwIfAny(client, writer, await lockOnValueLinksOfProperties(client, targets, "wait"));
}

export async function requireApprovalForInsertedEdgeLinks(
  client: PoolClient,
  writer: WriterIdentity,
  input: { reldef: RelationDefinitionRow } & EdgeEnds,
): Promise<void> {
  if (!writerNeedsWriteApproval(writer)) return;
  const targets = await edgeTargets(client, input.reldef, [input]);
  throwIfAny(client, writer, await lockOnValueLinksOfProperties(client, targets, "wait"));
}

/**
 * A single-valued replacement that removes an existing edge: defers when a side of a removed or added
 * edge has an active link. Replacing an empty relation never defers.
 */
export async function requireApprovalForReplacedEdgeLinks(
  client: PoolClient,
  writer: WriterIdentity,
  input: { reldef: RelationDefinitionRow; removed: EdgeEnds[]; added: EdgeEnds | null },
): Promise<void> {
  if (!writerNeedsWriteApproval(writer) || input.removed.length === 0) return;
  const targets = await edgeTargets(client, input.reldef, [...input.removed, ...(input.added ? [input.added] : [])]);
  throwIfAny(client, writer, await lockOnValueLinksOfProperties(client, targets, "wait"));
}

/** An unlink of the caller-locked, still active link of one item property. */
export function requireApprovalForUnlink(client: PoolClient, writer: WriterIdentity, link: LinkTarget): void {
  if (!writerNeedsWriteApproval(writer)) return;
  const reason: BreaksLinksReason = {
    kind: "breaksLinks",
    links: [{ itemId: link.itemId, propertyKey: link.propertyKey }],
  };
  requireApprovalForWrite(client, writer, [reason]);
}

async function withSources(client: PoolClient, links: ValueLinkRow[]): Promise<BreakingLink[]> {
  const sources = await listValueLinkSourcesByLinkIds(
    client,
    links.map((link) => link.id),
  );
  return links.map((link) => ({
    id: link.id,
    itemId: link.itemId,
    propertyKey: link.propertyKey,
    ruleKey: link.ruleKey,
    sources: sources.filter((source) => source.linkId === link.id),
  }));
}

/**
 * Share-locks, without waiting, the active links of the given properties for an approval snapshot and
 * reads their sources. A link held elsewhere is a busy resource, like the other approval reservations.
 */
export async function reserveBreakingLinks(client: PoolClient, targets: LinkTarget[]): Promise<BreakingValueLinks> {
  try {
    return {
      links: await withSources(client, await lockOnValueLinksOfProperties(client, distinct(targets), "nowait")),
    };
  } catch (error) {
    if (error instanceof DatabaseError && error.code === "55P03") {
      const busy = new ApprovalResourceBusyError();
      markManagedTransactionRollbackOnly(client, busy);
      throw busy;
    }
    throw error;
  }
}

/** Reserves, as `reserveBreakingLinks` does, the active links on the sides of the given relation edges. */
export async function reserveEdgeLinks(
  client: PoolClient,
  reldef: RelationDefinitionRow,
  edges: EdgeEnds[],
): Promise<BreakingValueLinks> {
  return reserveBreakingLinks(client, await edgeTargets(client, reldef, edges));
}
