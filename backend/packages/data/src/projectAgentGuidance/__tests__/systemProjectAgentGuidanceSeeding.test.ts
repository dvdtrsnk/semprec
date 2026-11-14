import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { bootstrapFirstAccount } from "../../auth/authActions.js";
import { createUser } from "../../auth/usersStore.js";
import { getDatabaseByModuleId } from "../../chokePoint/databasesStore.js";
import { insertItem, softDeleteItem, updateItemProperties } from "../../chokePoint/itemsStore.js";
import { withTransaction } from "../../db/pool.js";
import { projectAgentGuidanceStore } from "../../projectAgentGuidanceStore.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { PROJECTS_MODULE_ID } from "../../seed/tenDatabaseKeys.js";
import { BOOKS_MODULE_ID, MOVIES_MODULE_ID } from "../../seed/libraryModuleKeys.js";
import { MAILBOXES_MODULE_ID } from "../../seed/emailModuleKeys.js";
import { MCP_SERVERS_MODULE_ID } from "../../seed/mcpModuleKeys.js";
import { RECIPES_MODULE_ID } from "../../seed/recipesModuleKeys.js";
import { SYSTEM_SETTINGS_MODULE_ID } from "../../systemSettings.js";
import { createInvite } from "../../tenancy/invites.js";
import { logger } from "../../tenancy/logger.js";
import { acceptInvitation } from "../../tenancy/acceptInvitation.js";
import {
  createRuntimeRolePool,
  createTestProjectItem,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../../testSupport/testDb.js";
import { seedAccountSystemProjectGuidance } from "../seedSystemProjectAgentGuidance.js";

const SETUP_TOKEN = "correct-setup-token";
const PASSWORD = "correct-horse-battery";
// Each test that runs the real provisioning builds a tenant's couple of dozen system databases.
const PROVISIONING_TEST_TIMEOUT_MS = 60_000;

const BOOKS_MARKDOWN =
  "## Purpose\ncatalog books the user is reading or has read.\n\n" +
  "## Allowed\ncreate a Books item (name/author/rating/status) via the generic create-item endpoint.\n\n" +
  "## Not allowed\nwrite 'cover' — owner: 'system', reserved for the metadata heartbeat regardless of who requests the write.\n\n" +
  "## General instructions\nuse the same create-item path as the UI; there is no separate AI path.\n";

const EXPECTED_MARKDOWN: Record<string, string> = {
  [SYSTEM_SETTINGS_MODULE_ID]:
    "## Purpose\nsupervise Semprec, the personal life-organization system, and delegate to project agents.\n\n## Allowed\nread the schema-derived permission manifest for any project and delegate tasks to its agent.\n\n## Not allowed\nwrite any property whose owner is 'system', or change a locked/schema_locked database.\n\n## General instructions\nkeep delegated tasks and their results terse; the manifest is the source of truth for what is allowed.\n",
  [MCP_SERVERS_MODULE_ID]:
    "## Purpose\nhost MCP (Model Context Protocol) server connections as a system resource.\n\n## Allowed\npropose a new MCP server's name and connectionConfig via the standard database proposal/confirm path; a human supplies the credential (if any) and confirms.\n\n## Not allowed\nwriting connectionConfig fields that carry a credential (rejected outright, never stored on the item), writing syncStatus/lastSynced/syncError (owner: 'system', written only by the human-triggered Synchronize tools action), or triggering a sync itself — that action has no agent-reachable path at all.\n\n## General instructions\nthis project exists only to host MCP server items; tool discovery/grants/invocation are later issues.\n",
  [MAILBOXES_MODULE_ID]:
    "## Purpose\nkeep synced mailboxes/folders/messages consistent and link messages to People deterministically.\n\n## Allowed\nread Mailboxes/Folders/Emails via the generic list/get endpoints; read a conversation with mail.thread.get; prepare a reply with mail.draft.create and revise your open draft with mail.draft.update — drafting never requires confirmation.\n\n## Not allowed\nwrite any Mailboxes/Folders/Emails property directly outside mail.draft.create and mail.draft.update — every field except the user-owned Emails.read/Emails.flagged triage flags is owner: 'system', written only by the sync worker or the draft/send path (mail/ingest.ts, mail/draft.ts, mail/send.ts). Calling mail.draft.send never sends: sending without project permission becomes an approval request, and in v1 so does a send from a project with capabilities.email.send.autonomous; the mail leaves only after the user approves it, and a rejected request leaves the draft unchanged.\n\n## General instructions\nthis project's only agent-facing write surface is drafting (mail.draft.create, mail.draft.update) and requesting the user's approval to send mail (mail.draft.send); it otherwise exists to host the sync worker's heartbeats.\n",
  [BOOKS_MODULE_ID]: BOOKS_MARKDOWN,
  [MOVIES_MODULE_ID]:
    "## Purpose\ncatalog movies and TV series watched or planned to watch.\n\n## Allowed\ncreate a Movies/TV item (name/year/type/rating/status) via the generic create-item endpoint, and link 'Watched with' to a Person with a 1-5 rating on the relation.\n\n## Not allowed\nwrite 'cover'/'secondaryRating'/'sourceUrl' — owner: 'system', reserved for the metadata heartbeat regardless of who requests the write.\n\n## General instructions\nuse the same create-item path as the UI; there is no separate AI path.\n",
  // The Recipes system project (issue #1707).
  [RECIPES_MODULE_ID]:
    "## Purpose\ncatalog the user's recipes; the ingredients and the method are written on each recipe's page.\n\n## Allowed\ncreate or update a Recipes item (name/category/prepMinutes/servings/favorite/photo) via the generic item endpoints.\n\n## Not allowed\nwrite 'photo' with anything other than { blobId } of an image blob of this tenant, or null to clear it — every other value is rejected.\n\n## General instructions\nuse the same item paths as the UI; there is no separate AI path.\n",
};

async function expectSystemGuidance(dataPool: Pool, tenantId: string, ownerId: string): Promise<void> {
  const rows = await runInTenant(tenantId, () =>
    withTransaction(
      dataPool,
      async (client) =>
        (
          await client.query<{ module_id: string; owner_user_id: string; markdown: string }>(
            `SELECT d.owner_module_id AS module_id, g.owner_user_id, g.markdown
       FROM databases d JOIN project_agent_guidance g ON g.project_item_id = d.owner_project_item_id
       WHERE d.system AND d.owner_module_id = ANY($1::text[]) ORDER BY d.owner_module_id`,
            [Object.keys(EXPECTED_MARKDOWN)],
          )
        ).rows,
    ),
  );
  expect(rows).toHaveLength(6);
  for (const row of rows)
    expect(row).toEqual({
      module_id: row.module_id,
      owner_user_id: ownerId,
      markdown: EXPECTED_MARKDOWN[row.module_id],
    });
  expect(rows.map((row) => row.module_id).sort()).toEqual(Object.keys(EXPECTED_MARKDOWN).sort());
}

interface GuidanceRow {
  project_item_id: string;
  owner_user_id: string;
  markdown: string;
}

let pool: Pool;

afterAll(async () => {
  await pool?.end();
});

async function projectsDatabaseId(): Promise<string> {
  return withTransaction(pool, async (client: PoolClient) => {
    const database = await getDatabaseByModuleId(client, PROJECTS_MODULE_ID);
    if (!database) throw new Error("the tenant has no Projects database");
    return database.id;
  });
}

/** The Projects item that owns each system database, keyed by the database's owner module id. */
async function systemProjectIds(): Promise<Map<string, string>> {
  const { rows } = await pool.query<{ owner_module_id: string; owner_project_item_id: string }>(
    `SELECT owner_module_id, owner_project_item_id FROM databases
     WHERE system AND owner_project_item_id IS NOT NULL`,
  );
  return new Map(rows.map((row) => [row.owner_module_id, row.owner_project_item_id]));
}

async function allGuidance(): Promise<GuidanceRow[]> {
  const { rows } = await pool.query<GuidanceRow>(
    "SELECT project_item_id, owner_user_id, markdown FROM project_agent_guidance ORDER BY project_item_id",
  );
  return rows;
}

function bootstrap() {
  return bootstrapFirstAccount(pool, SETUP_TOKEN, SETUP_TOKEN, { email: "admin@example.test", password: PASSWORD });
}

/** Renames, soft-deletes or switches a Projects item through the store the choke point writes with. */
async function patchProject(projectItemId: string, propertiesPatch: Record<string, unknown>): Promise<void> {
  const databaseId = await projectsDatabaseId();
  await withTransaction(pool, (client) =>
    updateItemProperties(client, { databaseId, itemId: projectItemId, propertiesPatch }),
  );
}

describe("system project guidance seeding (issue #1449)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates one guidance row per system project, owned by the new admin, when the first account is created", async () => {
    const projects = await systemProjectIds();

    const account = await bootstrap();

    const rows = await allGuidance();
    expect(rows).toHaveLength(6);
    expect(rows.every((row) => row.owner_user_id === account.id)).toBe(true);
    const booksRow = rows.find((row) => row.project_item_id === projects.get(BOOKS_MODULE_ID));
    expect(booksRow?.markdown).toBe(BOOKS_MARKDOWN);
    for (const moduleId of [
      SYSTEM_SETTINGS_MODULE_ID,
      MCP_SERVERS_MODULE_ID,
      MAILBOXES_MODULE_ID,
      MOVIES_MODULE_ID,
      RECIPES_MODULE_ID,
    ]) {
      expect(rows.map((row) => row.project_item_id)).toContain(projects.get(moduleId));
    }
  });

  it("seeds the guidance in the tenant's scope when the setup route creates the account under the system scope", async () => {
    // The setup route calls bootstrapFirstAccount under runAsSystem on the runtime role, where a transaction
    // sees the tenant's system databases as absent. A superuser pool would bypass that row-level security.
    const dataPool = await createRuntimeRolePool(pool, "semprec_data");
    try {
      const account = await runAsSystem("setup", () =>
        bootstrapFirstAccount(dataPool, SETUP_TOKEN, SETUP_TOKEN, { email: "admin@example.test", password: PASSWORD }),
      );

      const rows = await allGuidance();
      expect(rows).toHaveLength(6);
      expect(rows.every((row) => row.owner_user_id === account.id)).toBe(true);
      await expectSystemGuidance(dataPool, getTenantZeroId(), account.id);
    } finally {
      await dataPool.end();
    }
  });

  it("gives each seeded system project its drift heartbeat with its guidance row", async () => {
    await bootstrap();

    const { rows } = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM project_heartbeats WHERE action_id = 'core.agentGuidanceDrift' AND enabled",
    );
    expect(rows[0]?.n).toBe(6);
  });

  it("gives a renamed system project its guidance row from the seed text of its module", async () => {
    const projects = await systemProjectIds();
    const semprecProjectId = projects.get(SYSTEM_SETTINGS_MODULE_ID);
    if (!semprecProjectId) throw new Error("the Semprec system project is missing");
    await patchProject(semprecProjectId, { name: "Renamed after seeding" });

    await bootstrap();

    const row = (await allGuidance()).find((entry) => entry.project_item_id === semprecProjectId);
    expect(row?.markdown.startsWith("## Purpose\nsupervise Semprec, the personal life-organization system")).toBe(true);
  });

  it("gives no guidance row to a user project that carries a system project's name", async () => {
    const userProjectId = await withTransaction(pool, async (client) => {
      const databaseId = await projectsDatabaseId();
      return (
        await insertItem(client, { databaseId, properties: { name: "Books", agents: "Purpose: a user project" } })
      ).id;
    });

    await bootstrap();

    const rows = await allGuidance();
    expect(rows.map((row) => row.project_item_id)).not.toContain(userProjectId);
    expect(rows).toHaveLength(6);
  });

  it("gives no guidance row to a system project that is deleted", async () => {
    const projects = await systemProjectIds();
    const mcpProjectId = projects.get(MCP_SERVERS_MODULE_ID);
    if (!mcpProjectId) throw new Error("the MCP system project is missing");
    const databaseId = await projectsDatabaseId();
    await withTransaction(pool, (client) => softDeleteItem(client, databaseId, mcpProjectId));

    await bootstrap();

    const rows = await allGuidance();
    expect(rows.map((row) => row.project_item_id)).not.toContain(mcpProjectId);
    expect(rows).toHaveLength(5);
  });

  it("gives no guidance row to a system project that is not active", async () => {
    const projects = await systemProjectIds();
    const emailProjectId = projects.get(MAILBOXES_MODULE_ID);
    if (!emailProjectId) throw new Error("the Email system project is missing");
    await patchProject(emailProjectId, { systemActive: false });

    await bootstrap();

    const rows = await allGuidance();
    expect(rows.map((row) => row.project_item_id)).not.toContain(emailProjectId);
    expect(rows).toHaveLength(5);
  });

  it("gives no guidance row to a tenant that has no Projects database", async () => {
    await resetDatabase(pool);

    await bootstrap();

    expect(await allGuidance()).toEqual([]);
  });

  it("gives no guidance row when the system databases of the modules are absent", async () => {
    await resetDatabase(pool);
    await createTestProjectItem(pool);

    await bootstrap();

    expect(await allGuidance()).toEqual([]);
  });

  it("changes no row when the seeding runs again, including a row the user has edited", async () => {
    const account = await bootstrap();
    const projects = await systemProjectIds();
    const editedProjectId = projects.get(BOOKS_MODULE_ID);
    if (!editedProjectId) throw new Error("the Books system project is missing");
    const edited = "## Purpose\nedited by the user\n";
    await withTransaction(pool, (client) =>
      projectAgentGuidanceStore.upsert(client, {
        projectItemId: editedProjectId,
        ownerUserId: account.id,
        markdown: edited,
      }),
    );
    const before = await allGuidance();

    await seedAccountSystemProjectGuidance(pool, getTenantZeroId(), account.id);

    expect(await allGuidance()).toEqual(before);
    expect((await allGuidance()).find((row) => row.project_item_id === editedProjectId)?.markdown).toBe(edited);
  });

  it("logs a failed seeding with the tenant id only, and rethrows it", async () => {
    const errorLog = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const projects = await systemProjectIds();
    expect(projects.size).toBeGreaterThan(0);

    // No such user exists, so the guidance insert violates its foreign key and the seeding fails.
    await expect(seedAccountSystemProjectGuidance(pool, getTenantZeroId(), randomUUID())).rejects.toThrow();

    expect(errorLog).toHaveBeenCalledWith({ tenantId: getTenantZeroId() }, "project_guidance_seeding_failed");
    expect(await allGuidance()).toEqual([]);
  });
});

describe("system project guidance for an invited account (issue #1449)", () => {
  const APP_BASE_URL = "https://app.example.test";

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
  });

  it(
    "gives each system project of the invited tenant its guidance row, owned by the invited account",
    async () => {
      await seedSystem(pool);
      const inviter = await createUser(pool, {
        email: `${randomUUID()}@example.test`,
        passwordHash: "unused",
        tenantId: getTenantZeroId(),
        role: "admin",
      });
      const dataPool = await createRuntimeRolePool(pool, "semprec_data");
      try {
        const created = await runAsSystem("acceptInvitationTest", () =>
          withTransaction(dataPool, (client) =>
            createInvite(client, {
              email: "novak@example.test",
              invitedBy: inviter.id,
              appBaseUrl: APP_BASE_URL,
              mailer: null,
            }),
          ),
        );
        const token = new URL(created.inviteUrl).hash.replace("#token=", "");

        const invited = await acceptInvitation(dataPool, { token, password: PASSWORD });

        const { rows: users } = await pool.query<{ tenant_id: string }>("SELECT tenant_id FROM users WHERE id = $1", [
          invited.id,
        ]);
        const tenantId = users[0]?.tenant_id;
        if (!tenantId) throw new Error("invited user has no tenant");
        await expectSystemGuidance(dataPool, tenantId, invited.id);

        const { rows } = await pool.query<GuidanceRow>(
          "SELECT project_item_id, owner_user_id, markdown FROM project_agent_guidance WHERE owner_user_id = $1",
          [invited.id],
        );
        expect(rows).toHaveLength(6);
      } finally {
        await dataPool.end();
      }
    },
    PROVISIONING_TEST_TIMEOUT_MS,
  );
});
