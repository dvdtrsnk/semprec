import { randomUUID } from "node:crypto";
import { writeBlock } from "@semprec/block-model";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import {
  createChokePoint,
  createProjectAgentGuidanceSaveRouteHandler,
  createUser,
  projectAgentGuidanceStore,
  readProjectNotes,
  readPageMarkdown,
  mutateYDoc,
  seedSystem,
  withTransaction,
} from "@semprec/data";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTestPool,
  resetDatabase,
  writePageTextBlocks,
} from "@semprec/data/testSupport";
import { createProjectAgentGuidanceSystemPromptOverride } from "../projectAgentGuidanceSystemPrompt.js";

let admin: Pool;
let pool: Pool;
describe("saved guidance reaches the next agent prompt", () => {
  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("test:role", () =>
      pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });
  beforeEach(async () => resetDatabase(admin));
  afterAll(async () => {
    await pool.end();
    await admin.end();
  });
  it("uses real page captions on both sides of the notes cap", async () => {
    const tenant = await createTestTenant(admin);
    await createUser(admin, { email: "notes@example.test", passwordHash: "hash", tenantId: tenant });
    await runInTenant(tenant, () => seedSystem(pool));
    await runInTenant(tenant, async () => {
      const db = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = 'projects'");
      if (!db.rows[0]) throw new Error("Missing Projects database");
      const project = await createChokePoint(pool).createItem({
        databaseId: db.rows[0].id,
        properties: { name: "Project" },
      });
      await writePageTextBlocks(pool, project.id, []);
      const empty = await withTransaction(pool, (tx) => readPageMarkdown(tx, project.id));
      if (!empty.docId) throw new Error("Missing page document");
      const first = (
        await createChokePoint(pool).createItem({ databaseId: db.rows[0].id, properties: { name: "First child" } })
      ).id;
      const second = (
        await createChokePoint(pool).createItem({ databaseId: db.rows[0].id, properties: { name: "Second child" } })
      ).id;
      await mutateYDoc(pool, empty.docId, "user", (doc) => {
        writeBlock(doc, { id: randomUUID(), type: "page", pageId: first, text: "First title" });
        writeBlock(doc, { id: randomUUID(), type: "text", text: "x".repeat(33000) });
        writeBlock(doc, { id: randomUUID(), type: "page", pageId: second, text: "Second title" });
      });
      const override = await createProjectAgentGuidanceSystemPromptOverride(
        () => Promise.resolve(null),
        project.id,
        (id) => withTransaction(pool, (tx) => readProjectNotes(tx, id)),
      );
      const prompt = override("Base");
      expect(prompt).toContain(`[First title](semprec://page/${first})`);
      expect(prompt).toContain(
        JSON.stringify([
          { id: first, title: "First title" },
          { id: second, title: "Second title" },
        ]),
      );
      expect(prompt).not.toContain(`[Second title](semprec://page/${second})`);
    });
  });

  it("uses the actual saved sections and creates its heartbeat", async () => {
    const tenant = await createTestTenant(admin);
    const user = await createUser(admin, { email: "prompt@example.test", passwordHash: "hash", tenantId: tenant });
    await runInTenant(tenant, () => seedSystem(pool));
    await runInTenant(tenant, async () => {
      const db = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = 'projects'");
      if (!db.rows[0]) throw new Error("Missing projects");
      const project = await createChokePoint(pool).createItem({
        databaseId: db.rows[0].id,
        properties: { name: "Project" },
      });
      const saved = await createProjectAgentGuidanceSaveRouteHandler(pool)({
        params: { id: project.id },
        identity: { user: { id: user.id } },
        body: {
          sections: { purpose: "Coordinate work", allowed: "Read tasks", notAllowed: "", generalInstructions: "" },
          expectedUpdatedAt: null,
        },
      });
      expect(saved.status).toBe(200);
      const override = await createProjectAgentGuidanceSystemPromptOverride(
        (id) => withTransaction(pool, (tx) => projectAgentGuidanceStore.load(tx, id)),
        project.id,
      );
      expect(override("Base prompt")).toContain(
        "## Project-specific guidance\n\n## Purpose\nCoordinate work\n\n## Allowed\nRead tasks",
      );
      const heartbeat = await pool.query<{ enabled: boolean }>(
        "SELECT enabled FROM project_heartbeats WHERE project_item_id = $1 AND action_id = 'core.agentGuidanceDrift'",
        [project.id],
      );
      expect(heartbeat.rows).toEqual([{ enabled: true }]);
    });
  });
});
