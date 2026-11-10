import { describe, expect, it } from "vitest";
import {
  ApprovalRequiredError,
  ConflictError,
  ForbiddenError,
  HeartbeatDisabledError,
  HeartbeatEventTriggeredError,
  HeartbeatRunningError,
  NotFoundError,
  PropertyLockedError,
  SchemaLockedError,
  ValidationError,
  type ActiveHeartbeatRunSummary,
  type ChokePointError,
  type ItemRow,
} from "@semprec/data";
import {
  ITEM_ERROR_CODES,
  ITEM_ERROR_STATUS_BY_CODE,
  publicErrorDetails,
  statusForError,
  toErrorResponseBody,
  toPublicErrorBody,
  type ItemErrorCode,
} from "../errorContract.js";
import { toItemEnvelope } from "../itemEnvelope.js";

const SAMPLE_ITEM: ItemRow = {
  id: "11111111-1111-1111-1111-111111111111",
  databaseId: "22222222-2222-2222-2222-222222222222",
  properties: { title: "Hello" },
  computed: {},
  createdAt: "2026-09-11T00:00:00.000Z",
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
  {
    code: "heartbeat_disabled",
    status: 409,
    error: new HeartbeatDisabledError("this heartbeat is disabled; enable it before triggering it"),
  },
  {
    code: "heartbeat_running",
    status: 409,
    error: new HeartbeatRunningError("this heartbeat is already running or queued", { activeRun: null }),
  },
];

const ACTIVE_RUN: ActiveHeartbeatRunSummary = {
  id: "44444444-4444-4444-4444-444444444444",
  status: "running",
  triggeredBy: "heartbeat",
  startedAt: "2026-10-29T08:00:00.000Z",
  threadId: "55555555-5555-5555-5555-555555555555",
};

describe("error contract (issue #238)", () => {
  it.each(["mail_auth_failed", "mail_app_password_required", "mail_server_unreachable", "mail_tls_failed"] as const)(
    "maps %s to HTTP 400",
    (code) => {
      expect(ITEM_ERROR_CODES).toContain(code);
      expect(ITEM_ERROR_STATUS_BY_CODE[code]).toBe(400);
    },
  );
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

  it("falls through to the generic details branch when current is missing computed", () => {
    const { computed: _computed, ...currentMissingComputed } = SAMPLE_ITEM;
    const error = new ConflictError("conflict", { current: currentMissingComputed });
    const body = toErrorResponseBody(error);
    expect(body.error.details).toBeUndefined();
  });

  it("falls through to the generic details branch when current is missing deletedAt", () => {
    const { deletedAt: _deletedAt, ...currentMissingDeletedAt } = SAMPLE_ITEM;
    const error = new ConflictError("conflict", { current: currentMissingDeletedAt });
    const body = toErrorResponseBody(error);
    expect(body.error.details).toBeUndefined();
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

  it("projects heartbeat_running's details.activeRun to the id, status, trigger, start and thread only", () => {
    // The run carries more than the contract shows; the projection must not forward it.
    const run = { ...ACTIVE_RUN, task: "a task text the client must not see", result: "a result" };
    const error = new HeartbeatRunningError("already running", { activeRun: run });
    const body = toErrorResponseBody(error);
    expect(body.error).toEqual({ code: "heartbeat_running", details: { activeRun: ACTIVE_RUN } });
  });

  it("keeps heartbeat_running's activeRun null while only a fire job is waiting", () => {
    const body = toErrorResponseBody(new HeartbeatRunningError("already queued", { activeRun: null }));
    expect(body.error).toEqual({ code: "heartbeat_running", details: { activeRun: null } });
  });

  it("falls through to the generic branch when heartbeat_running's activeRun is not a run summary", () => {
    const error = new ForbiddenError("already running", { activeRun: { id: 1 } }, "heartbeat_running");
    expect(toErrorResponseBody(error).error.details).toBeUndefined();
  });
});

describe("bespoke handler error body (issue #638)", () => {
  it("keeps the message as error and the code, and passes flat details through", () => {
    const error = new ValidationError("Bad field", { field: "x" });
    expect(toPublicErrorBody(error)).toEqual({ error: "Bad field", code: error.code, details: { field: "x" } });
  });

  it("drops nested-object details but keeps error and code", () => {
    const error = new ConflictError("Version conflict", { current: { id: SAMPLE_ITEM.id } });
    const body = toPublicErrorBody(error);
    expect(body).toEqual({ error: "Version conflict", code: error.code, details: undefined });
  });

  it("drops array details", () => {
    const body = toPublicErrorBody(new ValidationError("Bad", ["a", "b"]));
    expect(body.details).toBeUndefined();
    expect(body.error).toBe("Bad");
  });

  it("drops string details", () => {
    const body = toPublicErrorBody(new ValidationError("Bad", "/var/lib/secret"));
    expect(body.details).toBeUndefined();
    expect(body.error).toBe("Bad");
  });

  it("exports publicErrorDetails with the same flat-primitives filter toErrorResponseBody applies", () => {
    const nested = { field: "databaseId", offendingRow: SAMPLE_ITEM };
    expect(publicErrorDetails(nested)).toBeUndefined();
    expect(toErrorResponseBody(new SchemaLockedError("Schema is locked", nested)).error.details).toBeUndefined();
    expect(publicErrorDetails({ field: "title", locked: true })).toEqual({ field: "title", locked: true });
  });
});
