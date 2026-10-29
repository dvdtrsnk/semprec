import { describe, expect, it } from "vitest";
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_KIND_POLICY,
  NOTIFICATION_KINDS,
  NOTIFICATION_SEVERITIES,
  policyForKind,
  type NotificationKind,
} from "../index.js";

describe("notification kind policy", () => {
  it("has a policy for every kind and none for an unknown kind", () => {
    expect(Object.keys(NOTIFICATION_KIND_POLICY).sort()).toEqual([...NOTIFICATION_KINDS].sort());
    for (const kind of NOTIFICATION_KINDS) {
      expect(policyForKind(kind)).toBe(NOTIFICATION_KIND_POLICY[kind]);
    }
    expect(Object.hasOwn(NOTIFICATION_KIND_POLICY, "not_a_kind")).toBe(false);
  });

  it("uses only known categories and severities, with severity only on problems", () => {
    for (const kind of NOTIFICATION_KINDS) {
      const policy = policyForKind(kind);
      expect(NOTIFICATION_CATEGORIES).toContain(policy.category);
      if (policy.category === "problems") {
        expect(NOTIFICATION_SEVERITIES).toContain(policy.severity);
      } else {
        expect("severity" in policy).toBe(false);
      }
    }
  });

  it("never pushes info kinds and pushes every other kind", () => {
    for (const kind of NOTIFICATION_KINDS) {
      const policy = policyForKind(kind);
      const isInfo = policy.category === "problems" && policy.severity === "info";
      expect(policy.push, kind).toBe(!isInfo);
    }
  });

  it("classifies the listed kinds", () => {
    const expected: Record<NotificationKind, string> = {
      approval_pending: "approvals",
      mail_sync_error: "problems/critical",
      mail_sync_stalled: "problems/critical",
      backup_restore_failed: "problems/critical",
      process_stale: "problems/critical",
      agent_run_error: "problems/warning",
      heartbeat_error: "problems/warning",
      automation_error: "problems/warning",
      agent_guidance_drift: "problems/warning",
      queue_backlog: "problems/warning",
      agent_guidance_drift_resolved: "problems/info",
    };
    for (const kind of NOTIFICATION_KINDS) {
      const policy = policyForKind(kind);
      const actual = policy.category === "problems" ? `problems/${policy.severity}` : policy.category;
      expect(actual, kind).toBe(expected[kind]);
    }
  });
});
