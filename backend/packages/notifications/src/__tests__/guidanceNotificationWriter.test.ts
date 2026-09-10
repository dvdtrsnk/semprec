import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  PROJECTS_MODULE_ID,
  agentGuidanceDriftFindingsStore,
  createItemWithClient,
  createUser,
  getDatabaseByModuleId,
  listUnreadNotificationsForUser,
  projectAgentGuidanceStore,
  seedSystem,
  withTransaction,
} from "@semprec/data";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";
import type { GuidanceDriftContradiction } from "@semprec/shared";
import { createGuidanceNotificationWriter } from "../guidanceNotificationWriter.js";

let pool: Pool;

async function createProjectItem(): Promise<string> {
  const item = await withTransaction(pool, async (client) => {
    const database = await getDatabaseByModuleId(client, PROJECTS_MODULE_ID);
    if (!database) throw new Error("Projects database was not seeded");
    return createItemWithClient(client, { databaseId: database.id, properties: { name: `Project ${randomUUID()}` } });
  });
  return item.id;
}

async function createTestUser(): Promise<string> {
  const user = await createUser(pool, { email: `${randomUUID()}@example.com`, passwordHash: "hash" });
  return user.id;
}

const CONTRADICTION: GuidanceDriftContradiction = {
  claim: "The agent can delete files without approval.",
  guidanceExcerpt: "Agents may delete any file directly.",
  manifestFacts: ["capability.files.delete requires approval"],
  severity: "blocking",
};

describe("createGuidanceNotificationWriter (issue #85)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("writes a notification carrying the finding payload, deduped by transitionInstance", async () => {
    const projectItemId = await createProjectItem();
    const ownerUserId = await createTestUser();
    await withTransaction(pool, (client) =>
      projectAgentGuidanceStore.upsert(client, { projectItemId, ownerUserId, markdown: "# Guidance" }),
    );
    const fingerprint = "d".repeat(64);
    const findingId = randomUUID();
    const transitionInstance = `${fingerprint}:2026-01-01T00:00:00.000Z`;
    const writer = createGuidanceNotificationWriter();

    const payload = {
      projectItemId,
      fingerprint,
      claim: CONTRADICTION.claim,
      guidanceExcerpt: CONTRADICTION.guidanceExcerpt,
      manifestFacts: CONTRADICTION.manifestFacts,
      severity: CONTRADICTION.severity,
    };

    await withTransaction(pool, (client) =>
      writer.create(client, {
        userId: ownerUserId,
        kind: "agent_guidance_drift",
        linkHref: `/projects/${projectItemId}/agent-guidance`,
        sourceTable: "agent_guidance_drift_findings",
        sourceId: findingId,
        transitionInstance,
        payload,
      }),
    );
    // A replay of the same transition (same source row + kind + transitionInstance) must not duplicate.
    await withTransaction(pool, (client) =>
      writer.create(client, {
        userId: ownerUserId,
        kind: "agent_guidance_drift",
        linkHref: `/projects/${projectItemId}/agent-guidance`,
        sourceTable: "agent_guidance_drift_findings",
        sourceId: findingId,
        transitionInstance,
        payload,
      }),
    );

    const unread = await listUnreadNotificationsForUser(pool, ownerUserId);
    expect(unread).toHaveLength(1);
    expect(unread[0]).toMatchObject({
      kind: "agent_guidance_drift",
      linkHref: `/projects/${projectItemId}/agent-guidance`,
      payload,
    });
  });

  it("notifies again when a finding resolves and later reappears with the same fingerprint", async () => {
    const projectItemId = await createProjectItem();
    const ownerUserId = await createTestUser();
    await withTransaction(pool, (client) =>
      projectAgentGuidanceStore.upsert(client, { projectItemId, ownerUserId, markdown: "# Guidance" }),
    );
    const fingerprint = "e".repeat(64);
    const writer = createGuidanceNotificationWriter();
    const linkHref = `/projects/${projectItemId}/agent-guidance`;
    const payload = {
      projectItemId,
      fingerprint,
      claim: CONTRADICTION.claim,
      guidanceExcerpt: CONTRADICTION.guidanceExcerpt,
      manifestFacts: CONTRADICTION.manifestFacts,
      severity: CONTRADICTION.severity,
    };

    const firstSeenAt = new Date("2026-01-01T00:00:00.000Z");
    const activated = await withTransaction(pool, (client) =>
      agentGuidanceDriftFindingsStore.upsertActive(client, {
        projectItemId,
        fingerprint,
        payload: CONTRADICTION,
        seenAt: firstSeenAt,
      }),
    );
    await withTransaction(pool, (client) =>
      writer.create(client, {
        userId: ownerUserId,
        kind: "agent_guidance_drift",
        linkHref,
        sourceTable: "agent_guidance_drift_findings",
        sourceId: activated.finding.id,
        transitionInstance: `${fingerprint}:${firstSeenAt.toISOString()}`,
        payload,
      }),
    );

    const resolvedAt = new Date("2026-01-02T00:00:00.000Z");
    await withTransaction(pool, (client) =>
      agentGuidanceDriftFindingsStore.resolve(client, activated.finding.id, resolvedAt),
    );
    await withTransaction(pool, (client) =>
      writer.create(client, {
        userId: ownerUserId,
        kind: "agent_guidance_drift_resolved",
        linkHref,
        sourceTable: "agent_guidance_drift_findings",
        sourceId: activated.finding.id,
        transitionInstance: `${fingerprint}:${resolvedAt.toISOString()}`,
        payload: { projectItemId, fingerprint },
      }),
    );

    // Same finding.id and fingerprint reactivate — this must be a distinct notification, not a
    // dedup collision with the first activation above.
    const reappearedAt = new Date("2026-01-03T00:00:00.000Z");
    const reactivated = await withTransaction(pool, (client) =>
      agentGuidanceDriftFindingsStore.upsertActive(client, {
        projectItemId,
        fingerprint,
        payload: CONTRADICTION,
        seenAt: reappearedAt,
      }),
    );
    expect(reactivated.finding.id).toBe(activated.finding.id);
    await withTransaction(pool, (client) =>
      writer.create(client, {
        userId: ownerUserId,
        kind: "agent_guidance_drift",
        linkHref,
        sourceTable: "agent_guidance_drift_findings",
        sourceId: reactivated.finding.id,
        transitionInstance: `${fingerprint}:${reappearedAt.toISOString()}`,
        payload,
      }),
    );

    const unread = await listUnreadNotificationsForUser(pool, ownerUserId);
    const activeNotifications = unread.filter((n) => n.kind === "agent_guidance_drift");
    expect(activeNotifications).toHaveLength(2);
  });
});
