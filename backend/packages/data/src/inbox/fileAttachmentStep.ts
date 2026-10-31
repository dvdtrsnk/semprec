import { z } from "zod";
import { ValidationError } from "../errors.js";

// The `fileFromAttachment` step kind of a multi-step proposal envelope (issue #1703): on confirm it moves
// one attachment of the source Inbox item into Files. The shape is recorded in
// docs/adr/2026-10-29-file-from-attachment-proposal-step.md. Execution is in proposalSteps.ts.

/**
 * The only properties such a step may write. `file` and `type` are never part of the envelope: confirm
 * sets them from the attachment's blob, so a stored envelope cannot name a blob of its own.
 */
const fileFromAttachmentPropertiesSchema = z
  .object({
    attachmentId: z.string().uuid(),
    name: z.string().refine((value) => value.trim().length > 0, "must not be empty"),
    date: z.string().min(1).optional(),
  })
  .strict();

/** The validated properties of a `fileFromAttachment` step. */
export interface FileFromAttachmentProperties {
  attachmentId: string;
  name: string;
  date?: string;
}

/**
 * Checks a `fileFromAttachment` step's properties: exactly `attachmentId`, a non-empty `name` and an
 * optional `date`. Any other key, `file` and `type` included, is a `ValidationError` naming the step
 * `ref` and the offending `field`.
 */
export function parseFileFromAttachmentProperties(
  ref: string,
  properties: Record<string, unknown>,
): FileFromAttachmentProperties {
  const parsed = fileFromAttachmentPropertiesSchema.safeParse(properties);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  if (issue?.code === "unrecognized_keys") {
    const field = issue.keys[0] ?? "properties";
    throw new ValidationError(`Proposal step '${ref}': a fileFromAttachment step cannot write property '${field}'`, {
      ref,
      field,
    });
  }
  const field = String(issue?.path[0] ?? "properties");
  throw new ValidationError(`Proposal step '${ref}': property '${field}' is invalid (${issue?.message ?? "invalid"})`, {
    ref,
    field,
  });
}
