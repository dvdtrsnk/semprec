import type { PoolClient } from "pg";
import { requireManagedTransaction } from "../db/pool.js";
import { ApprovalRequiredForWrite, type ApprovalWriteReason } from "../errors.js";
import type { WriterIdentity } from "./writerKind.js";

export function requireApprovalForWrite(
  client: PoolClient,
  writer: WriterIdentity,
  reasons: readonly ApprovalWriteReason[],
): void {
  requireManagedTransaction(client);
  if (writer.writerKind === "agent" && writer.agentRunId !== undefined && writer.approvedRequestId === undefined) {
    throw new ApprovalRequiredForWrite(reasons);
  }
}
