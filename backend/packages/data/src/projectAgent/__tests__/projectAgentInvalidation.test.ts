import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  createTenantZeroUser,
  createTestProjectItem,
  getTestPool,
  inTenantZero,
  resetDatabase,
} from "../../testSupport/testDb.js";
import { withTransaction } from "../../db/pool.js";
import { setInvalidationHook } from "../../realtimeHook.js";
import { projectAgentGuidanceStore } from "../../projectAgentGuidanceStore.js";
import { saveGuidanceSections } from "../../projectAgentGuidance/projectAgentGuidanceSections.js";
import { agentGuidanceDriftFindingsStore } from "../../guidanceDrift/agentGuidanceDriftFindingsStore.js";
import { upsertMcpToolRegistration } from "../../mcp/mcpToolRegistrationsStore.js";
import { setProjectMcpGrantForAgentPage } from "../../mcp/mcpAgentPageGrants.js";
import { setProjectMcpGrant } from "../../mcp/mcpGrantsAdminStore.js";
import { CORE_AGENT_RUN_ACTION_ID } from "../../scheduler/actions.js";
import {
  createHeartbeat,
  setHeartbeatEnabled,
  updateHeartbeatName,
  updateHeartbeatRule,
} from "../../scheduler/schedulerStore.js";
import { publishProjectAgentInvalidation } from "../projectAgentInvalidation.js";

let pool: Pool;
let projectItemId: string;
let userId: string;
/** The projects named by `projectAgent` invalidations, in publication order. */
let announced: string[];

const sections = { purpose: "Purpose", allowed: "Allowed", notAllowed: "", generalInstructions: "" };
const driftPayload = {
  kind: "behavior" as const,
  subject: { mcpTool: "search", databaseId: null },
  claim: "Claim",
  evidence: { runIds: ["one", "two", "three"], count: 3 },
  suggestedAllowedLine: "Create tasks from new GitHub issues.",
  suggestedNotAllowedLine: "Do not create tasks.",
  severity: "warning" as const,
};

function inTransaction<T>(work: Parameters<typeof withTransaction<T>>[1]): Promise<T> {
  return inTenantZero(() => withTransaction(pool, work));
}

function heartbeatInput(origin: "user" | "system") {
  return {
    projectItemId,
    name: "Weekly review",
    rule: { kind: "interval", minutes: 60 },
    actionId: CORE_AGENT_RUN_ACTION_ID,
    origin,
  } as const;
}

async function fingerprintedFinding(fingerprint: string, seenAt = new Date("2026-01-01T00:00:00Z")) {
  return inTransaction((tx) =>
    agentGuidanceDriftFindingsStore.upsertActive(tx, { projectItemId, fingerprint, payload: driftPayload, seenAt }),
  );
}

describe("projectAgent invalidations (issue #1866)", () => {
  beforeAll(() => {
    pool = getTestPool();
  });
  afterAll(async () => {
    await pool?.end();
  });
  beforeEach(async () => {
    await resetDatabase(pool);
    userId = (await createTenantZeroUser(pool)).id;
    projectItemId = await inTenantZero(() => createTestProjectItem(pool));
    announced = [];
    setInvalidationHook((event) => {
      if (event.scope === "projectAgent") announced.push(event.projectItemId);
    });
  });
  afterEach(() => {
    setInvalidationHook(() => {});
  });

  describe("guidance", () => {
    it("announces a saved guidance after the commit, naming the project and no user", async () => {
      await inTransaction(async (tx) => {
        await saveGuidanceSections(tx, { actorUserId: userId, projectItemId, sections, expectedUpdatedAt: null });
        expect(announced).toEqual([]);
      });

      expect(announced).toEqual([projectItemId]);
    });

    it("announces a guidance that was cleared by saving empty sections", async () => {
      const saved = await inTransaction((tx) =>
        saveGuidanceSections(tx, { actorUserId: userId, projectItemId, sections, expectedUpdatedAt: null }),
      );
      announced.length = 0;

      await inTransaction((tx) =>
        saveGuidanceSections(tx, {
          actorUserId: userId,
          projectItemId,
          sections: { purpose: "", allowed: "", notAllowed: "", generalInstructions: "" },
          expectedUpdatedAt: saved.updatedAt,
        }),
      );

      expect(announced).toEqual([projectItemId]);
    });

    it("announces nothing for a save that was refused for a stale version", async () => {
      await inTransaction((tx) =>
        saveGuidanceSections(tx, { actorUserId: userId, projectItemId, sections, expectedUpdatedAt: null }),
      );
      announced.length = 0;

      await expect(
        inTransaction((tx) =>
          saveGuidanceSections(tx, { actorUserId: userId, projectItemId, sections, expectedUpdatedAt: null }),
        ),
      ).rejects.toThrow("Guidance changed");

      expect(announced).toEqual([]);
    });

    it("announces nothing when the transaction that saved the guidance rolls back", async () => {
      await expect(
        inTransaction(async (tx) => {
          await projectAgentGuidanceStore.upsert(tx, { projectItemId, ownerUserId: userId, markdown: "# Purpose" });
          throw new Error("force rollback");
        }),
      ).rejects.toThrow("force rollback");

      expect(announced).toEqual([]);
    });
  });

  describe("tool grants", () => {
    it("announces a grant and a revocation of a project's tool, through the agent page wrapper", async () => {
      const registration = await upsertMcpToolRegistration(pool, {
        mcpServerItemId: randomUUID(),
        toolName: "search_web",
        toolSchema: {},
      });

      await inTransaction(async (tx) => {
        await setProjectMcpGrantForAgentPage(tx, {
          projectItemId,
          mcpToolRegistrationId: registration.id,
          granted: true,
        });
        expect(announced).toEqual([]);
      });
      await inTransaction((tx) =>
        setProjectMcpGrantForAgentPage(tx, { projectItemId, mcpToolRegistrationId: registration.id, granted: false }),
      );

      expect(announced).toEqual([projectItemId, projectItemId]);
    });

    it("announces a grant written on a bare pool right after the statement", async () => {
      const registration = await upsertMcpToolRegistration(pool, {
        mcpServerItemId: randomUUID(),
        toolName: "search_web",
        toolSchema: {},
      });

      await setProjectMcpGrant(pool, { projectItemId, mcpToolRegistrationId: registration.id, granted: true });

      expect(announced).toEqual([projectItemId]);
    });

    it("announces nothing for a tool that does not exist, or when the transaction rolls back", async () => {
      await expect(
        inTransaction((tx) =>
          setProjectMcpGrantForAgentPage(tx, {
            projectItemId,
            mcpToolRegistrationId: randomUUID(),
            granted: true,
          }),
        ),
      ).rejects.toThrow("No mcp_tool_registrations row");
      const registration = await upsertMcpToolRegistration(pool, {
        mcpServerItemId: randomUUID(),
        toolName: "search_web",
        toolSchema: {},
      });
      await expect(
        inTransaction(async (tx) => {
          await setProjectMcpGrantForAgentPage(tx, {
            projectItemId,
            mcpToolRegistrationId: registration.id,
            granted: true,
          });
          throw new Error("force rollback");
        }),
      ).rejects.toThrow("force rollback");

      expect(announced).toEqual([]);
    });
  });

  describe("user heartbeats", () => {
    it("announces the creation of a user heartbeat, and nothing for a system heartbeat", async () => {
      await inTransaction((tx) => createHeartbeat(tx, heartbeatInput("system")));
      expect(announced).toEqual([]);

      await inTransaction(async (tx) => {
        await createHeartbeat(tx, heartbeatInput("user"));
        expect(announced).toEqual([]);
      });

      expect(announced).toEqual([projectItemId]);
    });

    it("announces the change of the rule, the disabling and the enabling of a user heartbeat", async () => {
      const heartbeat = await inTransaction((tx) => createHeartbeat(tx, heartbeatInput("user")));
      announced.length = 0;

      await inTransaction((tx) => updateHeartbeatRule(tx, heartbeat.id, { kind: "interval", minutes: 120 }));
      expect(announced).toEqual([projectItemId]);
      await inTransaction((tx) => setHeartbeatEnabled(tx, heartbeat.id, false));
      expect(announced).toEqual([projectItemId, projectItemId]);
      await inTransaction((tx) => setHeartbeatEnabled(tx, heartbeat.id, true));
      expect(announced).toEqual([projectItemId, projectItemId, projectItemId]);
    });

    it("announces nothing for the rule, the disabling or the enabling of a system heartbeat", async () => {
      const heartbeat = await inTransaction((tx) => createHeartbeat(tx, heartbeatInput("system")));

      await inTransaction((tx) => updateHeartbeatRule(tx, heartbeat.id, { kind: "interval", minutes: 120 }));
      await inTransaction((tx) => setHeartbeatEnabled(tx, heartbeat.id, false));
      await inTransaction((tx) => setHeartbeatEnabled(tx, heartbeat.id, true));

      expect(announced).toEqual([]);
    });

    it("announces nothing for a change that is not one of the listed publication points", async () => {
      const heartbeat = await inTransaction((tx) => createHeartbeat(tx, heartbeatInput("user")));
      announced.length = 0;

      await inTransaction((tx) => updateHeartbeatName(tx, heartbeat.id, "Renamed"));

      expect(announced).toEqual([]);
    });

    it("announces nothing for an unknown heartbeat, or when the transaction rolls back", async () => {
      await expect(inTransaction((tx) => setHeartbeatEnabled(tx, randomUUID(), false))).rejects.toThrow("not found");
      await expect(
        inTransaction(async (tx) => {
          await createHeartbeat(tx, heartbeatInput("user"));
          throw new Error("force rollback");
        }),
      ).rejects.toThrow("force rollback");

      expect(announced).toEqual([]);
    });
  });

  describe("guidance drift findings", () => {
    it("announces a finding that is raised, and nothing for a repeated observation of it", async () => {
      const first = await fingerprintedFinding("a".repeat(64));
      expect(first.transitionedToActive).toBe(true);
      expect(announced).toEqual([projectItemId]);

      const repeated = await fingerprintedFinding("a".repeat(64), new Date("2026-01-02T00:00:00Z"));
      expect(repeated.transitionedToActive).toBe(false);
      expect(announced).toEqual([projectItemId]);
    });

    it("announces a finding that is resolved, and nothing when it was already resolved", async () => {
      const raised = await fingerprintedFinding("b".repeat(64));
      announced.length = 0;

      const resolved = await inTransaction((tx) =>
        agentGuidanceDriftFindingsStore.resolve(tx, raised.finding.id, new Date("2026-01-03T00:00:00Z")),
      );
      expect(resolved.transitionedToResolved).toBe(true);
      expect(announced).toEqual([projectItemId]);

      const again = await inTransaction((tx) =>
        agentGuidanceDriftFindingsStore.resolve(tx, raised.finding.id, new Date("2026-01-04T00:00:00Z")),
      );
      expect(again.transitionedToResolved).toBe(false);
      expect(announced).toEqual([projectItemId]);
    });

    it("announces a resolved finding that becomes active again", async () => {
      const raised = await fingerprintedFinding("c".repeat(64));
      await inTransaction((tx) => agentGuidanceDriftFindingsStore.resolve(tx, raised.finding.id, new Date()));
      announced.length = 0;

      const reactivated = await fingerprintedFinding("c".repeat(64), new Date("2026-01-05T00:00:00Z"));

      expect(reactivated.transitionedToActive).toBe(true);
      expect(announced).toEqual([projectItemId]);
    });

    it("announces the decision of a finding", async () => {
      const raised = await fingerprintedFinding("d".repeat(64));
      announced.length = 0;

      await inTransaction((tx) =>
        agentGuidanceDriftFindingsStore.decide(tx, raised.finding.id, {
          status: "dismissed",
          choice: "dismiss",
          userId,
          at: new Date("2026-01-06T00:00:00Z"),
        }),
      );

      expect(announced).toEqual([projectItemId]);
    });

    it("announces nothing when the transaction that raised or resolved a finding rolls back", async () => {
      await expect(
        inTransaction(async (tx) => {
          await agentGuidanceDriftFindingsStore.upsertActive(tx, {
            projectItemId,
            fingerprint: "e".repeat(64),
            payload: driftPayload,
            seenAt: new Date("2026-01-01T00:00:00Z"),
          });
          throw new Error("force rollback");
        }),
      ).rejects.toThrow("force rollback");
      const raised = await fingerprintedFinding("f".repeat(64));
      announced.length = 0;
      await expect(
        inTransaction(async (tx) => {
          await agentGuidanceDriftFindingsStore.resolve(tx, raised.finding.id, new Date());
          throw new Error("force rollback");
        }),
      ).rejects.toThrow("force rollback");

      expect(announced).toEqual([]);
    });
  });

  it("announces on a bare pool at once and on a transaction client only after the commit", async () => {
    publishProjectAgentInvalidation(pool, projectItemId);
    expect(announced).toEqual([projectItemId]);
    announced.length = 0;

    await inTransaction(async (tx) => {
      publishProjectAgentInvalidation(tx, projectItemId);
      publishProjectAgentInvalidation(tx, projectItemId);
      expect(announced).toEqual([]);
    });

    // Coalescing is not attempted: two calls in one transaction announce twice.
    expect(announced).toEqual([projectItemId, projectItemId]);
  });
});
