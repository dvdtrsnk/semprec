import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { runTenantCutoverMigrations } from "../../db/tenantCutoverMigrations.js";
import { KNOWN_HEARTBEAT_ACTION_IDS } from "../../manifest/knownActionIds.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { manifest as calendarModuleManifest } from "../calendarModuleManifest.js";
import { CALENDAR_APPLY_INVITATION_REPLY_ACTION_ID } from "../invitationReplyAction.js";
import { runInvitationReplyHeartbeatCutoverMigration } from "../invitationReplyHeartbeatCutoverMigration.js";

let admin: Pool;
let runtime: Pool;
let tenant: string;
let other: string;

const heartbeatRow = z.object({
  project_item_id: z.string(),
  name: z.string(),
  rule: z.unknown(),
  action_config: z.record(z.string(), z.unknown()),
  enabled: z.boolean(),
  origin: z.string(),
});

const idRow = z.object({ id: z.string(), owner_project_item_id: z.string().nullable() });

/** The reply heartbeats of a tenant, read on the admin pool filtered by the tenant. */
async function heartbeatsOf(tenantId: string) {
  const { rows } = await admin.query(
    `SELECT project_item_id, name, rule, action_config, enabled, origin FROM project_heartbeats
      WHERE tenant_id = $1 AND action_id = $2`,
    [tenantId, CALENDAR_APPLY_INVITATION_REPLY_ACTION_ID],
  );
  return z.array(heartbeatRow).parse(rows);
}

async function databaseOf(tenantId: string, moduleId: string) {
  const { rows } = await admin.query(
    "SELECT id, owner_project_item_id FROM databases WHERE tenant_id = $1 AND owner_module_id = $2",
    [tenantId, moduleId],
  );
  const [row] = z.array(idRow).parse(rows);
  if (!row) throw new Error(`The tenant has no ${moduleId} database`);
  return row;
}

/** The heartbeat the fresh seed creates, as the cutover must create it. */
async function expectedHeartbeat(tenantId: string) {
  const emails = await databaseOf(tenantId, "emails");
  const invitations = await databaseOf(tenantId, "invitations");
  const events = await databaseOf(tenantId, "events");
  const people = await databaseOf(tenantId, "people");
  return {
    project_item_id: invitations.owner_project_item_id,
    name: "Apply calendar invitation replies",
    rule: { kind: "onItemEvent", databaseId: emails.id, event: "create" },
    action_config: { emailsDatabaseId: emails.id, eventsDatabaseId: events.id, peopleDatabaseId: people.id },
    enabled: true,
    origin: "system",
  };
}

/** Reproduces a tenant seeded before issue gh-1950, whose invitations database has no reply heartbeat. */
async function removeHeartbeat(tenantId: string): Promise<void> {
  await admin.query("DELETE FROM project_heartbeats WHERE tenant_id = $1 AND action_id = $2", [
    tenantId,
    CALENDAR_APPLY_INVITATION_REPLY_ACTION_ID,
  ]);
}

const cutover = (tenantId: string) => runInTenant(tenantId, () => runInvitationReplyHeartbeatCutoverMigration(runtime));

describe("the reply heartbeat of the invitations database (issue gh-1950)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    other = await createTestTenant(admin);
    for (const id of [tenant, other]) await runInTenant(id, () => seedSystem(runtime, createViewTypeRegistry()));
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end();
  });

  it("is declared by the calendar manifest and known to the module registry", () => {
    expect(calendarModuleManifest.heartbeatActions).toContain(CALENDAR_APPLY_INVITATION_REPLY_ACTION_ID);
    expect(KNOWN_HEARTBEAT_ACTION_IDS.has(CALENDAR_APPLY_INVITATION_REPLY_ACTION_ID)).toBe(true);
  });

  it("is created by the seed of a new tenant: onItemEvent create on Emails, owned by the project of the Invitations database", async () => {
    expect(await heartbeatsOf(tenant)).toEqual([await expectedHeartbeat(tenant)]);
    const calendars = await databaseOf(tenant, "calendars");
    expect((await heartbeatsOf(tenant))[0]?.project_item_id).toBe(calendars.owner_project_item_id);
  });

  it("is created by the cutover for a tenant that lacks it, and for no other tenant", async () => {
    await removeHeartbeat(tenant);
    await removeHeartbeat(other);

    await cutover(tenant);

    expect(await heartbeatsOf(tenant)).toEqual([await expectedHeartbeat(tenant)]);
    expect(await heartbeatsOf(other)).toEqual([]);
  });

  it("changes nothing when it runs again, or when the seed already created the heartbeat", async () => {
    const seeded = await heartbeatsOf(tenant);
    await cutover(tenant);
    expect(await heartbeatsOf(tenant)).toEqual(seeded);

    await removeHeartbeat(tenant);
    await cutover(tenant);
    await cutover(tenant);
    expect(await heartbeatsOf(tenant)).toEqual([await expectedHeartbeat(tenant)]);
  });

  it("does nothing for a tenant without an Invitations database", async () => {
    await removeHeartbeat(tenant);
    // Hides the database from its module-id lookup: the state of a tenant that never got gh-1901's database.
    await admin.query(
      "UPDATE databases SET owner_module_id = 'invitationsGone' WHERE tenant_id = $1 AND owner_module_id = 'invitations'",
      [tenant],
    );
    await cutover(tenant);
    expect(await heartbeatsOf(tenant)).toEqual([]);
  });

  it("does nothing for a tenant without an Emails database", async () => {
    await removeHeartbeat(tenant);
    await admin.query(
      "UPDATE databases SET owner_module_id = 'emailsGone' WHERE tenant_id = $1 AND owner_module_id = 'emails'",
      [tenant],
    );
    await cutover(tenant);
    expect(await heartbeatsOf(tenant)).toEqual([]);
  });

  it.each(["events", "people"])("does nothing for a tenant without a %s database", async (moduleId) => {
    await removeHeartbeat(tenant);
    await admin.query(
      "UPDATE databases SET owner_module_id = 'moduleGone' WHERE tenant_id = $1 AND owner_module_id = $2",
      [tenant, moduleId],
    );
    await cutover(tenant);
    expect(await heartbeatsOf(tenant)).toEqual([]);
  });

  it("does nothing for a tenant that has no databases at all", async () => {
    const empty = await createTestTenant(admin);
    await cutover(empty);
    expect(await heartbeatsOf(empty)).toEqual([]);
  });

  it("does nothing for an Invitations database that has no owner project item", async () => {
    await removeHeartbeat(tenant);
    await admin.query(
      "UPDATE databases SET owner_project_item_id = NULL WHERE tenant_id = $1 AND owner_module_id = 'invitations'",
      [tenant],
    );
    await cutover(tenant);
    expect(await heartbeatsOf(tenant)).toEqual([]);
  });

  it("runs through runTenantCutoverMigrations for every tenant that lacks the heartbeat", async () => {
    await removeHeartbeat(tenant);
    await removeHeartbeat(other);

    await runAsSystem("test invitation reply cutover", () => runTenantCutoverMigrations(runtime));

    for (const tenantId of [tenant, other]) {
      expect(await heartbeatsOf(tenantId)).toEqual([await expectedHeartbeat(tenantId)]);
    }
  });
});
