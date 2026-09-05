import { describe, expect, it } from "vitest";
import { DOMAIN_ERROR_CODES } from "../domainErrors.js";

describe("the shared domain-error union", () => {
  it("carries #37's closed enum plus #83's database_archived, with no duplicates", () => {
    expect(new Set(DOMAIN_ERROR_CODES).size).toBe(DOMAIN_ERROR_CODES.length);
    for (const code of [
      "owner_violation",
      "computed_readonly",
      "schema_locked",
      "property_locked",
      "version_conflict",
      "validation_failed",
      "not_found",
      "approval_required",
      "heartbeat_event_triggered",
      "database_archived",
    ]) {
      expect(DOMAIN_ERROR_CODES).toContain(code);
    }
  });
});
