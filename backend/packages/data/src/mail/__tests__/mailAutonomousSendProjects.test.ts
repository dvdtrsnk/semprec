import "../../domainWriteHooks.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { withTransaction } from "../../db/pool.js";
import { generatePermissionManifest } from "../../manifest/permissionManifest.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createMailAutonomousSendProjectsRouteHandler } from "../mailAutonomousSendRouteHandlers.js";
import { createMailboxDetailRouteHandler, createMailboxListRouteHandler } from "../mailboxRouteHandlers.js";

let admin: Pool;
let runtime: Pool;
let tenant: string;
let foreign: string;

async function databaseId(moduleId: string): Promise<string> {
  const database = (await createChokePoint(runtime).listDatabases()).find((row) => row.ownerModuleId === moduleId);
  if (!database) throw new Error(`Missing ${moduleId}`);
  return database.id;
}

async function project(name: string): Promise<string> {
  return (
    await createChokePoint(runtime).createItem({ databaseId: await databaseId("projects"), properties: { name } })
  ).id;
}

/**
 * The grant has no writer in the app by design (issue #1635 Out of scope; `ManifestCapabilities` in
 * manifest/permissionManifest.ts): the server operator sets `emailSendAutonomous` on the project row
 * directly. This fixture does exactly that, with direct SQL in the tenant's scope; it is not a
 * production write path and no route test uses it as one.
 */
async function setGrant(projectItemId: string, value: unknown): Promise<void> {
  await withTransaction(runtime, async (client) => {
    const result = await client.query(
      `UPDATE items SET properties = properties || jsonb_build_object('emailSendAutonomous', $2::jsonb)
        WHERE tenant_id = app_tenant_default() AND id = $1`,
      [projectItemId, JSON.stringify(value)],
    );
    expect(result.rowCount).toBe(1);
  });
}

async function mailbox(name: string): Promise<string> {
  return (
    await createChokePoint(runtime).createItem({
      databaseId: await databaseId("mailboxes"),
      properties: { name, provider: "gmail" },
    })
  ).id;
}

const listProjects = () => createMailAutonomousSendProjectsRouteHandler(runtime)();
const listMailboxes = () => createMailboxListRouteHandler(runtime)();

describe("GET /api/mail/autonomous-send-projects (issue #1635)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("verify autonomous send role", () =>
      runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    foreign = await createTestTenant(admin);
    for (const id of [tenant, foreign]) await runInTenant(id, () => seedSystem(runtime));
  });

  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });

  it("lists the two granting projects by name and shows count 2 on every mailbox", async () => {
    await runInTenant(tenant, async () => {
      const zeta = await project("Zeta");
      const alpha = await project("Alpha");
      const notGranted = await project("Beta");
      const trashed = await project("Gamma");
      const stringValue = await project("Delta");
      for (const id of [zeta, alpha, trashed]) await setGrant(id, true);
      // Only a boolean `true` grants, exactly as the manifest reads it.
      await setGrant(stringValue, "true");
      await createChokePoint(runtime).softDeleteItem(await databaseId("projects"), trashed);
      const work = await mailbox("Work");
      const personal = await mailbox("Personal");

      expect(await listProjects()).toEqual({
        status: 200,
        body: [
          { projectId: alpha, name: "Alpha" },
          { projectId: zeta, name: "Zeta" },
        ],
      });
      for (const id of [alpha, zeta]) {
        const manifest = await withTransaction(runtime, (client) => generatePermissionManifest(client, id));
        expect(manifest.capabilities.email.send.autonomous).toBe(true);
      }
      for (const id of [notGranted, stringValue]) {
        const manifest = await withTransaction(runtime, (client) => generatePermissionManifest(client, id));
        expect(manifest.capabilities.email.send.autonomous).toBe(false);
      }
      const mailboxes = (await listMailboxes()).body.mailboxes;
      expect(mailboxes.map((row) => [row.id, row.autonomousSendProjectCount]).sort()).toEqual(
        [
          [work, 2],
          [personal, 2],
        ].sort(),
      );
      const detail = await createMailboxDetailRouteHandler(runtime)({ params: { id: work } });
      expect(detail.body.autonomousSendProjectCount).toBe(2);
    });
  });

  it("answers an empty list and count 0 when no project grants the capability", async () => {
    await runInTenant(tenant, async () => {
      await project("Plain");
      const id = await mailbox("Work");
      expect(await listProjects()).toEqual({ status: 200, body: [] });
      expect((await listMailboxes()).body.mailboxes).toEqual([
        expect.objectContaining({ id, autonomousSendProjectCount: 0 }),
      ]);
    });
  });

  it("never shows another tenant's granting projects or counts them", async () => {
    const foreignProject = await runInTenant(foreign, async () => {
      const id = await project("Foreign");
      await setGrant(id, true);
      await mailbox("Foreign mailbox");
      return id;
    });
    await runInTenant(tenant, async () => {
      const own = await project("Own");
      await setGrant(own, true);
      const id = await mailbox("Own mailbox");
      const body = (await listProjects()).body;
      expect(body).toEqual([{ projectId: own, name: "Own" }]);
      expect(JSON.stringify(body)).not.toContain(foreignProject);
      expect((await listMailboxes()).body.mailboxes).toEqual([
        expect.objectContaining({ id, autonomousSendProjectCount: 1 }),
      ]);
    });
  });
});
