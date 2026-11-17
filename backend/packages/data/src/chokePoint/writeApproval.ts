import type { PoolClient } from "pg";
import { requireManagedTransaction } from "../db/pool.js";
import { ApprovalRequiredForWrite, type ApprovalWriteReason } from "../errors.js";
import type { WriterIdentity } from "./writerKind.js";

/** Whether a flagged write by this writer waits for approval: an agent under a run, before its approved replay. */
export function writerNeedsWriteApproval(writer: WriterIdentity): boolean {
  return writer.writerKind === "agent" && writer.agentRunId !== undefined && writer.approvedRequestId === undefined;
}

export function requireApprovalForWrite(
  client: PoolClient,
  writer: WriterIdentity,
  reasons: readonly ApprovalWriteReason[],
): void {
  requireManagedTransaction(client);
  if (writerNeedsWriteApproval(writer)) {
    throw new ApprovalRequiredForWrite(reasons);
  }
}
