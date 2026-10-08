import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { getTenantZeroId, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createDatabase } from "../chokePoint/databasesStore.js";
import {
  findItemsDeletedBefore,
  getItemsByIds,
  getItemsByIdsIncludingDeleted,
  insertItem,
  softDeleteItem,
} from "../chokePoint/itemsStore.js";

let pool: Pool;

type Lookup = (client: PoolClient) => Promise<{ id: string; databaseId: string }[]>;

interface RecordedStatement {
  text: string;
  values: unknown[];
}

/** Runs `fn` in a transaction on the owner role that is always rolled back. */
async function inRolledBackTransaction(fn: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await fn(client);
  } finally {
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  }
}

async function scopeTo(client: PoolClient, tenantId: string): Promise<void> {
  await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
}

async function addTenant(client: PoolClient): Promise<string> {
  const { rows } = await client.query<{ id: string }>("INSERT INTO tenants (status) VALUES ('active') RETURNING id");
  const id = rows[0]?.id;
  if (!id) throw new Error("tenant was not inserted");
  return id;
}

function partitionName(databaseId: string): string {
  return `items_p_${databaseId.replaceAll("-", "")}`;
}

/** Wraps `client` so the last statement reading `items` is recorded, then forwards every call. */
function recordItemsStatements(client: PoolClient, sink: RecordedStatement[]): PoolClient {
  return new Proxy(client, {
    get(target, prop) {
      if (prop !== "query") return Reflect.get(target, prop, target) as unknown;
      return (text: unknown, values?: unknown[]) => {
        if (typeof text === "string" && /FROM items\b/.test(text)) sink.push({ text, values: values ?? [] });
        return (target.query as (...args: unknown[]) => unknown)(text, values);
      };
    },
  });
}

interface PlanNode {
  "Relation Name"?: string;
  "One-Time Filter"?: string;
  Plans?: PlanNode[];
}

function walkPlan(node: PlanNode, visit: (node: PlanNode) => void): void {
  visit(node);
  for (const child of node.Plans ?? []) walkPlan(child, visit);
}

/** Runs `lookup`, then EXPLAINs the `items` statement it sent. */
async function explainLookup(
  client: PoolClient,
  lookup: Lookup,
): Promise<{ relations: string[]; falseFilter: boolean; rows: { id: string; databaseId: string }[] }> {
  const sent: RecordedStatement[] = [];
  const rows = await lookup(recordItemsStatements(client, sent));
  const statement = sent.at(-1);
  if (!statement) throw new Error("lookup sent no statement against items");
  const { rows: planRows } = await client.query<{ "QUERY PLAN": { Plan: PlanNode }[] }>(
    `EXPLAIN (FORMAT JSON) ${statement.text}`,
    statement.values,
  );
  const root = planRows[0]?.["QUERY PLAN"][0]?.Plan;
  if (!root) throw new Error("EXPLAIN returned no plan");
  const relations: string[] = [];
  let falseFilter = false;
  walkPlan(root, (node) => {
    if (node["Relation Name"]) relations.push(node["Relation Name"]);
    if (node["One-Time Filter"] === "false") falseFilter = true;
  });
  return { relations, falseFilter, rows };
}

interface Fixture {
  tenantB: string;
  tenantEmpty: string;
  dbZero: string;
  dbB: string;
  liveZero: string;
  liveB: string;
  trashedZero: string;
  trashedB: string[];
}

async function seed(client: PoolClient): Promise<Fixture> {
  await client.query("DROP INDEX IF EXISTS tenants_single_tenant_guard");
  const tenantB = await addTenant(client);
  const tenantEmpty = await addTenant(client);

  await scopeTo(client, getTenantZeroId());
  const dbZero = await createDatabase(client, { name: "Zero" });
  const liveZero = await insertItem(client, { databaseId: dbZero.id, properties: {} });
  const trashedZero = await insertItem(client, { databaseId: dbZero.id, properties: {} });
  await softDeleteItem(client, dbZero.id, trashedZero.id);

  await scopeTo(client, tenantB);
  const dbB = await createDatabase(client, { name: "B" });
  const liveB = await insertItem(client, { databaseId: dbB.id, properties: {} });
  const trashedB: string[] = [];
  for (let i = 0; i < 3; i++) {
    const item = await insertItem(client, { databaseId: dbB.id, properties: {} });
    await softDeleteItem(client, dbB.id, item.id);
    trashedB.push(item.id);
  }

  await client.query("UPDATE items SET deleted_at = now() - interval '40 days' WHERE deleted_at IS NOT NULL");
  return {
    tenantB,
    tenantEmpty,
    dbZero: dbZero.id,
    dbB: dbB.id,
    liveZero: liveZero.id,
    liveB: liveB.id,
    trashedZero: trashedZero.id,
    trashedB,
  };
}

const cutoff = (): Date => new Date(Date.now() - 24 * 3600 * 1000);

describe("id-only item lookups are pruned to the tenant's partitions", () => {
  beforeAll(async () => {
    pool = getTestPool();
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  function lookups(fx: Fixture): Record<string, Lookup> {
    return {
      getItemsByIds: (c) => getItemsByIds(c, [fx.liveB, fx.liveZero]),
      getItemsByIdsIncludingDeleted: (c) => getItemsByIdsIncludingDeleted(c, [fx.liveB, fx.liveZero]),
      findItemsDeletedBefore: (c) => findItemsDeletedBefore(c, cutoff()),
    };
  }

  it("plans only the scoped tenant's partitions and never returns another tenant's rows", async () => {
    await inRolledBackTransaction(async (client) => {
      const fx = await seed(client);
      await scopeTo(client, fx.tenantB);
      await client.query("SET LOCAL ROLE semprec_data");

      for (const [name, lookup] of Object.entries(lookups(fx))) {
        const { relations, rows } = await explainLookup(client, lookup);
        expect(relations.length, name).toBeGreaterThan(0);
        expect(new Set(relations), name).toEqual(new Set([partitionName(fx.dbB)]));
        expect(relations, name).not.toContain(partitionName(fx.dbZero));
        expect(
          rows.every((row) => row.databaseId === fx.dbB),
          name,
        ).toBe(true);
      }
    });
  });

  it("resolves only the scoped tenant's item when given one id of each tenant", async () => {
    await inRolledBackTransaction(async (client) => {
      const fx = await seed(client);
      await scopeTo(client, fx.tenantB);
      await client.query("SET LOCAL ROLE semprec_data");

      expect((await getItemsByIds(client, [fx.liveB, fx.liveZero])).map((row) => row.id)).toEqual([fx.liveB]);
      expect(
        (await getItemsByIdsIncludingDeleted(client, [fx.trashedB[0] as string, fx.trashedZero])).map((row) => row.id),
      ).toEqual([fx.trashedB[0]]);
    });
  });

  it("pages findItemsDeletedBefore in (database_id, id) order within the tenant", async () => {
    await inRolledBackTransaction(async (client) => {
      const fx = await seed(client);
      await scopeTo(client, fx.tenantB);
      await client.query("SET LOCAL ROLE semprec_data");

      const all = await findItemsDeletedBefore(client, cutoff());
      expect(all.map((row) => row.id)).toEqual([...fx.trashedB].sort());
      expect(all.every((row) => row.databaseId === fx.dbB)).toBe(true);

      const first = await findItemsDeletedBefore(client, cutoff(), undefined, 2);
      expect(first.map((row) => row.id)).toEqual(all.slice(0, 2).map((row) => row.id));
      const last = first.at(-1);
      if (!last) throw new Error("first page was empty");
      const second = await findItemsDeletedBefore(client, cutoff(), { databaseId: last.databaseId, id: last.id }, 2);
      expect(second.map((row) => row.id)).toEqual(all.slice(2).map((row) => row.id));
    });
  });

  it("returns [] with a One-Time Filter: false plan and no partition for a tenant with no databases", async () => {
    await inRolledBackTransaction(async (client) => {
      const fx = await seed(client);
      await scopeTo(client, fx.tenantEmpty);
      await client.query("SET LOCAL ROLE semprec_data");

      for (const [name, lookup] of Object.entries(lookups(fx))) {
        const { relations, falseFilter, rows } = await explainLookup(client, lookup);
        expect(rows, name).toEqual([]);
        expect(relations, name).toEqual([]);
        expect(falseFilter, name).toBe(true);
      }
    });
  });

  it("behaves as before for a single tenant without a scope", async () => {
    await resetDatabase(pool);
    const client = await pool.connect();
    try {
      const db = await createDatabase(client, { name: "Solo" });
      const live = await insertItem(client, { databaseId: db.id, properties: {} });
      const trashed = await insertItem(client, { databaseId: db.id, properties: {} });
      await softDeleteItem(client, db.id, trashed.id);
      await client.query("UPDATE items SET deleted_at = now() - interval '40 days' WHERE id = $1", [trashed.id]);

      expect((await getItemsByIds(client, [live.id, trashed.id])).map((row) => row.id)).toEqual([live.id]);
      expect((await getItemsByIdsIncludingDeleted(client, [live.id, trashed.id])).map((row) => row.id).sort()).toEqual(
        [live.id, trashed.id].sort(),
      );
      expect((await findItemsDeletedBefore(client, cutoff())).map((row) => row.id)).toEqual([trashed.id]);
    } finally {
      client.release();
    }
  });

  it("returns [] without querying for empty id lists", async () => {
    const sent: string[] = [];
    const fake = {
      query: (text: string) => {
        sent.push(text);
        return Promise.reject(new Error("must not query"));
      },
    } as unknown as PoolClient;
    expect(await getItemsByIds(fake, [])).toEqual([]);
    expect(await getItemsByIdsIncludingDeleted(fake, [])).toEqual([]);
    expect(sent).toEqual([]);
  });
});
