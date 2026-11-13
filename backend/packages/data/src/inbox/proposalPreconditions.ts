import { ConflictError, ValidationError } from "../errors.js";
import type { ItemRow } from "../types.js";

/**
 * The 400 `validation_failed` of a confirm or reject on a card whose status the action cannot start from:
 * `details.field` is `status` and `details.currentStatus` the stored status, `null` when the card holds none.
 */
export function incompatibleStatusError(message: string, status: unknown): ValidationError {
  return new ValidationError(message, { field: "status", currentStatus: typeof status === "string" ? status : null });
}

/**
 * The optimistic-concurrency check of a confirm or reject: with an `ifVersion` that is not the locked card's
 * `updatedAt`, throws the 409 `version_conflict` the generic item update raises, carrying the card as
 * `details.current`. Without an `ifVersion` it does nothing. The caller has locked the card row and has already
 * answered the cases the check must not apply to.
 */
export function assertProposalVersion(proposal: ItemRow, ifVersion: string | undefined): void {
  if (ifVersion !== undefined && ifVersion !== proposal.updatedAt) {
    throw new ConflictError("Proposal was modified since ifVersion was read", { current: proposal });
  }
}
