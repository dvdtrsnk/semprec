import { describe, expect, it } from "vitest";
import { AGENT_TASK_NAMES, CORE_TASK_AFFINITY, CORE_TASK_NAMES, TASK_AFFINITIES } from "../index.js";

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

  it("keeps the transitional heartbeatFire entry at affinity 'api'", () => {
    expect(CORE_TASK_AFFINITY[CORE_TASK_NAMES.HEARTBEAT_FIRE]).toBe("api");
  });
});

describe("AGENT_TASK_NAMES", () => {
  it("exports exactly heartbeatFireAgent, agentRun, and delegatedAgentRun", () => {
    expect(Object.values(AGENT_TASK_NAMES).sort()).toEqual(["agentRun", "delegatedAgentRun", "heartbeatFireAgent"]);
  });
});
