import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { seedSystem } from "../seed/seedSystem.js";
import { PROJECTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { withTransaction } from "../db/pool.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { insertItem } from "../chokePoint/itemsStore.js";
import {
  AGENT_GUIDANCE_DRIFT_ACTION_ID,
  guidanceDriftHeartbeatStore,
} from "../guidanceDrift/guidanceDriftHeartbeatStore.js";
import { agentGuidanceDriftFindingsStore } from "../guidanceDrift/agentGuidanceDriftFindingsStore.js";
import type { GuidanceDriftContradiction } from "@semprec/shared";

let pool: Pool;

async function createProjectItem(): Promise<string> {
  const item = await withTransaction(pool, async (client) => {
    const database = await getDatabaseByModuleId(client, PROJECTS_MODULE_ID);
    if (!database) throw new Error("Projects database was not seeded");
    return insertItem(client, { databaseId: database.id, properties: { name: `Project ${randomUUID()}` } });
  });
  return item.id;
}

const CONTRADICTION: GuidanceDriftContradiction = {
  claim: "The agent can delete files without approval.",
  guidanceExcerpt: "Agents may delete any file directly.",
  manifestFacts: ["capability.files.delete requires approval"],
  severity: "blocking",
};

describe("guidanceDrift stores (issue #85)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe("guidanceDriftHeartbeatStore", () => {
    it("creates exactly one canonical heartbeat for a project", async () => {
      const projectItemId = await createProjectItem();

      await withTransaction(pool, (client) => guidanceDriftHeartbeatStore.upsertDriftHeartbeat(client, projectItemId));

      const { rows } = await pool.query<{
        name: string;
        rule: { kind: string; at: string };
        action_id: string;
        action_config: Record<string, unknown>;
        enabled: boolean;
        next_fire_at: Date | null;
      }>(
        `SELECT name, rule, action_id, action_config, enabled, next_fire_at FROM project_heartbeats
         WHERE project_item_id = $1 AND action_id = $2`,
        [projectItemId, AGENT_GUIDANCE_DRIFT_ACTION_ID],
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        name: "Detect agent guidance drift",
        rule: { kind: "dailyTime", at: "04:30" },
        action_id: "core.agentGuidanceDrift",
        action_config: {},
        enabled: true,
      });
      expect(rows[0]?.next_fire_at).not.toBeNull();
    });

    it("stays a single row under repeated upserts, enforced by the partial unique index", async () => {
      const projectItemId = await createProjectItem();

      await withTransaction(pool, (client) => guidanceDriftHeartbeatStore.upsertDriftHeartbeat(client, projectItemId));
      await withTransaction(pool, (client) => guidanceDriftHeartbeatStore.upsertDriftHeartbeat(client, projectItemId));
      await withTransaction(pool, (client) => guidanceDriftHeartbeatStore.upsertDriftHeartbeat(client, projectItemId));

      const { rows } = await pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM project_heartbeats WHERE project_item_id = $1 AND action_id = $2`,
        [projectItemId, AGENT_GUIDANCE_DRIFT_ACTION_ID],
      );
      expect(rows[0]?.count).toBe(1);
    });

    it("re-enables a previously disabled heartbeat on the next upsert", async () => {
      const projectItemId = await createProjectItem();
      await withTransaction(pool, (client) => guidanceDriftHeartbeatStore.upsertDriftHeartbeat(client, projectItemId));
      await pool.query(`UPDATE project_heartbeats SET enabled = false WHERE project_item_id = $1 AND action_id = $2`, [
        projectItemId,
        AGENT_GUIDANCE_DRIFT_ACTION_ID,
      ]);

      await withTransaction(pool, (client) => guidanceDriftHeartbeatStore.upsertDriftHeartbeat(client, projectItemId));

      const { rows } = await pool.query<{ enabled: boolean }>(
        `SELECT enabled FROM project_heartbeats WHERE project_item_id = $1 AND action_id = $2`,
        [projectItemId, AGENT_GUIDANCE_DRIFT_ACTION_ID],
      );
      expect(rows[0]?.enabled).toBe(true);
    });
  });

  describe("agentGuidanceDriftFindingsStore", () => {
    it("transitions insert -> active, repeat observe -> no transition, resolve -> resolved, reappear -> active again", async () => {
      const projectItemId = await createProjectItem();
      const fingerprint = "f".repeat(64);
      const seenAt1 = new Date("2026-01-01T00:00:00.000Z");
      const seenAt2 = new Date("2026-01-02T00:00:00.000Z");
      const resolvedAt = new Date("2026-01-03T00:00:00.000Z");
      const seenAt3 = new Date("2026-01-04T00:00:00.000Z");

      const first = await withTransaction(pool, (client) =>
        agentGuidanceDriftFindingsStore.upsertActive(client, {
          projectItemId,
          fingerprint,
          payload: CONTRADICTION,
          seenAt: seenAt1,
        }),
      );
      expect(first.transitionedToActive).toBe(true);

      const repeat = await withTransaction(pool, (client) =>
        agentGuidanceDriftFindingsStore.upsertActive(client, {
          projectItemId,
          fingerprint,
          payload: CONTRADICTION,
          seenAt: seenAt2,
        }),
      );
      expect(repeat.transitionedToActive).toBe(false);
      expect(repeat.finding.id).toBe(first.finding.id);
      expect(repeat.finding.lastSeenAt).toBe(seenAt2.toISOString());

      const resolved = await withTransaction(pool, (client) =>
        agentGuidanceDriftFindingsStore.resolve(client, first.finding.id, resolvedAt),
      );
      expect(resolved.transitionedToResolved).toBe(true);

      const resolveAgain = await withTransaction(pool, (client) =>
        agentGuidanceDriftFindingsStore.resolve(client, first.finding.id, resolvedAt),
      );
      expect(resolveAgain.transitionedToResolved).toBe(false);

      const reactivated = await withTransaction(pool, (client) =>
        agentGuidanceDriftFindingsStore.upsertActive(client, {
          projectItemId,
          fingerprint,
          payload: CONTRADICTION,
          seenAt: seenAt3,
        }),
      );
      expect(reactivated.transitionedToActive).toBe(true);
      expect(reactivated.finding.id).toBe(first.finding.id);
      expect(reactivated.finding.resolvedAt).toBeNull();
    });

    it("listActive returns only active findings for the given project", async () => {
      const projectItemId = await createProjectItem();
      const otherProjectItemId = await createProjectItem();
      const seenAt = new Date("2026-01-01T00:00:00.000Z");

      const active = await withTransaction(pool, (client) =>
        agentGuidanceDriftFindingsStore.upsertActive(client, {
          projectItemId,
          fingerprint: "a".repeat(64),
          payload: CONTRADICTION,
          seenAt,
        }),
      );
      const toResolve = await withTransaction(pool, (client) =>
        agentGuidanceDriftFindingsStore.upsertActive(client, {
          projectItemId,
          fingerprint: "b".repeat(64),
          payload: CONTRADICTION,
          seenAt,
        }),
      );
      await withTransaction(pool, (client) =>
        agentGuidanceDriftFindingsStore.resolve(client, toResolve.finding.id, seenAt),
      );
      await withTransaction(pool, (client) =>
        agentGuidanceDriftFindingsStore.upsertActive(client, {
          projectItemId: otherProjectItemId,
          fingerprint: "c".repeat(64),
          payload: CONTRADICTION,
          seenAt,
        }),
      );

      const listed = await withTransaction(pool, (client) =>
        agentGuidanceDriftFindingsStore.listActive(client, projectItemId),
      );
      expect(listed.map((row) => row.id)).toEqual([active.finding.id]);
    });
  });
});

// `createGuidanceNotificationWriter`'s tests live in `packages/notifications` (issue #85's
// AC #46: the writer itself moved there too, on top of that package's `createNotification`),
// exercised against `@semprec/data`'s public API rather than these internal fixtures.
