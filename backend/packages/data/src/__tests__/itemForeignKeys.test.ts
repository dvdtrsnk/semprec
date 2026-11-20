import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import "../domainWriteHooks.js";
import { createUser } from "../auth/usersStore.js";
import { createBlob } from "../blobs/blobsStore.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { createDatabase, deleteDatabaseWithItems } from "../chokePoint/databasesStore.js";
import { insertItem } from "../chokePoint/itemsStore.js";
import { createProperty } from "../chokePoint/propertiesStore.js";
import { createRelationDefinition } from "../chokePoint/relationsStore.js";
import { createView } from "../chokePoint/viewsStore.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { PROJECTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { raiseProblem } from "../semp/sempProblemsStore.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "../testSupport/testDb.js";

/**
 * The foreign keys to `items` (decision table: docs/architecture/data-model-and-writes.md, Storage). Dependent rows
 * are raw INSERTs: no production flow writes one row into every dependent table of one item, and several writers
 * check the item first, so they would never reach the key. Every assertion runs on a `semprec_data` pool, under
 * row-level security. Interpolated identifiers come from the closed `KEYS` list; values are bound.
 */

type Behaviour = "cascade" | "noAction" | "setNull";

interface Shared {
  databaseId: string;
  viewId: string;
  curatedViewId: string;
  relationDefinitionId: string;
  blobId: string;
  userId: string;
}

interface ItemKey {
  table: string;
  column: string;
  behaviour: Behaviour;
  /** Writes one row whose `column` names `itemId`; `other` creates a further item for the row's other references. */
  insert: (client: PoolClient, itemId: string, shared: Shared, other: () => Promise<string>) => Promise<unknown>;
}

const KEYS: ItemKey[] = [
  {
    table: "agent_database_grants",
    column: "project_item_id",
    behaviour: "cascade",
    insert: (c, id, s) =>
      c.query("INSERT INTO agent_database_grants (project_item_id, database_id, access) VALUES ($1, $2, 'read')", [
        id,
        s.databaseId,
      ]),
  },
  {
    table: "calendar_feed_state",
    column: "calendar_item_id",
    behaviour: "cascade",
    insert: (c, id) => c.query("INSERT INTO calendar_feed_state (calendar_item_id) VALUES ($1)", [id]),
  },
  {
    table: "calendar_account_sync_state",
    column: "account_item_id",
    behaviour: "cascade",
    insert: (c, id) => c.query("INSERT INTO calendar_account_sync_state (account_item_id) VALUES ($1)", [id]),
  },
  {
    table: "calendar_event_push_state",
    column: "event_item_id",
    behaviour: "cascade",
    insert: (c, id) =>
      c.query("INSERT INTO calendar_event_push_state (event_item_id, operation) VALUES ($1, 'create')", [id]),
  },
  {
    table: "calendar_remote_state",
    column: "calendar_item_id",
    behaviour: "cascade",
    insert: (c, id) =>
      c.query("INSERT INTO calendar_remote_state (calendar_item_id, remote_id) VALUES ($1, 'remote')", [id]),
  },
  {
    table: "event_remote_state",
    column: "event_item_id",
    behaviour: "cascade",
    insert: async (c, id, _s, other) =>
      c.query("INSERT INTO event_remote_state (event_item_id, calendar_item_id, remote_id) VALUES ($1, $2, 'remote')", [
        id,
        await other(),
      ]),
  },
  {
    table: "event_remote_state",
    column: "calendar_item_id",
    behaviour: "cascade",
    insert: async (c, id, _s, other) =>
      c.query("INSERT INTO event_remote_state (event_item_id, calendar_item_id, remote_id) VALUES ($1, $2, 'remote')", [
        await other(),
        id,
      ]),
  },
  {
    table: "docs",
    column: "item_id",
    behaviour: "cascade",
    insert: (c, id) => c.query("INSERT INTO docs (item_id) VALUES ($1)", [id]),
  },
  {
    table: "external_credentials",
    column: "item_id",
    behaviour: "cascade",
    insert: (c, id) =>
      c.query(
        "INSERT INTO external_credentials (item_id, credential_type, ciphertext, nonce, scheme) VALUES ($1, 'api_key', '\\x00', '\\x00', 'tenant')",
        [id],
      ),
  },
  {
    table: "idempotency_keys",
    column: "item_id",
    behaviour: "cascade",
    insert: (c, id, s) =>
      c.query("INSERT INTO idempotency_keys (key, database_id, item_id) VALUES ($1, $2, $3)", [
        randomUUID(),
        s.databaseId,
        id,
      ]),
  },
  {
    table: "item_automation",
    column: "item_id",
    behaviour: "cascade",
    insert: (c, id) => c.query("INSERT INTO item_automation (item_id) VALUES ($1)", [id]),
  },
  {
    table: "item_origins",
    column: "item_id",
    behaviour: "cascade",
    insert: async (c, id, _s, other) =>
      c.query(
        "INSERT INTO item_origins (item_id, proposal_id, capture_channel, capture_time_basis) VALUES ($1, $2, 'inbox', 'unknown')",
        [id, await other()],
      ),
  },
  {
    table: "item_relations",
    column: "item_a",
    behaviour: "cascade",
    insert: async (c, id, s, other) =>
      c.query("INSERT INTO item_relations (relation_definition_id, item_a, item_b) VALUES ($1, $2, $3)", [
        s.relationDefinitionId,
        id,
        await other(),
      ]),
  },
  {
    table: "item_relations",
    column: "item_b",
    behaviour: "cascade",
    insert: async (c, id, s, other) =>
      c.query("INSERT INTO item_relations (relation_definition_id, item_a, item_b) VALUES ($1, $2, $3)", [
        s.relationDefinitionId,
        await other(),
        id,
      ]),
  },
  {
    table: "item_search_index",
    column: "item_id",
    behaviour: "cascade",
    insert: (c, id, s) =>
      c.query("INSERT INTO item_search_index (item_id, database_id, search_vector) VALUES ($1, $2, ''::tsvector)", [
        id,
        s.databaseId,
      ]),
  },
  {
    table: "library_cover_candidates",
    column: "item_id",
    behaviour: "cascade",
    insert: (c, id) =>
      c.query(
        "INSERT INTO library_cover_candidates (item_id, idx, source, image_url) VALUES ($1, 0, 'openLibrary', 'https://example.com/c.jpg')",
        [id],
      ),
  },
  {
    table: "mail_account_server_settings",
    column: "mailbox_item_id",
    behaviour: "cascade",
    insert: (c, id) =>
      c.query("INSERT INTO mail_account_server_settings (mailbox_item_id, username) VALUES ($1, 'probe')", [id]),
  },
  {
    table: "mail_account_sync_state",
    column: "item_id",
    behaviour: "cascade",
    insert: (c, id) => c.query("INSERT INTO mail_account_sync_state (item_id, sync_mode) VALUES ($1, 'imap')", [id]),
  },
  {
    table: "mail_attachments",
    column: "message_item_id",
    behaviour: "cascade",
    insert: (c, id, s) =>
      c.query(
        `INSERT INTO mail_attachments (message_item_id, blob_id, filename, content_type, disposition, byte_size)
         VALUES ($1, $2, 'probe.txt', 'text/plain', 'attachment', 1)`,
        [id, s.blobId],
      ),
  },
  {
    table: "mail_drafts",
    column: "email_item_id",
    behaviour: "cascade",
    insert: async (c, id, _s, other) =>
      c.query(
        `INSERT INTO mail_drafts (email_item_id, mailbox_item_id, mode, from_address, created_by, last_edited_by)
         VALUES ($1, $2, 'new', 'probe@example.com', 'user', 'user')`,
        [id, await other()],
      ),
  },
  {
    table: "mail_folder_sync_state",
    column: "item_id",
    behaviour: "cascade",
    insert: (c, id) => c.query("INSERT INTO mail_folder_sync_state (item_id) VALUES ($1)", [id]),
  },
  {
    table: "mail_message_flag_sync_state",
    column: "message_item_id",
    behaviour: "cascade",
    insert: (c, id) =>
      c.query(
        "INSERT INTO mail_message_flag_sync_state (message_item_id, property_key, desired_state) VALUES ($1, 'read', true)",
        [id],
      ),
  },
  {
    table: "mail_oauth_states",
    column: "mailbox_item_id",
    behaviour: "cascade",
    insert: (c, id, s) =>
      c.query(
        `INSERT INTO mail_oauth_states
           (user_id, provider, state_hash, code_verifier_ciphertext, code_verifier_nonce, mailbox_item_id, services)
         VALUES ($1, 'gmail', $2, '\\x00', '\\x00', $3, '{mail}')`,
        [s.userId, randomUUID(), id],
      ),
  },
  {
    table: "mcp_server_connection_state",
    column: "mcp_server_item_id",
    behaviour: "cascade",
    insert: (c, id) => c.query("INSERT INTO mcp_server_connection_state (mcp_server_item_id) VALUES ($1)", [id]),
  },
  {
    table: "person_email_index",
    column: "item_id",
    behaviour: "cascade",
    insert: (c, id) =>
      c.query("INSERT INTO person_email_index (email, item_id) VALUES ($1, $2)", [`${randomUUID()}@example.com`, id]),
  },
  {
    table: "project_kept_dates",
    column: "item_id",
    behaviour: "cascade",
    insert: (c, id) => c.query("INSERT INTO project_kept_dates (item_id, kept_date) VALUES ($1, '{}')", [id]),
  },
  {
    table: "recording_requests",
    column: "file_item_id",
    behaviour: "cascade",
    insert: (c, id) => c.query("INSERT INTO recording_requests (file_item_id) VALUES ($1)", [id]),
  },
  {
    table: "task_recurrence",
    column: "item_id",
    behaviour: "cascade",
    insert: (c, id) => c.query("INSERT INTO task_recurrence (item_id, mode, rule) VALUES ($1, 'fixed', '{}')", [id]),
  },
  {
    table: "transcript_action_item_states",
    column: "transcript_item_id",
    behaviour: "cascade",
    insert: (c, id) =>
      c.query(
        "INSERT INTO transcript_action_item_states (transcript_item_id, action_item_id, state) VALUES ($1, 0, 'noted')",
        [id],
      ),
  },
  {
    table: "value_links",
    column: "item_id",
    behaviour: "cascade",
    insert: (c, id) =>
      c.query("INSERT INTO value_links (item_id, property_key, rule_key) VALUES ($1, 'probe', 'probe')", [id]),
  },
  {
    table: "view_items",
    column: "item_id",
    behaviour: "cascade",
    insert: (c, id, s) =>
      c.query("INSERT INTO view_items (view_id, item_id, position) VALUES ($1, $2, 0)", [s.curatedViewId, id]),
  },
  {
    table: "inbox_attachments",
    column: "inbox_item_id",
    behaviour: "noAction",
    insert: (c, id, s) =>
      c.query("INSERT INTO inbox_attachments (inbox_item_id, blob_id, position, source) VALUES ($1, $2, 0, 'files')", [
        id,
        s.blobId,
      ]),
  },
  {
    table: "mail_message_meta",
    column: "item_id",
    behaviour: "noAction",
    insert: (c, id) =>
      c.query("INSERT INTO mail_message_meta (item_id, message_id) VALUES ($1, $2)", [
        id,
        `<${randomUUID()}@example.com>`,
      ]),
  },
  {
    table: "value_link_sources",
    column: "source_item_id",
    behaviour: "noAction",
    insert: async (c, id, _s, other) => {
      const { rows } = await c.query<{ id: string }>(
        "INSERT INTO value_links (item_id, property_key, rule_key) VALUES ($1, 'probe', 'probe') RETURNING id",
        [await other()],
      );
      return c.query(
        "INSERT INTO value_link_sources (link_id, source_kind, source_property_key, source_item_id) VALUES ($1, 'item', 'probe', $2)",
        [rows[0]?.id, id],
      );
    },
  },
  {
    table: "item_origins",
    column: "inbox_item_id",
    behaviour: "setNull",
    insert: async (c, id, _s, other) =>
      c.query(
        `INSERT INTO item_origins (item_id, proposal_id, capture_channel, capture_time_basis, inbox_item_id)
         VALUES ($1, $2, 'inbox', 'unknown', $3)`,
        [await other(), await other(), id],
      ),
  },
  {
    table: "item_origins",
    column: "source_transcript_id",
    behaviour: "setNull",
    insert: async (c, id, _s, other) =>
      c.query(
        `INSERT INTO item_origins (item_id, proposal_id, capture_channel, capture_time_basis, source_transcript_id)
         VALUES ($1, $2, 'transcript', 'unknown', $3)`,
        [await other(), await other(), id],
      ),
  },
  {
    table: "mail_drafts",
    column: "source_email_item_id",
    behaviour: "setNull",
    insert: async (c, id, _s, other) =>
      c.query(
        `INSERT INTO mail_drafts (email_item_id, mailbox_item_id, mode, from_address, created_by, last_edited_by, source_email_item_id)
         VALUES ($1, $2, 'reply', 'probe@example.com', 'user', 'user', $3)`,
        [await other(), await other(), id],
      ),
  },
  {
    table: "recording_requests",
    column: "event_item_id",
    behaviour: "setNull",
    insert: async (c, id, _s, other) =>
      c.query("INSERT INTO recording_requests (file_item_id, event_item_id) VALUES ($1, $2)", [await other(), id]),
  },
  {
    table: "recording_requests",
    column: "project_item_id",
    behaviour: "setNull",
    insert: async (c, id, _s, other) =>
      c.query("INSERT INTO recording_requests (file_item_id, project_item_id) VALUES ($1, $2)", [await other(), id]),
  },
  {
    table: "semp_problems",
    column: "project_item_id",
    behaviour: "setNull",
    insert: (c, id, s) =>
      c.query(
        `INSERT INTO semp_problems (user_id, category, kind, severity, source_table, source_id, dedupe_key, project_item_id)
         VALUES ($1, 'agents', 'probe', 'warning', 'agent_runs', $2, $3, $4)`,
        [s.userId, randomUUID(), randomUUID(), id],
      ),
  },
  {
    table: "semp_threads",
    column: "subject_proposal_id",
    behaviour: "setNull",
    insert: async (c, id, _s, other) =>
      c.query("INSERT INTO semp_threads (kind, subject_inbox_item_id, subject_proposal_id) VALUES ('item', $1, $2)", [
        await other(),
        id,
      ]),
  },
  {
    table: "task_recurrence",
    column: "trashed_active_item_id",
    behaviour: "setNull",
    insert: async (c, id, _s, other) =>
      c.query(
        "INSERT INTO task_recurrence (item_id, mode, rule, trashed_active_item_id) VALUES ($1, 'fixed', '{}', $2)",
        [await other(), id],
      ),
  },
  {
    table: "transcript_action_item_states",
    column: "owner_person_id",
    behaviour: "setNull",
    insert: async (c, id, _s, other) =>
      c.query(
        "INSERT INTO transcript_action_item_states (transcript_item_id, action_item_id, state, owner_person_id) VALUES ($1, 0, 'noted', $2)",
        [await other(), id],
      ),
  },
  {
    table: "transcript_action_item_states",
    column: "task_item_id",
    behaviour: "setNull",
    insert: async (c, id, _s, other) =>
      c.query(
        "INSERT INTO transcript_action_item_states (transcript_item_id, action_item_id, state, task_item_id) VALUES ($1, 0, 'added', $2)",
        [await other(), id],
      ),
  },
  {
    table: "views",
    column: "creator_project_item_id",
    behaviour: "setNull",
    insert: (c, id, s) =>
      c.query(
        "INSERT INTO views (database_id, type, name, created_by, creator_project_item_id) VALUES ($1, 'table', 'Probe', 'ai_agent', $2)",
        [s.databaseId, id],
      ),
  },
];

const CONFDELTYPE: Record<Behaviour, string> = { cascade: "c", noAction: "a", setNull: "n" };

let adminPool: Pool;
let pool: Pool;
let tenantA: string;
let tenantB: string;
let sharedA: Shared;
let sharedB: Shared;

function inTenant<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return runInTenant(tenantId, () => withTenantTransaction(pool, tenantId, fn));
}

async function seedShared(tenantId: string): Promise<Shared> {
  return inTenant(tenantId, async (client) => {
    const user = await createUser(client, {
      email: `${randomUUID()}@example.com`,
      passwordHash: "unused",
      tenantId,
    });
    const database = await createDatabase(client, { name: "Item FK probe" });
    const relationProperty = await createProperty(client, {
      databaseId: database.id,
      key: "related",
      name: "Related",
      type: "relation",
    });
    const definition = await createRelationDefinition(client, { propertyIdA: relationProperty.id });
    const registry = createViewTypeRegistry();
    const view = await createView(client, { databaseId: database.id, type: "table", name: "Table" }, registry);
    const curated = await createView(
      client,
      { type: "list", name: "Collection", config: { membership: "manual" } },
      registry,
    );
    const blob = await createBlob(client, { mimeType: "text/plain", byteSize: 1, storageKey: `${tenantId}/probe` });
    return {
      databaseId: database.id,
      viewId: view.id,
      curatedViewId: curated.id,
      relationDefinitionId: definition.id,
      blobId: blob.id,
      userId: user.id,
    };
  });
}

async function newItem(client: PoolClient, shared: Shared): Promise<string> {
  return (await insertItem(client, { databaseId: shared.databaseId, properties: {} })).id;
}

/** `key.table` and `key.column` come from the closed `KEYS` list; values are bound. */
async function countReferencing(tenantId: string, key: Pick<ItemKey, "table" | "column">, itemId: string) {
  return inTenant(tenantId, async (client) => {
    const { rows } = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${key.table} WHERE ${key.column} = $1`,
      [itemId],
    );
    return rows[0]?.n ?? 0;
  });
}

async function countRows(tenantId: string, table: string): Promise<number> {
  return inTenant(tenantId, async (client) => {
    // `table` comes from the closed `KEYS` list.
    const { rows } = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
    return rows[0]?.n ?? 0;
  });
}

/** Writes the dependent row of `key` for a new item of `tenantId`, then returns that item. */
async function itemWithDependent(tenantId: string, shared: Shared, key: ItemKey): Promise<string> {
  return inTenant(tenantId, async (client) => {
    const itemId = await newItem(client, shared);
    await key.insert(client, itemId, shared, () => newItem(client, shared));
    return itemId;
  });
}

function deleteItem(client: PoolClient, itemId: string) {
  return client.query("DELETE FROM items WHERE id = $1", [itemId]);
}

describe("foreign keys to items", () => {
  beforeAll(async () => {
    adminPool = getTestPool();
    pool = await createRuntimeRolePool(adminPool, "semprec_data");
    const role = await runAsSystem("test:item-foreign-key-role", () =>
      pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });

  afterAll(async () => {
    await pool?.end();
    await adminPool?.end();
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
    tenantA = await createTestTenant(adminPool);
    tenantB = await createTestTenant(adminPool);
    sharedA = await seedShared(tenantA);
    sharedB = await seedShared(tenantB);
  });

  it("are exactly the decided keys, each over (tenant_id, column) with its decided action", async () => {
    const { rows } = await adminPool.query<{
      table_name: string;
      columns: string[];
      referenced: string[];
      action: string;
      deferrable: boolean;
      deferred: boolean;
    }>(
      `SELECT k.conrelid::regclass::text AS table_name,
              ARRAY(SELECT a.attname::text FROM unnest(k.conkey) WITH ORDINALITY u(attnum, ord)
                      JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.attnum ORDER BY u.ord) AS columns,
              ARRAY(SELECT a.attname::text FROM unnest(k.confkey) WITH ORDINALITY u(attnum, ord)
                      JOIN pg_attribute a ON a.attrelid = k.confrelid AND a.attnum = u.attnum ORDER BY u.ord) AS referenced,
              k.confdeltype::text AS action, k.condeferrable AS deferrable, k.condeferred AS deferred
         FROM pg_constraint k
        WHERE k.contype = 'f' AND k.confrelid = 'public.items'::regclass`,
    );
    const actual = rows
      .map((row) => ({
        key: `${row.table_name}.${row.columns.slice(1).join(",")}`,
        columns: row.columns,
        referenced: row.referenced,
        action: row.action,
        deferrable: row.deferrable,
        deferred: row.deferred,
      }))
      .sort((a, b) => a.key.localeCompare(b.key));
    const expected = KEYS.map((key) => ({
      key: `${key.table}.${key.column}`,
      columns: ["tenant_id", key.column],
      referenced: ["tenant_id", "id"],
      action: CONFDELTYPE[key.behaviour],
      deferrable: true,
      deferred: true,
    })).sort((a, b) => a.key.localeCompare(b.key));
    expect(actual).toEqual(expected);
  });

  it("index every referencing column, leading with it or with (tenant_id, it)", async () => {
    const { rows } = await adminPool.query<{ table_name: string; leading: string[] }>(
      `SELECT c.relname::text AS table_name,
              ARRAY(SELECT a.attname::text FROM unnest(i.indkey::int2[]) WITH ORDINALITY u(attnum, ord)
                      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = u.attnum
                     WHERE u.ord <= 2 ORDER BY u.ord) AS leading
         FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid
        WHERE c.relnamespace = 'public'::regnamespace`,
    );
    const unindexed = KEYS.filter(
      (key) =>
        !rows.some(
          (row) =>
            row.table_name === key.table &&
            (row.leading[0] === key.column || (row.leading[0] === "tenant_id" && row.leading[1] === key.column)),
        ),
    ).map((key) => `${key.table}.${key.column}`);
    expect(unindexed).toEqual([]);
  });

  describe.each(KEYS)("$table $column ($behaviour)", (key) => {
    it("accepts the tenant's own item and refuses another tenant's exactly like a random id", async () => {
      const own = await itemWithDependent(tenantB, sharedB, key);
      expect(await countReferencing(tenantB, key, own)).toBe(1);

      const foreign = await inTenant(tenantA, (client) => newItem(client, sharedA));
      const constraint = `${key.table}_${key.column}_tenant_fkey`;
      const before = await countRows(tenantB, key.table);
      const attempt = (itemId: string) =>
        inTenant(tenantB, (client) => key.insert(client, itemId, sharedB, () => newItem(client, sharedB)));
      await expect(attempt(foreign)).rejects.toMatchObject({ code: "23503", constraint });
      await expect(attempt(randomUUID())).rejects.toMatchObject({ code: "23503", constraint });
      expect(await countRows(tenantB, key.table)).toBe(before);
    });

    if (key.behaviour === "cascade") {
      it("removes the dependent row with its item and keeps the other items' rows", async () => {
        const doomed = await itemWithDependent(tenantA, sharedA, key);
        const kept = await itemWithDependent(tenantA, sharedA, key);
        await inTenant(tenantA, (client) => deleteItem(client, doomed));
        expect(await countReferencing(tenantA, key, doomed)).toBe(0);
        expect(await countReferencing(tenantA, key, kept)).toBe(1);
      });
    }

    if (key.behaviour === "noAction") {
      it("refuses at commit a delete that would orphan the dependent row, and keeps both", async () => {
        const itemId = await itemWithDependent(tenantA, sharedA, key);
        await expect(inTenant(tenantA, (client) => deleteItem(client, itemId))).rejects.toMatchObject({
          code: "23503",
          constraint: `${key.table}_${key.column}_tenant_fkey`,
        });
        expect(await countReferencing(tenantA, key, itemId)).toBe(1);
        expect(await countReferencing(tenantA, { table: "items", column: "id" }, itemId)).toBe(1);
      });

      it("lets a transaction delete the item before the dependent row", async () => {
        const itemId = await itemWithDependent(tenantA, sharedA, key);
        await inTenant(tenantA, async (client) => {
          await deleteItem(client, itemId);
          // `key.table` and `key.column` come from the closed `KEYS` list.
          await client.query(`DELETE FROM ${key.table} WHERE ${key.column} = $1`, [itemId]);
        });
        expect(await countReferencing(tenantA, key, itemId)).toBe(0);
      });
    }

    if (key.behaviour === "setNull") {
      it("keeps the dependent row with the reference cleared when its item goes", async () => {
        const itemId = await itemWithDependent(tenantA, sharedA, key);
        const before = await countRows(tenantA, key.table);
        await inTenant(tenantA, (client) => deleteItem(client, itemId));
        expect(await countReferencing(tenantA, key, itemId)).toBe(0);
        expect(await countRows(tenantA, key.table)).toBe(before);
      });
    }
  });

  it("keeps a problem raised for a project, without the project, once the project is gone", async () => {
    const { projectId, problemId } = await runInTenant(tenantA, () =>
      inTenant(tenantA, async (client) => {
        const projects = await createDatabase(client, {
          key: PROJECTS_MODULE_ID,
          name: "Projects",
          ownerModuleId: PROJECTS_MODULE_ID,
          system: true,
        });
        const project = await insertItem(client, { databaseId: projects.id, properties: {} });
        const problem = await raiseProblem(client, {
          userId: sharedA.userId,
          category: "agents",
          kind: "agentRun",
          severity: "warning",
          sourceTable: "agent_runs",
          sourceId: randomUUID(),
          dedupeKey: "fk-set-null-probe",
          projectItemId: project.id,
        });
        return { projectId: project.id, problemId: problem.problemId };
      }),
    );
    const read = () =>
      inTenant(tenantA, (client) =>
        client.query<{ project_item_id: string | null; dedupe_key: string }>(
          "SELECT project_item_id, dedupe_key FROM semp_problems WHERE id = $1",
          [problemId],
        ),
      );
    expect((await read()).rows).toEqual([{ project_item_id: projectId, dedupe_key: "fk-set-null-probe" }]);
    await inTenant(tenantA, (client) => deleteItem(client, projectId));
    expect((await read()).rows).toEqual([{ project_item_id: null, dedupe_key: "fk-set-null-probe" }]);
  });

  it("deletes a database with its items and their derived rows, and refuses one whose item still has a domain dependent", async () => {
    const cascadeKeys = KEYS.filter((key) => key.behaviour === "cascade");
    const { databaseId, itemIds } = await inTenant(tenantA, async (client) => {
      const database = await createDatabase(client, { name: "Doomed" });
      const own: Shared = { ...sharedA, databaseId: database.id };
      const ids: string[] = [];
      for (const key of cascadeKeys) {
        const itemId = await newItem(client, own);
        await key.insert(client, itemId, own, () => newItem(client, own));
        ids.push(itemId);
      }
      return { databaseId: database.id, itemIds: ids };
    });

    await inTenant(tenantA, (client) => deleteDatabaseWithItems(client, databaseId));

    expect(
      await inTenant(tenantA, (client) => client.query("SELECT 1 FROM databases WHERE id = $1", [databaseId])),
    ).toMatchObject({ rowCount: 0 });
    expect(
      await inTenant(tenantA, (client) => client.query("SELECT 1 FROM items WHERE database_id = $1", [databaseId])),
    ).toMatchObject({ rowCount: 0 });
    for (const [index, key] of cascadeKeys.entries()) {
      expect(await countReferencing(tenantA, key, itemIds[index]!), `${key.table}.${key.column}`).toBe(0);
    }

    const guarded = KEYS.find((key) => key.table === "inbox_attachments")!;
    const blocked = await inTenant(tenantA, async (client) => {
      const database = await createDatabase(client, { name: "Guarded" });
      const own: Shared = { ...sharedA, databaseId: database.id };
      const itemId = await newItem(client, own);
      await guarded.insert(client, itemId, own, () => newItem(client, own));
      return { databaseId: database.id, itemId };
    });
    await expect(
      inTenant(tenantA, (client) => deleteDatabaseWithItems(client, blocked.databaseId)),
    ).rejects.toMatchObject({ code: "23503", constraint: "inbox_attachments_inbox_item_id_tenant_fkey" });
    expect(await countReferencing(tenantA, guarded, blocked.itemId)).toBe(1);
    expect(await countReferencing(tenantA, { table: "items", column: "database_id" }, blocked.databaseId)).toBe(1);
  });

  it("answers another tenant's item id with the same not-found as an unknown one", async () => {
    const chokePoint = createChokePoint(pool);
    const foreign = await inTenant(tenantA, (client) => newItem(client, sharedA));
    const unknown = randomUUID();
    const add = (itemId: string) =>
      runInTenant(tenantB, () =>
        chokePoint.addViewItem({ viewId: sharedB.curatedViewId, itemId, position: 0, actor: { type: "user" } }),
      ).then(
        () => {
          throw new Error("addViewItem accepted the item");
        },
        (error: unknown) => {
          if (!(error instanceof Error)) throw error;
          const shape: Record<string, unknown> = { ...error };
          return { name: error.name, message: error.message.replace(itemId, "<id>"), ...shape };
        },
      );
    const whileForeign = await add(foreign);
    const whileUnknown = await add(unknown);
    expect(whileForeign).toMatchObject({ name: "NotFoundError" });
    expect(whileForeign).toEqual(whileUnknown);
    expect(await countRows(tenantB, "view_items")).toBe(0);
  });
});
