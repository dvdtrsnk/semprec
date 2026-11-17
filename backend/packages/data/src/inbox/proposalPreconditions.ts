import { ConflictError, ValidationError } from "../errors.js";
import type { ItemRow } from "../types.js";

/** A 400 for a card status the action cannot start from; `details.currentStatus` is the stored status or `null`. */
export function incompatibleStatusError(message: string, status: unknown): ValidationError {
  return new ValidationError(message, { field: "status", currentStatus: typeof status === "string" ? status : null });
}

/**
 * Confirm/reject optimistic concurrency: an `ifVersion` other than the locked card's `updatedAt` throws the 409
 * `version_conflict` with the card as `details.current`. No `ifVersion` means no check.
 */
export function assertProposalVersion(proposal: ItemRow, ifVersion: string | undefined): void {
  if (ifVersion !== undefined && ifVersion !== proposal.updatedAt) {
    throw new ConflictError("Proposal was modified since ifVersion was read", { current: proposal });
  }
}
