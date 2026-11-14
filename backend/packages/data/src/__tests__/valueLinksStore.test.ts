import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "../testSupport/testDb.js";
import { withTransaction } from "../db/pool.js";
import {
  insertValueLink,
  listValueLinkSourcesByLinkIds,
  listValueLinksByItemIds,
  listValueLinksBySourceItem,
  moveValueLinkItemSources,
} from "../chokePoint/valueLinksStore.js";

/** Issue #1403: the two tables' constraints and the store's batched lists. */
let pool: Pool;

async function countRows(table: "value_links" | "value_link_sources"): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
  return Number(rows[0]?.n);
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
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO value_links (item_id, property_key, rule_key) VALUES ($1, 'p', 'r') RETURNING id`,
      [randomUUID()],
    );
    const linkId = rows[0]?.id;
    for (const [kind, sourceItemId, domain] of [
      ["item", null, null],
      ["item", randomUUID(), "example.com"],
      ["senderDomain", null, null],
      ["senderDomain", randomUUID(), "example.com"],
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
    const sourceItemId = randomUUID();
    await expect(
      withTransaction(pool, (client) =>
        insertValueLink(client, {
          itemId: randomUUID(),
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
          itemId: randomUUID(),
          propertyKey: "p",
          ruleKey: "r",
          sources: [
            { kind: "senderDomain", domain: "example.com", sourcePropertyKey: "p" },
            { kind: "senderDomain", domain: "example.com", sourcePropertyKey: "p" },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: "23505", constraint: "value_link_sources_domain_uq" });
    // Each failed insert ran in one transaction, so no link was left behind without its sources.
    expect(await countRows("value_links")).toBe(0);
  });

  it("deletes a link's sources with the link", async () => {
    const inserted = await withTransaction(pool, (client) =>
      insertValueLink(client, {
        itemId: randomUUID(),
        propertyKey: "p",
        ruleKey: "r",
        sources: [{ kind: "senderDomain", domain: "example.com", sourcePropertyKey: "p" }],
      }),
    );
    expect(await countRows("value_link_sources")).toBe(1);
    await pool.query(`DELETE FROM value_links WHERE id = $1`, [inserted.link.id]);
    expect(await countRows("value_link_sources")).toBe(0);
  });

  it("lets two tenants hold a link on the same item id and property key, each seeing only its own", async () => {
    const adminPool = pool;
    const runtimePool = await createRuntimeRolePool(adminPool, "semprec_data");
    try {
      const tenantA = await createTestTenant(adminPool);
      const tenantB = await createTestTenant(adminPool);
      const itemId = randomUUID();
      const input = { itemId, propertyKey: "p", ruleKey: "r", sources: [] };
      const linkA = await withTenantTransaction(runtimePool, tenantA, (client) => insertValueLink(client, input));
      const linkB = await withTenantTransaction(runtimePool, tenantB, (client) => insertValueLink(client, input));

      const seenByA = await withTenantTransaction(runtimePool, tenantA, (client) =>
        listValueLinksByItemIds(client, [itemId]),
      );
      const seenByB = await withTenantTransaction(runtimePool, tenantB, (client) =>
        listValueLinksByItemIds(client, [itemId]),
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
      const source = (sourceItemId: string, sourcePropertyKey = "project") =>
        ({ kind: "item", sourceItemId, sourcePropertyKey }) as const;
      const insert = (tenant: string, sources: ReturnType<typeof source>[]) =>
        withTenantTransaction(runtimePool, tenant, (client) =>
          insertValueLink(client, { itemId: randomUUID(), propertyKey: "projects", ruleKey: "r", sources }),
        );
      const moved = await insert(tenantA, [source(from), source(from, "company")]);
      const merged = await insert(tenantA, [source(from), source(to)]);
      const untouched = await insert(tenantA, [source(unrelated)]);
      const foreign = await insert(tenantB, [source(from)]);

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
      expect(await sourcesOf(tenantB, foreign.link.id)).toEqual([`${from} project`]);
      expect(
        await withTenantTransaction(runtimePool, tenantA, (client) => moveValueLinkItemSources(client, from, to)),
      ).toBe(0);
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
      const insert = (ruleKey: string) =>
        withTenantTransaction(runtimePool, tenantA, (client) =>
          insertValueLink(client, {
            itemId: randomUUID(),
            propertyKey: "projects",
            ruleKey,
            sources: [{ kind: "item", sourceItemId: from, sourcePropertyKey: "project" }],
          }),
        );
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
      await insert(tenantB, randomUUID(), { sources: [itemSource(source)] });

      const listed = await withTenantTransaction(runtimePool, tenantA, (client) =>
        listValueLinksBySourceItem(client, source),
      );

      expect(listed.map((link) => link.itemId).sort()).toEqual([holderOn, holderBroken, holderTwice].sort());
      expect(listed.find((link) => link.itemId === holderBroken)?.state).toBe("broken");
      expect(
        await withTenantTransaction(runtimePool, tenantA, (client) => listValueLinksBySourceItem(client, randomUUID())),
      ).toEqual([]);
    } finally {
      await runtimePool.end();
    }
  });
});
