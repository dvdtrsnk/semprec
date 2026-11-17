import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTestPool,
  insertItemsWithIds,
  resetDatabase,
  withTenantTransaction,
} from "../testSupport/testDb.js";
import { withTransaction } from "../db/pool.js";
import {
  deleteValueLinkSourcesBySourceItem,
  insertValueLink,
  listValueLinkSourcesByLinkIds,
  listValueLinksByItemIds,
  listValueLinksBySourceItem,
  moveValueLinkItemSources,
} from "../chokePoint/valueLinksStore.js";

let pool: Pool;

async function countRows(table: "value_links" | "value_link_sources"): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
  return Number(rows[0]?.n);
}

/** Items with exactly these ids in tenant zero, since a value link and an item source must name an existing item. */
async function seedItems(...ids: string[]): Promise<void> {
  await withTransaction(pool, (client) => insertItemsWithIds(client, ids));
}

/** The same in another tenant, through the runtime pool the test writes with. */
async function seedTenantItems(runtimePool: Pool, tenant: string, ...ids: string[]): Promise<void> {
  await withTenantTransaction(runtimePool, tenant, (client) => insertItemsWithIds(client, ids));
}

describe("value links store (issue #1403)", () => {
  beforeAll(() => {
    pool = getTestPool();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("inserts a link with several sources and lists both back in one query each", async () => {
    const itemId = randomUUID();
    const sourceA = randomUUID();
    const sourceB = randomUUID();
    await seedItems(itemId, sourceA, sourceB);
    const inserted = await withTransaction(pool, (client) =>
      insertValueLink(client, {
        itemId,
        propertyKey: "company",
        ruleKey: "fileCompany",
        sources: [
          { kind: "item", sourceItemId: sourceA, sourcePropertyKey: "company" },
          { kind: "item", sourceItemId: sourceB, sourcePropertyKey: "company" },
        ],
      }),
    );
    expect(inserted.link).toMatchObject({
      itemId,
      propertyKey: "company",
      state: "on",
      brokenBy: null,
      brokenAt: null,
    });

    const links = await withTransaction(pool, (client) => listValueLinksByItemIds(client, [itemId, randomUUID()]));
    expect(links).toEqual([inserted.link]);
    const sources = await withTransaction(pool, (client) => listValueLinkSourcesByLinkIds(client, [inserted.link.id]));
    expect(sources.map((source) => (source.kind === "item" ? source.sourceItemId : null)).sort()).toEqual(
      [sourceA, sourceB].sort(),
    );
  });

  it("returns nothing for an empty id list without querying", async () => {
    await withTransaction(pool, async (client) => {
      expect(await listValueLinksByItemIds(client, [])).toEqual([]);
      expect(await listValueLinkSourcesByLinkIds(client, [])).toEqual([]);
    });
  });

  it("allows one link per item and property key", async () => {
    const itemId = randomUUID();
    await seedItems(itemId);
    const input = { itemId, propertyKey: "projects", ruleKey: "r", sources: [] };
    await withTransaction(pool, (client) => insertValueLink(client, input));
    await expect(withTransaction(pool, (client) => insertValueLink(client, input))).rejects.toMatchObject({
      code: "23505",
      constraint: "value_links_tenant_item_property_uq",
    });
    expect(await countRows("value_links")).toBe(1);
  });

  it("rejects a state that does not match broken_by and broken_at", async () => {
    const base = { itemId: randomUUID(), propertyKey: "projects", ruleKey: "r", sources: [] };
    await expect(
      withTransaction(pool, (client) => insertValueLink(client, { ...base, state: "broken" })),
    ).rejects.toMatchObject({ code: "23514", constraint: "value_links_state_columns_check" });
    await expect(
      withTransaction(pool, (client) =>
        insertValueLink(client, { ...base, state: "on", brokenBy: "user", brokenAt: new Date() }),
      ),
    ).rejects.toMatchObject({ code: "23514", constraint: "value_links_state_columns_check" });
    expect(await countRows("value_links")).toBe(0);
  });

  it("rejects a source whose columns do not match its kind", async () => {
    const itemId = randomUUID();
    const existingSource = randomUUID();
    await seedItems(itemId, existingSource);
    // Raw SQL: the store cannot write a link whose sources break the kind check this test provokes.
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO value_links (item_id, property_key, rule_key) VALUES ($1, 'p', 'r') RETURNING id`,
      [itemId],
    );
    const linkId = rows[0]?.id;
    for (const [kind, sourceItemId, domain] of [
      ["item", null, null],
      ["item", existingSource, "example.com"],
      ["senderDomain", null, null],
      ["senderDomain", existingSource, "example.com"],
    ] as const) {
      await expect(
        pool.query(
          `INSERT INTO value_link_sources (link_id, source_kind, source_item_id, source_property_key, domain)
           VALUES ($1, $2, $3, 'p', $4)`,
          [linkId, kind, sourceItemId, domain],
        ),
        `${kind} ${sourceItemId} ${domain}`,
      ).rejects.toMatchObject({ code: "23514", constraint: "value_link_sources_kind_columns_check" });
    }
    expect(await countRows("value_link_sources")).toBe(0);
  });

  it("refuses the same source listed twice for one link, per kind", async () => {
    const [itemId, sourceItemId] = [randomUUID(), randomUUID()];
    await seedItems(itemId, sourceItemId);
    await expect(
      withTransaction(pool, (client) =>
        insertValueLink(client, {
          itemId,
          propertyKey: "p",
          ruleKey: "r",
          sources: [
            { kind: "item", sourceItemId, sourcePropertyKey: "p" },
            { kind: "item", sourceItemId, sourcePropertyKey: "p" },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: "23505", constraint: "value_link_sources_item_uq" });
    await expect(
      withTransaction(pool, (client) =>
        insertValueLink(client, {
          itemId,
          propertyKey: "p",
          ruleKey: "r",
          sources: [
            { kind: "senderDomain", domain: "example.com", sourcePropertyKey: "p" },
            { kind: "senderDomain", domain: "example.com", sourcePropertyKey: "p" },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: "23505", constraint: "value_link_sources_domain_uq" });
    expect(await countRows("value_links")).toBe(0);
  });

  it("deletes a link's sources with the link", async () => {
    const itemId = randomUUID();
    await seedItems(itemId);
    const inserted = await withTransaction(pool, (client) =>
      insertValueLink(client, {
        itemId,
        propertyKey: "p",
        ruleKey: "r",
        sources: [{ kind: "senderDomain", domain: "example.com", sourcePropertyKey: "p" }],
      }),
    );
    expect(await countRows("value_link_sources")).toBe(1);
    await pool.query(`DELETE FROM value_links WHERE id = $1`, [inserted.link.id]);
    expect(await countRows("value_link_sources")).toBe(0);
  });

  it("lets two tenants hold a link on the same property key, each seeing only its own", async () => {
    const adminPool = pool;
    const runtimePool = await createRuntimeRolePool(adminPool, "semprec_data");
    try {
      const tenantA = await createTestTenant(adminPool);
      const tenantB = await createTestTenant(adminPool);
      // Item ids are unique across tenants and a link must name an item of its own tenant, so each tenant has one.
      const [itemA, itemB] = [randomUUID(), randomUUID()];
      await seedTenantItems(runtimePool, tenantA, itemA);
      await seedTenantItems(runtimePool, tenantB, itemB);
      const input = { propertyKey: "p", ruleKey: "r", sources: [] };
      const linkA = await withTenantTransaction(runtimePool, tenantA, (client) =>
        insertValueLink(client, { ...input, itemId: itemA }),
      );
      const linkB = await withTenantTransaction(runtimePool, tenantB, (client) =>
        insertValueLink(client, { ...input, itemId: itemB }),
      );

      const seenByA = await withTenantTransaction(runtimePool, tenantA, (client) =>
        listValueLinksByItemIds(client, [itemA, itemB]),
      );
      const seenByB = await withTenantTransaction(runtimePool, tenantB, (client) =>
        listValueLinksByItemIds(client, [itemA, itemB]),
      );
      expect(seenByA.map((link) => link.id)).toEqual([linkA.link.id]);
      expect(seenByB.map((link) => link.id)).toEqual([linkB.link.id]);
    } finally {
      await runtimePool.end();
    }
  });

  it("moves a source item's sources to another item, merges a duplicate and touches nothing else (issue #1673)", async () => {
    const adminPool = pool;
    const runtimePool = await createRuntimeRolePool(adminPool, "semprec_data");
    try {
      const tenantA = await createTestTenant(adminPool);
      const tenantB = await createTestTenant(adminPool);
      const [from, to, unrelated] = [randomUUID(), randomUUID(), randomUUID()];
      // A source must be an item of the link's tenant, so tenant B's link names its own item, not `from`.
      const foreignFrom = randomUUID();
      await seedTenantItems(runtimePool, tenantA, from, to, unrelated);
      await seedTenantItems(runtimePool, tenantB, foreignFrom);
      const source = (sourceItemId: string, sourcePropertyKey = "project") =>
        ({ kind: "item", sourceItemId, sourcePropertyKey }) as const;
      const insert = async (tenant: string, sources: ReturnType<typeof source>[]) => {
        const itemId = randomUUID();
        await seedTenantItems(runtimePool, tenant, itemId);
        return withTenantTransaction(runtimePool, tenant, (client) =>
          insertValueLink(client, { itemId, propertyKey: "projects", ruleKey: "r", sources }),
        );
      };
      const moved = await insert(tenantA, [source(from), source(from, "company")]);
      const merged = await insert(tenantA, [source(from), source(to)]);
      const untouched = await insert(tenantA, [source(unrelated)]);
      const foreign = await insert(tenantB, [source(foreignFrom)]);

      const count = await withTenantTransaction(runtimePool, tenantA, (client) =>
        moveValueLinkItemSources(client, from, to),
      );
      expect(count).toBe(3);
      const sourcesOf = (tenant: string, linkId: string) =>
        withTenantTransaction(runtimePool, tenant, async (client) =>
          (await listValueLinkSourcesByLinkIds(client, [linkId]))
            .map((row) => (row.kind === "item" ? `${row.sourceItemId} ${row.sourcePropertyKey}` : row.domain))
            .sort(),
        );
      expect(await sourcesOf(tenantA, moved.link.id)).toEqual([`${to} company`, `${to} project`].sort());
      expect(await sourcesOf(tenantA, merged.link.id)).toEqual([`${to} project`]);
      expect(await sourcesOf(tenantA, untouched.link.id)).toEqual([`${unrelated} project`]);
      expect(await sourcesOf(tenantB, foreign.link.id)).toEqual([`${foreignFrom} project`]);
      expect(
        await withTenantTransaction(runtimePool, tenantA, (client) => moveValueLinkItemSources(client, from, to)),
      ).toBe(0);
      // Tenant B's source is invisible to tenant A, so moving it from tenant A touches nothing.
      expect(
        await withTenantTransaction(runtimePool, tenantA, (client) =>
          moveValueLinkItemSources(client, foreignFrom, to),
        ),
      ).toBe(0);
      expect(await sourcesOf(tenantB, foreign.link.id)).toEqual([`${foreignFrom} project`]);
    } finally {
      await runtimePool.end();
    }
  });

  it("moves only the links of one rule when a rule key is given, and leaves the links of other rules on the source item (issue gh-1898)", async () => {
    const adminPool = pool;
    const runtimePool = await createRuntimeRolePool(adminPool, "semprec_data");
    try {
      const tenantA = await createTestTenant(adminPool);
      const [from, to] = [randomUUID(), randomUUID()];
      await seedTenantItems(runtimePool, tenantA, from, to);
      const insert = async (ruleKey: string) => {
        const itemId = randomUUID();
        await seedTenantItems(runtimePool, tenantA, itemId);
        return withTenantTransaction(runtimePool, tenantA, (client) =>
          insertValueLink(client, {
            itemId,
            propertyKey: "projects",
            ruleKey,
            sources: [{ kind: "item", sourceItemId: from, sourcePropertyKey: "project" }],
          }),
        );
      };
      const ofRule = await insert("ruleOne");
      const ofOtherRule = await insert("ruleTwo");
      const sourceItemOf = (linkId: string) =>
        withTenantTransaction(runtimePool, tenantA, async (client) =>
          (await listValueLinkSourcesByLinkIds(client, [linkId])).map((row) =>
            row.kind === "item" ? row.sourceItemId : row.domain,
          ),
        );

      const count = await withTenantTransaction(runtimePool, tenantA, (client) =>
        moveValueLinkItemSources(client, from, to, { ruleKey: "ruleOne" }),
      );

      expect(count).toBe(1);
      expect(await sourceItemOf(ofRule.link.id)).toEqual([to]);
      expect(await sourceItemOf(ofOtherRule.link.id)).toEqual([from]);
      expect(
        await withTenantTransaction(runtimePool, tenantA, (client) =>
          moveValueLinkItemSources(client, from, to, { ruleKey: "ruleOne" }),
        ),
      ).toBe(0);
    } finally {
      await runtimePool.end();
    }
  });

  it("lists the links of any state that name an item as a source, once each, and not those of another tenant (issue #1856)", async () => {
    const adminPool = pool;
    const runtimePool = await createRuntimeRolePool(adminPool, "semprec_data");
    try {
      const tenantA = await createTestTenant(adminPool);
      const tenantB = await createTestTenant(adminPool);
      const source = randomUUID();
      const other = randomUUID();
      const holderOn = randomUUID();
      const holderBroken = randomUUID();
      const holderTwice = randomUUID();
      const holderOther = randomUUID();
      const domainOnly = randomUUID();
      // A source must be an item of the link's tenant, so tenant B's link names its own item, not `source`.
      const [foreignHolder, foreignSource] = [randomUUID(), randomUUID()];
      await seedTenantItems(
        runtimePool,
        tenantA,
        source,
        other,
        holderOn,
        holderBroken,
        holderTwice,
        holderOther,
        domainOnly,
      );
      await seedTenantItems(runtimePool, tenantB, foreignHolder, foreignSource);
      const itemSource = (sourceItemId: string, sourcePropertyKey = "project") =>
        ({ kind: "item", sourceItemId, sourcePropertyKey }) as const;
      const insert = (tenant: string, itemId: string, input: Partial<Parameters<typeof insertValueLink>[1]>) =>
        withTenantTransaction(runtimePool, tenant, (client) =>
          insertValueLink(client, { itemId, propertyKey: "projects", ruleKey: "r", sources: [], ...input }),
        );
      await insert(tenantA, holderOn, { sources: [itemSource(source)] });
      await insert(tenantA, holderBroken, {
        state: "broken",
        brokenBy: "user",
        brokenAt: new Date("2026-10-20T10:00:00.000Z"),
        sources: [itemSource(source)],
      });
      await insert(tenantA, holderTwice, { sources: [itemSource(source), itemSource(source, "company")] });
      await insert(tenantA, holderOther, { sources: [itemSource(other)] });
      await insert(tenantA, domainOnly, {
        sources: [{ kind: "senderDomain", domain: "example.com", sourcePropertyKey: "x" }],
      });
      await insert(tenantB, foreignHolder, { sources: [itemSource(foreignSource)] });

      const listed = await withTenantTransaction(runtimePool, tenantA, (client) =>
        listValueLinksBySourceItem(client, source),
      );

      expect(listed.map((link) => link.itemId).sort()).toEqual([holderOn, holderBroken, holderTwice].sort());
      expect(listed.find((link) => link.itemId === holderBroken)?.state).toBe("broken");
      expect(
        await withTenantTransaction(runtimePool, tenantA, (client) => listValueLinksBySourceItem(client, randomUUID())),
      ).toEqual([]);
      // Tenant B's link to its own source exists, but tenant A sees it as no link at all.
      expect(
        await withTenantTransaction(runtimePool, tenantA, (client) =>
          listValueLinksBySourceItem(client, foreignSource),
        ),
      ).toEqual([]);
      expect(
        (
          await withTenantTransaction(runtimePool, tenantB, (client) =>
            listValueLinksBySourceItem(client, foreignSource),
          )
        ).map((link) => link.itemId),
      ).toEqual([foreignHolder]);
    } finally {
      await runtimePool.end();
    }
  });

  describe("the order the source detach locks and returns the links in", () => {
    /** Link ids are rewritten so link-id order differs from item and rule order; within an item `people` sorts first. */
    async function seedDetach(runtimePool: Pool, tenant: string) {
      const [itemOne, itemTwo] = [randomUUID(), randomUUID()].sort();
      if (!itemOne || !itemTwo) throw new Error("Two item ids are expected");
      const event = randomUUID();
      await seedTenantItems(runtimePool, tenant, itemOne, itemTwo, event);
      const insert = (itemId: string, propertyKey: string, ruleKey: string) =>
        withTenantTransaction(runtimePool, tenant, (client) =>
          insertValueLink(client, {
            itemId,
            propertyKey,
            ruleKey,
            sources: [{ kind: "item", sourceItemId: event, sourcePropertyKey: propertyKey }],
          }),
        );
      const generated = {
        oneProject: (await insert(itemOne, "project", "ruleProject")).link.id,
        onePeople: (await insert(itemOne, "people", "rulePeople")).link.id,
        twoProject: (await insert(itemTwo, "project", "ruleProject")).link.id,
        twoPeople: (await insert(itemTwo, "people", "rulePeople")).link.id,
      };
      const ids = {
        oneProject: "00000000-0000-4000-8000-000000000004",
        onePeople: "00000000-0000-4000-8000-000000000002",
        twoProject: "00000000-0000-4000-8000-000000000003",
        twoPeople: "00000000-0000-4000-8000-000000000001",
      };
      // Raw SQL: the store generates link ids. Rewritten with foreign keys off in both tables (no ON UPDATE CASCADE).
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL session_replication_role = replica");
        for (const name of Object.keys(ids) as Array<keyof typeof ids>) {
          await client.query("UPDATE value_links SET id = $2 WHERE id = $1", [generated[name], ids[name]]);
          await client.query("UPDATE value_link_sources SET link_id = $2 WHERE link_id = $1", [
            generated[name],
            ids[name],
          ]);
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      return { event, itemOne, itemTwo, ids };
    }

    async function detach(ruleKeyOrder?: readonly string[]) {
      const runtimePool = await createRuntimeRolePool(pool, "semprec_data");
      try {
        const tenant = await createTestTenant(pool);
        const seeded = await seedDetach(runtimePool, tenant);
        const result = await withTenantTransaction(runtimePool, tenant, (client) =>
          ruleKeyOrder === undefined
            ? deleteValueLinkSourcesBySourceItem(client, seeded.event)
            : deleteValueLinkSourcesBySourceItem(client, seeded.event, ruleKeyOrder),
        );
        const left = await withTenantTransaction(runtimePool, tenant, (client) =>
          client.query<{ n: string }>("SELECT count(*)::text AS n FROM value_link_sources WHERE source_item_id = $1", [
            seeded.event,
          ]),
        );
        return { seeded, result, sourcesLeft: Number(left.rows[0]?.n) };
      } finally {
        await runtimePool.end();
      }
    }

    it("locks and returns the links by item id, the position of the rule and the link id", async () => {
      const { seeded, result, sourcesLeft } = await detach(["ruleProject", "rulePeople"]);

      expect(result).toEqual([
        { linkId: seeded.ids.oneProject, itemId: seeded.itemOne },
        { linkId: seeded.ids.onePeople, itemId: seeded.itemOne },
        { linkId: seeded.ids.twoProject, itemId: seeded.itemTwo },
        { linkId: seeded.ids.twoPeople, itemId: seeded.itemTwo },
      ]);
      expect(sourcesLeft).toBe(0);
    });

    it("orders by item id and link id when the rule order is empty or not given", async () => {
      for (const order of [[], undefined]) {
        await resetDatabase(pool);
        const { seeded, result } = await detach(order);

        expect(result, String(order)).toEqual([
          { linkId: seeded.ids.onePeople, itemId: seeded.itemOne },
          { linkId: seeded.ids.oneProject, itemId: seeded.itemOne },
          { linkId: seeded.ids.twoPeople, itemId: seeded.itemTwo },
          { linkId: seeded.ids.twoProject, itemId: seeded.itemTwo },
        ]);
      }
    });

    it("sorts the links of a rule the order does not name after those it names, by link id", async () => {
      const { seeded, result } = await detach(["ruleProject"]);

      expect(result).toEqual([
        { linkId: seeded.ids.oneProject, itemId: seeded.itemOne },
        { linkId: seeded.ids.onePeople, itemId: seeded.itemOne },
        { linkId: seeded.ids.twoProject, itemId: seeded.itemTwo },
        { linkId: seeded.ids.twoPeople, itemId: seeded.itemTwo },
      ]);
    });

    it("returns nothing for an item that no link names as a source", async () => {
      const runtimePool = await createRuntimeRolePool(pool, "semprec_data");
      try {
        const tenant = await createTestTenant(pool);
        expect(
          await withTenantTransaction(runtimePool, tenant, (client) =>
            deleteValueLinkSourcesBySourceItem(client, randomUUID(), ["ruleProject"]),
          ),
        ).toEqual([]);
      } finally {
        await runtimePool.end();
      }
    });
  });
});
