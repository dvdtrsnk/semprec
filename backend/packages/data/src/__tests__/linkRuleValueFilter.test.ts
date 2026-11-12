import "../domainWriteHooks.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { ModuleRegistry, type ModuleLinkRuleProjection, type ModuleManifest } from "@semprec/module-registry";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { insertValueLink } from "../chokePoint/valueLinksStore.js";
import { withTransaction } from "../db/pool.js";
import * as registryLoader from "../manifest/fullModuleRegistry.js";
import { seedSystem } from "../seed/seedSystem.js";
import { setSelfPersonId } from "../selfPerson.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { readOmittedItemIds, resolveLinkRule } from "../valueLinks/linkRuleCatalog.js";

const OWN_PERSON = { databaseKey: "systemSettings", propertyKey: "selfPerson" };

/**
 * A rule over real seeded properties whose value filter names a property System settings does not have. Its
 * endpoints are an Event's files and the files of the Event's action-item tasks, so its via edge is the one on
 * which the real `taskProjectFromEvent` and `taskPeopleFromEvent` rules of the systemDatabases manifest
 * (issue #1724) copy the project and the people; those two show that the rule engine sees the edge at all.
 */
export const manifest: ModuleManifest = {
  id: "fixtureValueFilter",
  version: "1.0.0",
  name: "Fixture Value Filter",
  removable: true,
  systemProject: false,
  databases: [],
  capabilities: [],
  agentTools: [],
  linkRules: [
    {
      key: "fixtureFilter.unresolved",
      source: { databaseKey: "events", propertyKey: "files" },
      target: { databaseKey: "tasks", propertyKey: "files" },
      via: { databaseKey: "events", relationKey: "actionItems" },
      valueFilter: { omit: { databaseKey: "systemSettings", propertyKey: "noSuchRelation" } },
    },
  ],
};

/** The real people rule of a transcript with another value filter. */
function peopleRule(omit?: { databaseKey: string; propertyKey: string }): ModuleLinkRuleProjection {
  return {
    moduleId: "fixtureValueFilter",
    key: "fixtureFilter.adHoc",
    source: { databaseKey: "events", propertyKey: "people" },
    target: { databaseKey: "transcripts", propertyKey: "people" },
    via: { databaseKey: "transcripts", relationKey: "event" },
    ...(omit ? { valueFilter: { omit } } : {}),
  };
}

let admin: Pool;
let pool: Pool;
let cp: ChokePoint;
let tenant: string;

const inTenant = <T>(fn: () => Promise<T>): Promise<T> => runInTenant(tenant, fn);

function resolve(rule: ModuleLinkRuleProjection) {
  return inTenant(() => withTransaction(pool, (client) => resolveLinkRule(client, rule)));
}

async function databaseId(moduleId: string): Promise<string> {
  const found = (await inTenant(() => cp.listDatabases())).find((database) => database.ownerModuleId === moduleId);
  if (!found) throw new Error(`Missing database ${moduleId}`);
  return found.id;
}

async function propertyId(moduleId: string, key: string): Promise<string> {
  const id = await databaseId(moduleId);
  const found = (await inTenant(() => cp.listProperties(id))).find((entry) => entry.key === key);
  if (!found) throw new Error(`Missing property ${moduleId}.${key}`);
  return found.id;
}

describe("link rule value filter (issue #1697)", () => {
  beforeAll(async () => {
    const registry = new ModuleRegistry(() => new Set(["fixtureValueFilter", "systemDatabases"]));
    await registry.loadModule(new URL("../seed/systemDatabasesModuleManifest.js", import.meta.url).href);
    await registry.loadModule(import.meta.url);
    registry.validateLinkRules();
    vi.spyOn(registryLoader, "loadFullModuleRegistry").mockResolvedValue(registry);
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("test:role", () =>
      pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    cp = createChokePoint(pool);
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    await inTenant(() => seedSystem(pool));
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await pool?.end();
    await admin?.end();
  });

  describe("resolving a rule", () => {
    it("resolves the filter to the relation property of the system database its owner module id names", async () => {
      const resolved = await resolve(peopleRule(OWN_PERSON));
      expect(resolved?.valueFilter?.property).toMatchObject({
        id: await propertyId("systemSettings", "selfPerson"),
        key: "selfPerson",
        type: "relation",
      });
      expect(resolved?.valueFilter?.definition.propertyIdA).toBe(resolved?.valueFilter?.property.id);
    });

    it("resolves a rule without a filter with no value filter", async () => {
      const resolved = await resolve(peopleRule());
      expect(resolved).not.toBeNull();
      expect(resolved?.valueFilter).toBeNull();
    });

    it("leaves the whole rule unresolved when the filter names no system database of the tenant", async () => {
      expect(await resolve(peopleRule({ databaseKey: "noSuchSettings", propertyKey: "selfPerson" }))).toBeNull();
    });

    it("leaves the whole rule unresolved when the filter's database has no such property", async () => {
      expect(await resolve(peopleRule({ databaseKey: "systemSettings", propertyKey: "noSuchRelation" }))).toBeNull();
    });

    it("leaves the whole rule unresolved when the filter's property is not a relation", async () => {
      expect(await resolve(peopleRule({ databaseKey: "systemSettings", propertyKey: "timezone" }))).toBeNull();
    });

    it("leaves the whole rule unresolved when the filter's relation property has no definition row", async () => {
      // A relation property without its definition is a state no API produces: raw SQL on the admin pool.
      const removed = await admin.query("DELETE FROM relation_definitions WHERE property_id_a = $1", [
        await propertyId("systemSettings", "selfPerson"),
      ]);
      expect(removed.rowCount).toBe(1);
      expect(await resolve(peopleRule(OWN_PERSON))).toBeNull();
    });
  });

  describe("the omitted items", () => {
    async function omitted(): Promise<string[]> {
      return inTenant(() =>
        withTransaction(pool, async (client) => {
          const resolved = await resolveLinkRule(client, peopleRule(OWN_PERSON));
          if (!resolved?.valueFilter) throw new Error("The own-person filter did not resolve");
          return readOmittedItemIds(client, resolved.valueFilter);
        }),
      );
    }

    it("are the item the singleton's relation points to, and none while it points to nothing", async () => {
      expect(await omitted()).toEqual([]);
      const people = await databaseId("people");
      const me = await inTenant(() => cp.createItem({ databaseId: people, properties: { name: "Me Myself" } }));
      await inTenant(() => cp.createItem({ databaseId: people, properties: { name: "Alice Novak" } }));
      await inTenant(() => withTransaction(pool, (client) => setSelfPersonId(client, me.id)));

      expect(await omitted()).toEqual([me.id]);
    });

    it("are read inside the caller's tenant only", async () => {
      const people = await databaseId("people");
      const me = await inTenant(() => cp.createItem({ databaseId: people, properties: { name: "Me Myself" } }));
      await inTenant(() => withTransaction(pool, (client) => setSelfPersonId(client, me.id)));
      const other = await createTestTenant(admin);
      await runInTenant(other, () => seedSystem(pool));

      const seenByOther = await runInTenant(other, () =>
        withTransaction(pool, async (client) => {
          const resolved = await resolveLinkRule(client, peopleRule(OWN_PERSON));
          if (!resolved?.valueFilter) throw new Error("The own-person filter did not resolve");
          return readOmittedItemIds(client, resolved.valueFilter);
        }),
      );
      expect(seenByOther).toEqual([]);
      expect(await omitted()).toEqual([me.id]);
    });
  });

  describe("a loaded rule whose filter cannot be resolved", () => {
    async function fixture() {
      const [events, tasks, people, projects, files] = await Promise.all(
        ["events", "tasks", "people", "projects", "files"].map((moduleId) => databaseId(moduleId)),
      );
      if (!events || !tasks || !people || !projects || !files) throw new Error("Fixture databases missing");
      const person = await inTenant(() => cp.createItem({ databaseId: people, properties: { name: "Alice Novak" } }));
      const project = await inTenant(() => cp.createItem({ databaseId: projects, properties: { name: "Web" } }));
      const file = await inTenant(() => cp.createItem({ databaseId: files, properties: { name: "Offer.pdf" } }));
      const task = await inTenant(() => cp.createItem({ databaseId: tasks, properties: { name: "Send the offer" } }));
      const event = await inTenant(() =>
        cp.createItem({ databaseId: events, properties: { name: "client meeting", date: "2026-10-16" } }),
      );
      const edge = async (key: string, targetItemId: string) =>
        inTenant(async () =>
          cp.createRelation({
            relationPropertyId: await propertyId("events", key),
            callerItemId: event.id,
            targetItemId,
          }),
        );
      await edge("people", person.id);
      await edge("project", project.id);
      await edge("files", file.id);
      const taskTargets = async (key: string): Promise<string[]> =>
        ((await inTenant(async () => cp.listItemRelations(task.id, await propertyId("tasks", key)))) ?? []).map(
          (entry) => entry.targetItemId,
        );
      return { person, project, task, event, edge, taskTargets };
    }

    it("copies nothing on its via edge, while the rules whose filter resolves or that have none copy their values on the same edge", async () => {
      const f = await fixture();

      await f.edge("actionItems", f.task.id);

      expect(await f.taskTargets("files")).toEqual([]);
      expect(await f.taskTargets("people")).toEqual([f.person.id]);
      expect(await f.taskTargets("project")).toEqual([f.project.id]);
      const links = await inTenant(() =>
        pool.query<{ property_key: string; rule_key: string }>(
          "SELECT property_key, rule_key FROM value_links WHERE item_id = $1 ORDER BY property_key",
          [f.task.id],
        ),
      );
      expect(links.rows).toEqual([
        { property_key: "people", rule_key: "taskPeopleFromEvent" },
        { property_key: "project", rule_key: "taskProjectFromEvent" },
      ]);
    });

    it("refuses a relink with 409 and writes neither the value nor the link state", async () => {
      const f = await fixture();
      const brokenAt = new Date("2026-10-01T10:00:00.000Z");
      // A link of the unresolvable rule, which that rule itself never creates: the store fixture writes the row.
      await inTenant(() =>
        withTransaction(pool, (client) =>
          insertValueLink(client, {
            itemId: f.task.id,
            propertyKey: "files",
            ruleKey: "fixtureFilter.unresolved",
            state: "broken",
            brokenBy: "user",
            brokenAt,
            sources: [{ kind: "item", sourceItemId: f.event.id, sourcePropertyKey: "files" }],
          }),
        ),
      );

      await expect(inTenant(() => cp.relinkValue({ itemId: f.task.id, propertyKey: "files" }))).rejects.toMatchObject({
        status: 409,
        code: "value_link_conflict",
      });

      expect(await f.taskTargets("files")).toEqual([]);
      const entry = (await inTenant(() => cp.getValueLinksForItems([f.task.id]))).get(f.task.id)?.files;
      expect(entry).toMatchObject({ valueKind: "inheritedBroken", brokenBy: "user", brokenAt: brokenAt.toISOString() });
    });
  });
});
