import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../../db/pool.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { provisionTenant } from "../../tenancy/provisionTenant.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTestPool,
  inTenantZero,
  resetDatabase,
} from "../../testSupport/testDb.js";
import { describeUpdateSteps, type ProposalChange } from "../proposalChanges.js";
import type { ProposalStep } from "../proposalEnvelope.js";

/** Issue #2028: what the active update steps of a page of cards change, labelled in the reader's locale. */
let adminPool: Pool;

async function databaseIdFor(moduleId: string): Promise<string> {
  const { rows } = await adminPool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [
    moduleId,
  ]);
  if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
  return rows[0].id;
}

async function createItem(moduleId: string, properties: Record<string, unknown>): Promise<string> {
  const databaseId = await databaseIdFor(moduleId);
  return inTenantZero(() =>
    withTransaction(adminPool, async (client) => (await createItemWithClient(client, { databaseId, properties })).id),
  );
}

/** An `update` step that sets the properties and relations of `after` where `before` held its values. */
function updateStep(
  itemId: string,
  change: { before: NonNullable<ProposalStep["before"]>; after: NonNullable<ProposalStep["after"]> },
  extra: Partial<ProposalStep> = {},
): ProposalStep {
  return { ref: "update", op: "update", itemId, role: "primary", ...change, ...extra };
}

/** `describeUpdateSteps` for the cards named by the keys of `cards`, read as tenant zero on the superuser pool. */
function describeCards(cards: Record<string, ProposalStep[]>, locale = "en"): Promise<Map<string, ProposalChange[]>> {
  return inTenantZero(() =>
    withTransaction(adminPool, (client) => describeUpdateSteps(client, new Map(Object.entries(cards)), locale)),
  );
}

/** The changes of the one card `card`; fails when the card was not described. */
function changesOf(described: Map<string, ProposalChange[]>, card = "card"): ProposalChange[] {
  const changes = described.get(card);
  if (!changes) throw new Error(`Card ${card} was not described`);
  return changes;
}

describe("describeUpdateSteps (issue #2028)", () => {
  let workId: string;
  let financeId: string;
  let accountingId: string;

  beforeAll(() => {
    adminPool = getTestPool();
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
    await seedSystem(adminPool, createViewTypeRegistry());
    workId = await createItem("areas", { name: "Work" });
    financeId = await createItem("areas", { name: "Finance" });
    accountingId = await createItem("projects", { name: "Accounting", status: "inProgress" });
  });

  afterAll(async () => {
    await adminPool?.end();
  });

  describe("a relation", () => {
    it("moves a project from area Work to the area another step creates, labelled by the title that step would create", async () => {
      const move = updateStep(accountingId, {
        before: { relations: { area: [workId] } },
        after: { relations: { area: [{ ref: "newArea" }] } },
      });
      const newArea: ProposalStep = {
        ref: "newArea",
        op: "create",
        databaseKey: "areas",
        role: "secondary",
        properties: { name: "Side projects" },
      };

      const changes = changesOf(await describeCards({ card: [move, newArea] }));

      expect(changes).toEqual([
        {
          ref: "update",
          itemId: accountingId,
          itemLabel: "Accounting",
          field: "area",
          fieldLabel: "Area",
          from: { value: [workId], labels: ["Work"] },
          to: { value: [{ ref: "newArea" }], labels: ["Side projects"] },
        },
      ]);
    });

    it("moves a project from area Work to the existing area Finance, naming both by their current names", async () => {
      const move = updateStep(accountingId, {
        before: { relations: { area: [workId] } },
        after: { relations: { area: [financeId] } },
      });

      const changes = changesOf(await describeCards({ card: [move] }));

      expect(changes).toMatchObject([
        { field: "area", from: { labels: ["Work"] }, to: { value: [financeId], labels: ["Finance"] } },
      ]);
    });

    it("labels the field in Czech for a Czech reader", async () => {
      const move = updateStep(accountingId, {
        before: { relations: { area: [workId] } },
        after: { relations: { area: [financeId] } },
      });

      expect(changesOf(await describeCards({ card: [move] }, "cs"))).toMatchObject([
        { field: "area", fieldLabel: "Oblast" },
      ]);
    });

    it("labels a target that is an update step by the current name of the item it changes", async () => {
      const move = updateStep(accountingId, {
        before: { relations: { area: [workId] } },
        after: { relations: { area: [{ ref: "rename" }] } },
      });
      const rename: ProposalStep = {
        ref: "rename",
        op: "update",
        itemId: financeId,
        role: "secondary",
        before: { properties: { name: "Finance" } },
        after: { properties: { name: "Money" } },
      };

      const changes = changesOf(await describeCards({ card: [move, rename] }));

      expect(changes[0]).toMatchObject({ field: "area", to: { labels: ["Finance"] } });
    });

    it("labels a target that is a link step by the current name of the item it points at", async () => {
      const move = updateStep(accountingId, {
        before: { relations: { area: [workId] } },
        after: { relations: { area: [{ ref: "link" }] } },
      });
      const link: ProposalStep = { ref: "link", op: "link", itemId: financeId, role: "secondary" };

      expect(changesOf(await describeCards({ card: [move, link] }))[0]).toMatchObject({ to: { labels: ["Finance"] } });
    });

    it("falls back to the ref of a target step that creates nothing with a title, and of a step that is not there", async () => {
      const move = updateStep(accountingId, {
        before: { relations: { area: [workId] } },
        after: { relations: { area: [{ ref: "untitled" }, { ref: "gone" }] } },
      });
      const untitled: ProposalStep = {
        ref: "untitled",
        op: "create",
        databaseKey: "areas",
        role: "secondary",
        properties: {},
      };

      const changes = changesOf(await describeCards({ card: [move, untitled] }));

      expect(changes[0]?.to.labels).toEqual(["untitled", "gone"]);
    });

    it("falls back to the id of a target that cannot be read, and keeps the stored value", async () => {
      const missing = randomUUID();
      const move = updateStep(accountingId, {
        before: { relations: { area: [missing] } },
        after: { relations: { area: [financeId] } },
      });

      const changes = changesOf(await describeCards({ card: [move] }));

      expect(changes[0]?.from).toEqual({ value: [missing], labels: [missing] });
    });

    it("labels a target that is a fileFromAttachment step by the name of the Files item it would create", async () => {
      const move = updateStep(accountingId, {
        before: { relations: { area: [workId] } },
        after: { relations: { area: [{ ref: "scan" }] } },
      });
      const scan: ProposalStep = {
        ref: "scan",
        op: "fileFromAttachment",
        role: "secondary",
        properties: { attachmentId: randomUUID(), name: "Invoice.pdf" },
      };

      const changes = changesOf(await describeCards({ card: [move, scan] }));

      expect(changes[0]).toMatchObject({ to: { value: [{ ref: "scan" }], labels: ["Invoice.pdf"] } });
    });

    it("labels an id that is not a UUID by itself instead of failing the read, for the item, the before and the after", async () => {
      const move = updateStep("not-a-uuid", {
        before: { relations: { area: ["Work"] } },
        after: { relations: { area: ["Finance", financeId] } },
      });
      // A second card with well-formed ids on the same page is still described next to the malformed one.
      const sound = updateStep(accountingId, {
        before: { relations: { area: [workId] } },
        after: { relations: { area: [financeId] } },
      });

      const described = await describeCards({ bad: [move], good: [sound] });

      expect(changesOf(described, "bad")).toEqual([
        {
          ref: "update",
          itemId: "not-a-uuid",
          itemLabel: "not-a-uuid",
          field: "area",
          fieldLabel: "area",
          from: { value: ["Work"], labels: ["Work"] },
          to: { value: ["Finance", financeId], labels: ["Finance", "Finance"] },
        },
      ]);
      expect(changesOf(described, "good")[0]).toMatchObject({
        from: { labels: ["Work"] },
        to: { labels: ["Finance"] },
      });
    });

    it("still names a target that is in the Trash", async () => {
      await adminPool.query("UPDATE items SET deleted_at = now() WHERE id = $1", [workId]);
      const move = updateStep(accountingId, {
        before: { relations: { area: [workId] } },
        after: { relations: { area: [financeId] } },
      });

      expect(changesOf(await describeCards({ card: [move] }))[0]?.from.labels).toEqual(["Work"]);
    });

    it("gives an empty value and no labels to the side of a relation the step does not name", async () => {
      const move = updateStep(accountingId, { before: {}, after: { relations: { area: [financeId] } } });

      const changes = changesOf(await describeCards({ card: [move] }));

      expect(changes[0]).toMatchObject({ from: { value: [], labels: [] }, to: { labels: ["Finance"] } });
    });
  });

  describe("a property", () => {
    it.each([
      ["en", "Status", "In progress", "Done"],
      ["cs", "Stav", "Probíhá", "Hotovo"],
    ])(
      "changing a project's status to done carries the canonical keys and the option labels in %s",
      async (locale, fieldLabel, fromLabel, toLabel) => {
        const done = updateStep(accountingId, {
          before: { properties: { status: "inProgress" } },
          after: { properties: { status: "done" } },
        });

        const changes = changesOf(await describeCards({ card: [done] }, locale));

        expect(changes).toEqual([
          {
            ref: "update",
            itemId: accountingId,
            itemLabel: "Accounting",
            field: "status",
            fieldLabel,
            from: { value: "inProgress", labels: [fromLabel] },
            to: { value: "done", labels: [toLabel] },
          },
        ]);
      },
    );

    it("uses the English option labels for a locale the catalogs do not have", async () => {
      const done = updateStep(accountingId, {
        before: { properties: { status: "inProgress" } },
        after: { properties: { status: "done" } },
      });

      expect(changesOf(await describeCards({ card: [done] }, "de"))[0]).toMatchObject({
        fieldLabel: "Status",
        from: { labels: ["In progress"] },
        to: { labels: ["Done"] },
      });
    });

    it("labels every key of a multi-select value", async () => {
      const recordId = await createItem("healthRecords", { name: "Checkup", tags: ["medication"] });
      const retag = updateStep(recordId, {
        before: { properties: { tags: ["medication"] } },
        after: { properties: { tags: ["medication", "bloodTests"] } },
      });

      const changes = changesOf(await describeCards({ card: [retag] }, "cs"));

      expect(changes[0]).toMatchObject({
        field: "tags",
        from: { value: ["medication"], labels: ["Léky"] },
        to: { value: ["medication", "bloodTests"], labels: ["Léky", "Krevní testy"] },
      });
    });

    it("gives the key itself as the label of an option the property does not have", async () => {
      const odd = updateStep(accountingId, {
        before: { properties: { status: "inProgress" } },
        after: { properties: { status: "paused" } },
      });

      expect(changesOf(await describeCards({ card: [odd] }))[0]?.to).toEqual({ value: "paused", labels: ["paused"] });
    });

    it("gives no labels to a select side that holds no key, and a null value to the side the step does not name", async () => {
      const clear = updateStep(accountingId, { before: { properties: { status: "done" } }, after: {} });
      const set = updateStep(accountingId, { before: {}, after: { properties: { status: "done" } } });

      const cleared = changesOf(await describeCards({ card: [clear] }))[0];
      const written = changesOf(await describeCards({ card: [set] }))[0];

      expect(cleared).toMatchObject({ from: { labels: ["Done"] }, to: { value: null, labels: [] } });
      expect(written).toMatchObject({ from: { value: null, labels: [] }, to: { labels: ["Done"] } });
    });

    it("gives no labels to a property that is not a select, and keeps its raw value", async () => {
      const rename = updateStep(accountingId, {
        before: { properties: { name: "Accounting" } },
        after: { properties: { name: "Bookkeeping" } },
      });

      expect(changesOf(await describeCards({ card: [rename] }))).toMatchObject([
        {
          field: "name",
          fieldLabel: "Name",
          from: { value: "Accounting", labels: [] },
          to: { value: "Bookkeeping", labels: [] },
        },
      ]);
    });

    it("describes the properties first and then the relations, one entry per changed key", async () => {
      const both = updateStep(accountingId, {
        before: { properties: { status: "inProgress", name: "Accounting" }, relations: { area: [workId] } },
        after: { properties: { status: "done", name: "Accounting" }, relations: { area: [financeId] } },
      });

      const changes = changesOf(await describeCards({ card: [both] }));

      expect(changes.map((change) => change.field)).toEqual(["status", "name", "area"]);
    });

    it("labels the field and the option of a database without a module catalog from what the property stores", async () => {
      const chokePoint = createChokePoint(adminPool);
      const reading = await inTenantZero(async () => {
        const database = await chokePoint.createDatabase({ name: "Reading" });
        await chokePoint.createProperty({ databaseId: database.id, key: "title", name: "Title", type: "title" });
        await chokePoint.createProperty({
          databaseId: database.id,
          key: "shelf",
          name: "Shelf",
          type: "select",
          config: { options: [{ key: "toRead", label: "To read" }, { key: "finished" }] },
        });
        return chokePoint.createItem({ databaseId: database.id, properties: { title: "Dune", shelf: "toRead" } });
      });
      const shelve = updateStep(reading.id, {
        before: { properties: { shelf: "toRead" } },
        after: { properties: { shelf: "finished" } },
      });

      const changes = changesOf(await describeCards({ card: [shelve] }));

      expect(changes[0]).toMatchObject({
        itemLabel: "Dune",
        fieldLabel: "Shelf",
        from: { labels: ["To read"] },
        to: { labels: ["finished"] },
      });
    });
  });

  describe("what contributes no entry", () => {
    it("leaves out a card whose steps have no update step, without reading anything", async () => {
      const create: ProposalStep = {
        ref: "area",
        op: "create",
        databaseKey: "areas",
        role: "primary",
        properties: { name: "Travel" },
      };
      const link: ProposalStep = { ref: "link", op: "link", itemId: financeId, role: "secondary" };

      const described = await inTenantZero(() =>
        withTransaction(adminPool, async (client) => {
          const spy = vi.spyOn(client, "query");
          try {
            const result = await describeUpdateSteps(client, new Map([["card", [create, link]]]), "en");
            return { result, queries: spy.mock.calls.length };
          } finally {
            spy.mockRestore();
          }
        }),
      );

      expect(described.result.size).toBe(0);
      expect(described.queries).toBe(0);
    });

    it("leaves out an update step that names no item", async () => {
      const unaimed: ProposalStep = {
        ref: "update",
        op: "update",
        role: "primary",
        before: { properties: { status: "inProgress" } },
        after: { properties: { status: "done" } },
      };

      expect((await describeCards({ card: [unaimed] })).size).toBe(0);
    });

    it("leaves out a card whose update step changes no key", async () => {
      expect((await describeCards({ card: [updateStep(accountingId, { before: {}, after: {} })] })).size).toBe(0);
    });

    it("describes only the cards that have an update step, each under its own key", async () => {
      const done = updateStep(accountingId, {
        before: { properties: { status: "inProgress" } },
        after: { properties: { status: "done" } },
      });
      const create: ProposalStep = { ref: "area", op: "create", databaseKey: "areas", role: "primary", properties: {} };

      const described = await describeCards({ updating: [done], creating: [create] });

      expect([...described.keys()]).toEqual(["updating"]);
    });
  });

  describe("a page of cards", () => {
    async function seedCards(count: number): Promise<Record<string, ProposalStep[]>> {
      const cards: Record<string, ProposalStep[]> = {};
      for (let n = 0; n < count; n += 1) {
        const projectId = await createItem("projects", { name: `Project ${n}`, status: "inProgress" });
        const areaId = await createItem("areas", { name: `Area ${n}` });
        cards[`card${n}`] = [
          updateStep(projectId, {
            before: { properties: { status: "inProgress" }, relations: { area: [workId] } },
            after: { properties: { status: "done" }, relations: { area: [areaId, { ref: "extra" }] } },
          }),
          { ref: "extra", op: "create", databaseKey: "areas", role: "secondary", properties: { name: `Extra ${n}` } },
        ];
      }
      return cards;
    }

    /** The queries `describeUpdateSteps` issues for `cards` on a client that counts them. */
    function countQueries(cards: Record<string, ProposalStep[]>): Promise<number> {
      return inTenantZero(() =>
        withTransaction(adminPool, async (client) => {
          const spy = vi.spyOn(client, "query");
          try {
            const described = await describeUpdateSteps(client, new Map(Object.entries(cards)), "en");
            expect(described.size).toBe(Object.keys(cards).length);
            return spy.mock.calls.length;
          } finally {
            spy.mockRestore();
          }
        }),
      );
    }

    it("resolves the names of 50 cards with as many queries as one card", async () => {
      const all = await seedCards(50);
      const [firstKey] = Object.keys(all);
      const one = { [firstKey!]: all[firstKey!]! };

      const single = await countQueries(one);
      const page = await countQueries(all);

      expect(single).toBeGreaterThan(0);
      expect(page).toBe(single);
      const described = await describeCards(all);
      expect(changesOf(described, "card49")).toMatchObject([
        { itemLabel: "Project 49", field: "status", to: { labels: ["Done"] } },
        { itemLabel: "Project 49", field: "area", from: { labels: ["Work"] }, to: { labels: ["Area 49", "Extra 49"] } },
      ]);
    }, 120_000);
  });

  describe("tenant isolation", () => {
    let dataPool: Pool;

    beforeAll(async () => {
      dataPool = await createRuntimeRolePool(adminPool, "semprec_data");
    });

    afterAll(async () => {
      await dataPool?.end();
    });

    it("names nothing of another tenant: the ids it cannot read stand for themselves, on the runtime role", async () => {
      const move = updateStep(accountingId, {
        before: { properties: { status: "inProgress" }, relations: { area: [workId] } },
        after: { properties: { status: "done" }, relations: { area: [financeId] } },
      });
      const otherTenantId = await createTestTenant(adminPool);
      await provisionTenant(dataPool, otherTenantId);

      const asOwner = await inTenantZero(() =>
        withTransaction(dataPool, (client) => describeUpdateSteps(client, new Map([["card", [move]]]), "en")),
      );
      const asOtherTenant = await runInTenant(otherTenantId, () =>
        withTransaction(dataPool, (client) => describeUpdateSteps(client, new Map([["card", [move]]]), "en")),
      );

      expect(changesOf(asOwner)).toMatchObject([
        { itemLabel: "Accounting", fieldLabel: "Status", to: { labels: ["Done"] } },
        { fieldLabel: "Area", from: { labels: ["Work"] }, to: { labels: ["Finance"] } },
      ]);
      expect(changesOf(asOtherTenant)).toEqual([
        {
          ref: "update",
          itemId: accountingId,
          itemLabel: accountingId,
          field: "status",
          fieldLabel: "status",
          from: { value: "inProgress", labels: [] },
          to: { value: "done", labels: [] },
        },
        {
          ref: "update",
          itemId: accountingId,
          itemLabel: accountingId,
          field: "area",
          fieldLabel: "area",
          from: { value: [workId], labels: [workId] },
          to: { value: [financeId], labels: [financeId] },
        },
      ]);
    }, 120_000);
  });
});
