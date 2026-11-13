import { describe, expect, it } from "vitest";
import { AGENT_TASK_NAMES, CORE_TASK_AFFINITY, CORE_TASK_NAMES, TASK_AFFINITIES, TASK_TENANCY } from "../index.js";

describe("CORE_TASK_AFFINITY", () => {
  it("carries an affinity for every CORE_TASK_NAMES entry, and only valid affinities", () => {
    const coreNames = Object.values(CORE_TASK_NAMES);
    expect(Object.keys(CORE_TASK_AFFINITY).sort()).toEqual([...coreNames].sort());
    for (const affinity of Object.values(CORE_TASK_AFFINITY)) {
      expect(TASK_AFFINITIES).toContain(affinity);
    }
  });

  it("includes the three inherited API-set names with affinity 'api'", () => {
    expect(CORE_TASK_AFFINITY[CORE_TASK_NAMES.APPROVAL_REQUEST_EXECUTE]).toBe("api");
    expect(CORE_TASK_AFFINITY[CORE_TASK_NAMES.NOTIFICATION_FANOUT]).toBe("api");
    expect(CORE_TASK_AFFINITY[CORE_TASK_NAMES.TRASH_PURGE]).toBe("api");
  });

  it("declares heartbeatFireCore in the exhaustive API set", () => {
    expect(CORE_TASK_NAMES.HEARTBEAT_FIRE_CORE).toBe("heartbeatFireCore");
    expect(CORE_TASK_AFFINITY[CORE_TASK_NAMES.HEARTBEAT_FIRE_CORE]).toBe("api");
  });

  it("declares docHistorySquash in the exhaustive API set", () => {
    expect(CORE_TASK_NAMES.DOC_HISTORY_SQUASH).toBe("docHistorySquash");
    expect(CORE_TASK_AFFINITY[CORE_TASK_NAMES.DOC_HISTORY_SQUASH]).toBe("api");
  });

  it("declares mcpRunCredentialExpirySweep in the exhaustive API set", () => {
    expect(CORE_TASK_NAMES.MCP_RUN_CREDENTIAL_EXPIRY_SWEEP).toBe("mcpRunCredentialExpirySweep");
    expect(CORE_TASK_AFFINITY[CORE_TASK_NAMES.MCP_RUN_CREDENTIAL_EXPIRY_SWEEP]).toBe("api");
  });

  it("declares agentRunEventsRetention in the exhaustive API set", () => {
    expect(CORE_TASK_NAMES.AGENT_RUN_EVENTS_RETENTION).toBe("agentRunEventsRetention");
    expect(CORE_TASK_AFFINITY[CORE_TASK_NAMES.AGENT_RUN_EVENTS_RETENTION]).toBe("api");
  });

  it("declares sempProblemsPrune in the exhaustive API set", () => {
    expect(CORE_TASK_NAMES.SEMP_PROBLEMS_PRUNE).toBe("sempProblemsPrune");
    expect(CORE_TASK_AFFINITY[CORE_TASK_NAMES.SEMP_PROBLEMS_PRUNE]).toBe("api");
    expect(TASK_TENANCY[CORE_TASK_NAMES.SEMP_PROBLEMS_PRUNE]).toBe("system");
  });

  it("declares the tenant-scoped Semp thread title task in the API set", () => {
    expect(CORE_TASK_NAMES.SEMP_THREAD_TITLE).toBe("sempThreadTitle");
    expect(CORE_TASK_AFFINITY[CORE_TASK_NAMES.SEMP_THREAD_TITLE]).toBe("api");
    expect(TASK_TENANCY[CORE_TASK_NAMES.SEMP_THREAD_TITLE]).toBe("tenant");
  });

  it("declares queueFailedJobsPrune in the exhaustive API set", () => {
    expect(CORE_TASK_NAMES.QUEUE_FAILED_JOBS_PRUNE).toBe("queueFailedJobsPrune");
    expect(CORE_TASK_AFFINITY[CORE_TASK_NAMES.QUEUE_FAILED_JOBS_PRUNE]).toBe("api");
  });

  it("declares the tenant-scoped derivedValuesInvalidate task in the API set (issue #1710)", () => {
    expect(CORE_TASK_NAMES.DERIVED_VALUES_INVALIDATE).toBe("derivedValuesInvalidate");
    expect(CORE_TASK_AFFINITY[CORE_TASK_NAMES.DERIVED_VALUES_INVALIDATE]).toBe("api");
    expect(TASK_TENANCY[CORE_TASK_NAMES.DERIVED_VALUES_INVALIDATE]).toBe("tenant");
  });

  it("declares the tenant-scoped pushDismiss task in the API set (issue #1826)", () => {
    expect(CORE_TASK_NAMES.PUSH_DISMISS).toBe("pushDismiss");
    expect(CORE_TASK_AFFINITY[CORE_TASK_NAMES.PUSH_DISMISS]).toBe("api");
    expect(TASK_TENANCY[CORE_TASK_NAMES.PUSH_DISMISS]).toBe("tenant");
  });

  it("declares the tenant-scoped pushBadgeRefresh task in the API set (issue #1891)", () => {
    expect(CORE_TASK_NAMES.PUSH_BADGE_REFRESH).toBe("pushBadgeRefresh");
    expect(CORE_TASK_AFFINITY[CORE_TASK_NAMES.PUSH_BADGE_REFRESH]).toBe("api");
    expect(TASK_TENANCY[CORE_TASK_NAMES.PUSH_BADGE_REFRESH]).toBe("tenant");
  });

  it("declares the system-scoped pageOrphanSweep task in the API set (issue #1749)", () => {
    expect(CORE_TASK_NAMES.PAGE_ORPHAN_SWEEP).toBe("pageOrphanSweep");
    expect(CORE_TASK_AFFINITY[CORE_TASK_NAMES.PAGE_ORPHAN_SWEEP]).toBe("api");
    expect(TASK_TENANCY[CORE_TASK_NAMES.PAGE_ORPHAN_SWEEP]).toBe("system");
  });

  it("declares the tenant-scoped taskHostEventEnded task in the API set (issue #1782)", () => {
    expect(CORE_TASK_NAMES.TASK_HOST_EVENT_ENDED).toBe("taskHostEventEnded");
    expect(CORE_TASK_AFFINITY[CORE_TASK_NAMES.TASK_HOST_EVENT_ENDED]).toBe("api");
    expect(TASK_TENANCY[CORE_TASK_NAMES.TASK_HOST_EVENT_ENDED]).toBe("tenant");
  });

  it("declares the tenant-scoped aiBudgetReset task in the API set (issue gh-2024)", () => {
    expect(CORE_TASK_NAMES.AI_BUDGET_RESET).toBe("aiBudgetReset");
    expect(CORE_TASK_AFFINITY[CORE_TASK_NAMES.AI_BUDGET_RESET]).toBe("api");
    expect(TASK_TENANCY[CORE_TASK_NAMES.AI_BUDGET_RESET]).toBe("tenant");
  });

  it("no longer declares the retired credentialReencryptSweep (issue #1069)", () => {
    expect(Object.values(CORE_TASK_NAMES)).not.toContain("credentialReencryptSweep");
    expect(Object.keys(CORE_TASK_AFFINITY)).not.toContain("credentialReencryptSweep");
    expect(Object.keys(TASK_TENANCY)).not.toContain("credentialReencryptSweep");
  });
});

describe("AGENT_TASK_NAMES", () => {
  it("exports the agent task catalog including tenant-scoped Semp messages", () => {
    expect(Object.values(AGENT_TASK_NAMES).sort()).toEqual([
      "agentRun",
      "delegatedAgentRun",
      "heartbeatFireAgent",
      "sempMessage",
    ]);
    expect(TASK_TENANCY[AGENT_TASK_NAMES.SEMP_MESSAGE]).toBe("tenant");
  });
});
