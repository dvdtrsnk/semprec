import { describe, expect, it } from "vitest";
import {
  ApprovalRequiredError,
  ConflictError,
  ForbiddenError,
  HeartbeatEventTriggeredError,
  NotFoundError,
  PropertyLockedError,
  SchemaLockedError,
  ValidationError,
  type ChokePointError,
  type ItemRow,
} from "@semprec/data";
import { statusForError, toErrorResponseBody, type ItemErrorCode } from "../errorContract.js";
import { toItemEnvelope } from "../itemEnvelope.js";

const SAMPLE_ITEM: ItemRow = {
  id: "11111111-1111-1111-1111-111111111111",
  databaseId: "22222222-2222-2222-2222-222222222222",
  properties: { title: "Hello" },
  computed: {},
  updatedAt: "2026-09-11T00:00:00.000Z",
  deletedAt: null,
};

/**
 * Issue #238's acceptance criterion: every one of the nine error codes produces its documented
 * status and `{ error: { code, details } }` body. Each entry here is a fixture error a future
 * route handler could plausibly throw, not a live call site — this adapter's job is the mapping,
 * not the business logic that decides when to throw.
 */
const FIXTURES: Array<{ code: ItemErrorCode; status: number; error: ChokePointError }> = [
  {
    code: "owner_violation",
    status: 403,
    error: new ForbiddenError("Owned by another actor", { field: "createdBy" }, "owner_violation"),
  },
  {
    code: "computed_readonly",
    status: 403,
    error: new ForbiddenError("computed is read-only", { field: "computed" }, "computed_readonly"),
  },
  { code: "schema_locked", status: 403, error: new SchemaLockedError("Schema is locked") },
  { code: "property_locked", status: 403, error: new PropertyLockedError("Property is locked") },
  {
    code: "version_conflict",
    status: 409,
    error: new ConflictError("Item was modified since ifVersion was read", { current: SAMPLE_ITEM }),
  },
  { code: "validation_failed", status: 400, error: new ValidationError("'title' is required", { field: "title" }) },
  { code: "not_found", status: 404, error: new NotFoundError("Item not found") },
  {
    code: "approval_required",
    status: 403,
    error: new ApprovalRequiredError("Requires approval", {
      approvalRequestId: "33333333-3333-3333-3333-333333333333",
      link: "/api/approval-requests/33333333-3333-3333-3333-333333333333",
    }),
  },
  {
    code: "heartbeat_event_triggered",
    status: 409,
    error: new HeartbeatEventTriggeredError("This heartbeat fires only from its triggering event"),
  },
];

describe("error contract (issue #238)", () => {
  for (const fixture of FIXTURES) {
    it(`maps ${fixture.code} to ${fixture.status} with the documented body`, () => {
      expect(statusForError(fixture.error)).toBe(fixture.status);
      const body = toErrorResponseBody(fixture.error);
      expect(body.error.code).toBe(fixture.code);
    });
  }

  it("projects version_conflict's details.current onto the full item envelope as details.currentItem", () => {
    const error = new ConflictError("conflict", { current: SAMPLE_ITEM });
    const body = toErrorResponseBody(error);
    expect(body.error.details).toEqual({ currentItem: toItemEnvelope(SAMPLE_ITEM) });
  });

  it("carries approval_required's link to the resulting approval request", () => {
    const error = new ApprovalRequiredError("Requires approval", {
      approvalRequestId: "33333333-3333-3333-3333-333333333333",
      link: "/api/approval-requests/33333333-3333-3333-3333-333333333333",
    });
    const body = toErrorResponseBody(error);
    expect(body.error.details).toEqual({
      approvalRequestId: "33333333-3333-3333-3333-333333333333",
      link: "/api/approval-requests/33333333-3333-3333-3333-333333333333",
    });
  });

  it("falls back to the error's own status for a code outside the closed nine (forward-compatible)", () => {
    const error = new ForbiddenError("Archived", { field: "databaseId" }, "database_archived");
    expect(statusForError(error)).toBe(error.status);
  });

  it("drops details that aren't a flat record of primitives, so internal state can't leak through a future call site", () => {
    const error = new SchemaLockedError("Schema is locked", { field: "databaseId", offendingRow: SAMPLE_ITEM });
    const body = toErrorResponseBody(error);
    expect(body.error.details).toBeUndefined();
  });

  it("passes through details that are a flat record of primitives", () => {
    const error = new PropertyLockedError("Property is locked", { field: "title", locked: true });
    const body = toErrorResponseBody(error);
    expect(body.error.details).toEqual({ field: "title", locked: true });
  });
});
