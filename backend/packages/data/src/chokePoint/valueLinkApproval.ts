// Owns which agent writes wait for approval because they would end a value link (issue #1758), and
// reads the links such a write ends for its approval request. A write by an agent under a run that
// changes the value an active link feeds raises `ApprovalRequiredForWrite` with a `breaksLinks`
// reason inside the write's own transaction, before the link is broken; a user write, a system
// write and an agent write without a run never defer, and neither does a write to a property
// without an active link. The approved replay carries `approvedRequestId`, passes, and the break
// in `valueLinkWrites.ts` records the agent as `broken_by`. Nothing here writes.
// Constrained by: docs/adr/2026-11-04-flagged-agent-writes-require-approval.md,
// docs/adr/2026-09-18-exactly-once-execution-of-approved-destructive-operations.md
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

/** The reason a deferred write carries: the item properties whose active links it would end. */
export interface BreaksLinksReason {
  kind: "breaksLinks";
  links: LinkTarget[];
}

/** One active link a write would end, with the sources it takes its value from. */
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

/** A write of `changedKeys` to an item: defers when any of them has an active link. */
export async function requireApprovalForChangedItemLinks(
  client: PoolClient,
  writer: WriterIdentity,
  input: { itemId: string; changedKeys: string[] },
): Promise<void> {
  if (!writerNeedsWriteApproval(writer)) return;
  const targets = input.changedKeys.map((propertyKey) => ({ itemId: input.itemId, propertyKey }));
  throwIfAny(client, writer, await lockOnValueLinksOfProperties(client, targets, "wait"));
}

/** A newly inserted relation edge: defers when a side of it has an active link. */
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
 * A single-valued relation replacement that removes an existing edge: defers when a side of a
 * removed or added edge has an active link. A replacement that removes no edge (the relation was
 * empty) is not a change of an inherited value and never defers.
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
 * Share-locks, without waiting, the active links of the given item properties for an approval
 * snapshot, and reads their sources. A link another transaction holds is a busy resource, the same
 * outcome the other approval reservations give.
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
