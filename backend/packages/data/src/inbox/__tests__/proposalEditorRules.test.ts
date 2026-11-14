import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { getDatabaseByModuleId } from "../../chokePoint/databasesStore.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../../db/pool.js";
import { getOrCreateJournalItem } from "../../journal/journalStore.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { assertRequiredFieldsHaveValues, loadCardEditorRules, type CardEditorRules } from "../proposalEditorRules.js";
import type { ProposalEnvelope, ProposalStep } from "../proposalEnvelope.js";

// Issue #1928: which editor schema a card gets, and which of its fields are pseudo fields, read from the seeded
// databases the way confirm and the values edit read them.

let pool: Pool;
let databaseIds: Record<string, string>;

const MODULES = ["tasks", "events", "companies", "people", "mcpServers", "journal"] as const;

beforeEach(async () => {
  pool ??= getTestPool();
  await resetDatabase(pool);
  await seedSystem(pool, createViewTypeRegistry());
  databaseIds = {};
  for (const moduleId of MODULES) {
    const database = await withTransaction(pool, (client) => getDatabaseByModuleId(client, moduleId));
    if (database) databaseIds[moduleId] = database.id;
  }
});

afterAll(async () => {
  await pool?.end();
});

function idOf(moduleId: (typeof MODULES)[number]): string {
  const id = databaseIds[moduleId];
  if (!id) throw new Error(`Database '${moduleId}' was not seeded`);
  return id;
}

const rulesFor = (storedKind: unknown, envelope: ProposalEnvelope): Promise<CardEditorRules | null> =>
  withTransaction(pool, (client) => loadCardEditorRules(client, storedKind, envelope));

const fieldKeys = (rules: CardEditorRules): string[] =>
  rules.schema.groups.flatMap((group) => group.fields.map((field) => field.key));

const database = (moduleId: (typeof MODULES)[number], properties: Record<string, unknown>): ProposalEnvelope => ({
  entityKind: "database",
  target: idOf(moduleId),
  properties,
});

const step = (ref: string, role: "primary" | "secondary", extra: Partial<ProposalStep>): ProposalStep => ({
  ref,
  op: "create",
  databaseKey: "tasks",
  role,
  properties: { name: ref },
  ...extra,
});

/** A Journal day item, or a Tasks item as an item that is no Journal day: the page a page-content card writes to. */
async function createPage(moduleId: "journal" | "tasks"): Promise<string> {
  const page = await withTransaction(pool, (client) =>
    moduleId === "journal"
      ? getOrCreateJournalItem(client, idOf("journal"), "day", new Date("2026-11-13T12:00:00Z"), "UTC")
      : createItemWithClient(client, { databaseId: idOf("tasks"), properties: { name: "A page" } }),
  );
  return page.id;
}

describe("loadCardEditorRules (issue #1928)", () => {
  it("gives a task card the task schema and names the fields the Tasks database has no property for as pseudo keys", async () => {
    const rules = await rulesFor("inbox", database("tasks", { name: "Milk" }));

    expect(rules).not.toBeNull();
    if (!rules) return;
    expect(fieldKeys(rules)).toContain("followDate");
    expect([...rules.pseudoKeys].sort()).toEqual(["allDay", "area", "followDate", "followupTask"]);
  });

  it("gives an Events card from a transcript the event schema", async () => {
    const rules = await rulesFor("transcript", database("events", { name: "Review" }));

    expect(rules).not.toBeNull();
    if (!rules) return;
    expect(fieldKeys(rules)).toEqual(expect.arrayContaining(["name", "date", "type"]));
    expect(fieldKeys(rules)).not.toContain("followDate");
  });

  it("reads an unknown stored kind as an Inbox card", async () => {
    expect(await rulesFor(undefined, database("companies", { name: "Acme" }))).not.toBeNull();
  });

  it("gives a multi-step card the schema of its primary step when that step creates the item", async () => {
    const rules = await rulesFor("inbox", {
      ...database("companies", { name: "Acme" }),
      operations: [
        step("company", "primary", { databaseKey: "companies" }),
        step("person", "secondary", { databaseKey: "people" }),
      ],
    });

    expect(rules).not.toBeNull();
    expect(rules ? fieldKeys(rules) : []).toEqual(["name"]);
  });

  it("applies no schema to a card whose primary step updates an item that already has its values", async () => {
    const rules = await rulesFor("inbox", {
      ...database("tasks", {}),
      operations: [step("task", "primary", { op: "update", itemId: randomUUID(), properties: { status: "done" } })],
    });

    expect(rules).toBeNull();
  });

  it("applies no schema to a relation envelope, which creates nothing", async () => {
    const rules = await rulesFor("transcript", {
      entityKind: "relation",
      target: randomUUID(),
      properties: { propertyKey: "event" },
    });

    expect(rules).toBeNull();
  });

  it("applies no schema to a destination that no module maps to a card kind", async () => {
    expect(await rulesFor("inbox", database("mcpServers", { name: "Remote tool" }))).toBeNull();
  });

  it("applies no schema to a base kind that no module declares an editor for, and passes the confirm check", async () => {
    const noDeclarations = { getEditorSchemas: async () => [] };
    const envelope = database("tasks", {});

    expect(
      await withTransaction(pool, (client) => loadCardEditorRules(client, "inbox", envelope, noDeclarations)),
    ).toBeNull();
    // The same card with the real declarations lacks its required name, so the check above passed only because
    // the declaration lookup found nothing.
    await expect(
      withTransaction(pool, (client) =>
        assertRequiredFieldsHaveValues(client, { id: randomUUID(), properties: {} }, envelope),
      ),
    ).rejects.toMatchObject({ details: { field: "name" } });
    await expect(
      withTransaction(pool, (client) =>
        assertRequiredFieldsHaveValues(client, { id: randomUUID(), properties: {} }, envelope, noDeclarations),
      ),
    ).resolves.toBeUndefined();
  });

  it("applies no schema to a database that does not exist", async () => {
    const rules = await rulesFor("inbox", { entityKind: "database", target: randomUUID(), properties: { name: "x" } });

    expect(rules).toBeNull();
  });

  it("applies no schema to a database target that is not an id, and reads no database for it", async () => {
    expect(
      await rulesFor("inbox", { entityKind: "database", target: "not-an-id", properties: { name: "x" } }),
    ).toBeNull();
  });

  it("gives a page-content card whose target is not an id the page schema, and reads no item for it", async () => {
    const rules = await rulesFor("inbox", {
      entityKind: "pageContent",
      target: "not-an-id",
      properties: { markdown: "A note", placement: "end" },
    });

    expect(rules ? fieldKeys(rules) : []).toContain("page");
  });

  it("gives a Markdown page-content card on a Journal day the journal schema, with `day` as a pseudo key", async () => {
    const rules = await rulesFor("inbox", {
      entityKind: "pageContent",
      target: await createPage("journal"),
      properties: { markdown: "Dear diary", placement: "end" },
    });

    expect(rules).not.toBeNull();
    if (!rules) return;
    expect(fieldKeys(rules)).toEqual(["day", "markdown"]);
    expect([...rules.pseudoKeys]).toEqual(["day"]);
  });

  it("gives a Markdown page-content card on any other page the page schema, with `page` as a pseudo key", async () => {
    const rules = await rulesFor("inbox", {
      entityKind: "pageContent",
      target: await createPage("tasks"),
      properties: { markdown: "A note", placement: "start" },
    });

    expect(rules).not.toBeNull();
    if (!rules) return;
    expect(fieldKeys(rules)).toEqual(["page", "placement", "heading", "markdown"]);
    expect([...rules.pseudoKeys]).toEqual(["page"]);
  });

  it("gives a Markdown page-content card whose target page cannot be found the page schema", async () => {
    const rules = await rulesFor("inbox", {
      entityKind: "pageContent",
      target: randomUUID(),
      properties: { markdown: "A note", placement: "end" },
    });

    expect(rules ? fieldKeys(rules) : []).toContain("page");
  });

  it("applies no schema to a page-content card of the legacy block shape, which holds no Markdown", async () => {
    const rules = await rulesFor("inbox", {
      entityKind: "pageContent",
      target: await createPage("tasks"),
      properties: { type: "paragraph", text: "A note" },
    });

    expect(rules).toBeNull();
  });
});
