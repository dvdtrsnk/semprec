---
status: accepted
date: 2026-11-12
area: [backend]
supersedes: []
superseded-by: null
---

# MCP argument values leave the server only in the owner's request detail

## Context

An approval request for an outgoing MCP action cannot be decided responsibly without its values, such as the recipient and the subject of an e-mail. The values are stored in `approval_requests.payload.args` of an `mcpInvoke` request, and every client-facing view reduces the payload to `safeSummary` (`approvalRequestsQueue.ts`): the tool registration, the server item and the argument names, never the values. Approval descriptions carry no argument values ([[2026-10-29-page-restore-joins-approval-gated-destructive-operations]]), and the notification body does not expose or interpolate them ([[2026-11-03-approval-notification-undo-copy-follows-application-capability]]). The stored arguments are model-produced and unbounded, and some of them are credentials.

Issue gh-2021 adds the first response that returns stored values. Without a recorded rule, a later change to the list, the count, the push payload or the search could not tell from anything but a code comment that values are meant to stay out, or what protects them where they are returned.

## Decision

The detail of one request, `GET /api/approval-requests/:id`, read by the owner of the request, is the only place where MCP argument values leave the server. The list, the count, the `PATCH` answer, the description, the notification body, the push payload and the search never carry them; a new view of an approval request is value-free unless a new ADR says otherwise. The detail adds `arguments` and `argumentsTruncated` for an `mcpInvoke` request only and leaves both out for a generic operation request. A request of another user, an unknown id and an id of another tenant answer the same 404 as before; reading is not widened.

The values are always produced by the pure `toApprovalRequestArgumentValues(payload.args)` (`backend/packages/data/src/mcp/approvalRequestArguments.ts`) and never returned from the stored payload directly. It applies, in this order:

1. Redaction. The value of every key that contains, case-insensitively and at any depth, one of `password`, `secret`, `token`, `apikey`, `api_key`, `authorization`, `cookie` or `credential` is replaced by the string `[redacted]`, whatever its type. The elements of an array have no key and are walked. A redacted value is not a truncation.
2. Depth. The arguments object is the first level; a container at the 33rd level is replaced by `null` and counts as a truncation, so the recursive walk is bounded whatever the byte size of the document. A value that is not JSON becomes `null`.
3. String length. A string longer than 2,000 UTF-16 code units (`String.prototype.length`) is cut to 2,000, without a lone high surrogate at the cut.
4. Byte cap. The JSON text of `arguments` takes at most 16 KiB (16,384 UTF-8 bytes). Redaction and shortening run first, so they free room. Whole entries are dropped before any container is cut: an object keeps, in its own order, first every entry that fits whole and then as much of each remaining container entry as fits in the room that is left, so a long body does not crowd out a short recipient or subject after it. An array keeps its leading elements and ends at the first element that does not fit whole, kept in part when it is a container that fits in part.

`argumentsTruncated` is `true` exactly when a string was shortened, a container was replaced for its depth, or anything was dropped or cut for the byte cap.

## Consequences

Redaction is by key name. A credential written into a value under a harmless key, such as a token pasted into a `body`, is returned to the owner; that is accepted because the reader is the one user who owns the request and is deciding on it, and because the alternative of returning no values leaves the decision blind. The key list is a closed product decision; widening it is a change to this record, not to a call site.

Any change that returns argument values to another reader or another view, or that changes the key list, the bounds or the drop order, needs a new ADR. The code comments in `approvalRequestArguments.ts` and `approvalRequestsHandler.ts` point here and do not restate the numbers independently. Tests pin each bound at its edge, the redaction at depth and in arrays, the drop order, the identical 404 and the absence of values from the list, the `PATCH` answer and the notification body. No schema column, stored payload change, client work or provider call is added.
