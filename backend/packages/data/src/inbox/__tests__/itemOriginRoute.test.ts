import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import "../../domainWriteHooks.js";
import { getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createRuntimeRolePool, createTestTenant, withTenantTransaction } from "../../testSupport/tenantFixtures.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { withTransaction } from "../../db/pool.js";
import { createDatabase, getDatabaseByModuleId } from "../../chokePoint/databasesStore.js";
import { createItemWithClient, updateItemWithClient } from "../../chokePoint/itemWrites.js";
import { itemDeleteWithClient } from "../../chokePoint/itemTrash.js";
import { getItemsByIds } from "../../chokePoint/itemsStore.js";
import { createActionQueueAffinity } from "../../scheduler/actions.js";
import { getSystemTimezone } from "../../systemSettings.js";
import { NotFoundError, ValidationError } from "../../errors.js";
import { createInboxItemWithClient } from "../inboxStore.js";
import { linkSourceInboxRelation } from "../inboxCardSourceLink.js";
import { createConfirmProposalRouteHandler, createItemOriginRouteHandler } from "../inboxRouteHandlers.js";

// Issue gh-1967: `GET /api/items/:id/origin`. Everything runs on the runtime role pool inside a tenant scope, with a
// second tenant for the cross-tenant case. Origins are written by the real confirm route, and raw SQL is used only for
// the origin states a confirm cannot write today (a legacy row, a transcript row).
let adminPool: Pool;
let runtimePool: Pool;
let tenantA: string;
let tenantB: string;

beforeAll(async () => {
  adminPool = getTestPool();
  runtimePool = await createRuntimeRolePool(adminPool, "semprec_data");
});

beforeEach(async () => {
  await resetDatabase(adminPool);
  tenantA = await createTestTenant(adminPool);
  tenantB = await createTestTenant(adminPool);
  await runInTenant(tenantA, () => seedSystem(runtimePool));
  await runInTenant(tenantB, () => seedSystem(runtimePool));
});

afterAll(async () => {
  await runtimePool?.end();
  await adminPool?.end();
});

type Answer = Awaited<ReturnType<ReturnType<typeof createItemOriginRouteHandler>>>;

const originOf = (tenant: string, id: string): Promise<Answer> =>
  runInTenant(tenant, () => createItemOriginRouteHandler(runtimePool)({ params: { id }, body: null }));

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return null;
}

/** The body of a 200 answer; any other answer shape fails the test. */
async function bodyOf(tenant: string, id: string): Promise<Record<string, unknown>> {
  const answer = await originOf(tenant, id);
  if (!("body" in answer) || answer.status !== 200) throw new Error("The route did not answer 200 with a body");
  const body: unknown = answer.body;
  if (typeof body !== "object" || body === null) throw new Error("The route answered a body that is not an object");
  return Object.fromEntries(Object.entries(body));
}

type Step = { ref: string; op: "create"; databaseKey: string; role: "primary" | "secondary" } & {
  properties: Record<string, unknown>;
  relations?: Record<string, Array<{ ref: string }>>;
};

const companyAndPerson = (company = "Acme", person = "Jane"): Step[] => [
  { ref: "company", op: "create", databaseKey: "companies", role: "primary", properties: { name: company } },
  {
    ref: "person",
    op: "create",
    databaseKey: "people",
    role: "secondary",
    properties: { name: person },
    relations: { companies: [{ ref: "company" }] },
  },
];

const justACompany = (name = "Solo"): Step[] => [
  { ref: "company", op: "create", databaseKey: "companies", role: "primary", properties: { name } },
];

interface Capture {
  inboxItemId: string;
  cardId: string;
}

/** An Inbox item and its `proposed` card with the given steps, linked as the tick links them. Nothing is confirmed yet. */
function propose(tenant: string, steps: Step[], text = "Meeting notes", date = "2026-11-02"): Promise<Capture> {
  return runInTenant(tenant, () =>
    withTransaction(runtimePool, async (client) => {
      const inbox = await getDatabaseByModuleId(client, "inbox");
      const cards = await getDatabaseByModuleId(client, "processingProposals");
      const companies = await getDatabaseByModuleId(client, "companies");
      if (!inbox || !cards || !companies) throw new Error(`no inbox pipeline in tenant ${tenant}`);
      const source = await createInboxItemWithClient(client, {
        inboxDatabaseId: inbox.id,
        date,
        time: "18:02",
        text,
      });
      const primary = steps.find((step) => step.role === "primary");
      const envelope = {
        entityKind: "database",
        target: companies.id,
        properties: primary?.properties ?? {},
        operations: steps,
      };
      const card = await createItemWithClient(
        client,
        { databaseId: cards.id, properties: { kind: "inbox", status: "proposed", proposal: envelope } },
        { allowedSystemKeys: ["kind", "status", "proposal"] },
      );
      await linkSourceInboxRelation(client, { processingProposalsDatabaseId: cards.id }, card.id, source.id);
      return { inboxItemId: source.id, cardId: card.id };
    }),
  );
}

/** The ids of the items one confirm of `cardId` created, by the database of each: `{ companies: [...], people: [...] }`. */
async function confirm(tenant: string, cardId: string): Promise<{ companies: string[]; people: string[] }> {
  await runInTenant(tenant, () => createConfirmProposalRouteHandler(runtimePool)({ params: { id: cardId }, body: {} }));
  return withTenantTransaction(runtimePool, tenant, async (client) => {
    const { rows } = await client.query<{ item_id: string; key: string }>(
      `SELECT o.item_id, d.owner_module_id AS key
         FROM item_origins o JOIN items i ON i.id = o.item_id JOIN databases d ON d.id = i.database_id
        WHERE o.proposal_id = $1 ORDER BY o.item_id`,
      [cardId],
    );
    return {
      companies: rows.filter((row) => row.key === "companies").map((row) => row.item_id),
      people: rows.filter((row) => row.key === "people").map((row) => row.item_id),
    };
  });
}

/** An item written by hand, as a user's create does: it has no origin row. */
function createByHand(tenant: string, moduleId: string, properties: Record<string, unknown>): Promise<string> {
  return runInTenant(tenant, () =>
    withTransaction(runtimePool, async (client) => {
      const database = await getDatabaseByModuleId(client, moduleId);
      if (!database) throw new Error(`no '${moduleId}' database in tenant ${tenant}`);
      return (await createItemWithClient(client, { databaseId: database.id, properties })).id;
    }),
  );
}

/** Moves the item to the Trash through the choke point's delete; its origin row stays. */
function trash(tenant: string, itemId: string): Promise<void> {
  return runInTenant(tenant, () =>
    withTransaction(runtimePool, async (client) => {
      const [item] = await getItemsByIds(client, [itemId]);
      if (!item) throw new Error(`item ${itemId} is not live in tenant ${tenant}`);
      await itemDeleteWithClient(client, item.databaseId, itemId, { queueAffinity: createActionQueueAffinity() });
    }),
  );
}

const first = (ids: string[]): string => {
  const [id] = ids;
  if (!id) throw new Error("expected an id");
  return id;
};

describe("GET /api/items/:id/origin (issue gh-1967)", () => {
  describe("an item created by confirming a card", () => {
    it("returns the card, the Inbox item, its capture time and its text", async () => {
      const capture = await propose(tenantA, companyAndPerson(), "Met Jane at Acme", "2026-11-02");
      const created = await confirm(tenantA, capture.cardId);
      const zone = await withTenantTransaction(runtimePool, tenantA, (client) => getSystemTimezone(client));

      const origin = await bodyOf(tenantA, first(created.companies));

      expect(origin).toEqual({
        proposalId: capture.cardId,
        inboxItemId: capture.inboxItemId,
        capturedAt: DateTime.fromISO("2026-11-02T18:02", { zone }).toUTC().toISO(),
        captureTimeBasis: "inboxCapture",
        captureChannel: "inbox",
        sourceText: "Met Jane at Acme",
        siblings: [{ itemId: first(created.people), label: "Jane" }],
      });
    });

    it("lists the other item of a two-step confirm as the sibling of each, and never the item itself", async () => {
      const capture = await propose(tenantA, companyAndPerson("Acme", "Jane"));
      const created = await confirm(tenantA, capture.cardId);
      const company = first(created.companies);
      const person = first(created.people);

      expect((await bodyOf(tenantA, company)).siblings).toEqual([{ itemId: person, label: "Jane" }]);
      expect((await bodyOf(tenantA, person)).siblings).toEqual([{ itemId: company, label: "Acme" }]);
    });

    it("has no siblings for a one-step confirm", async () => {
      const capture = await propose(tenantA, justACompany());
      const created = await confirm(tenantA, capture.cardId);

      expect((await bodyOf(tenantA, first(created.companies))).siblings).toEqual([]);
    });

    it("lists only the items of the same card, not those of another confirm", async () => {
      const one = await propose(tenantA, companyAndPerson("Acme", "Jane"));
      const two = await propose(tenantA, companyAndPerson("Globex", "John"));
      const createdOne = await confirm(tenantA, one.cardId);
      const createdTwo = await confirm(tenantA, two.cardId);

      const siblings = (await bodyOf(tenantA, first(createdOne.companies))).siblings;
      expect(siblings).toEqual([{ itemId: first(createdOne.people), label: "Jane" }]);
      expect(JSON.stringify(siblings)).not.toContain(first(createdTwo.people));
    });

    it("leaves a trashed sibling out and keeps the live ones", async () => {
      const capture = await propose(tenantA, companyAndPerson());
      const created = await confirm(tenantA, capture.cardId);
      await trash(tenantA, first(created.people));

      expect((await bodyOf(tenantA, first(created.companies))).siblings).toEqual([]);
    });

    it("answers with a null sourceText and the Inbox item id when the source Inbox item is in the Trash", async () => {
      const capture = await propose(tenantA, justACompany());
      const created = await confirm(tenantA, capture.cardId);
      await trash(tenantA, capture.inboxItemId);

      const origin = await bodyOf(tenantA, first(created.companies));

      expect(origin.sourceText).toBeNull();
      expect(origin.inboxItemId).toBe(capture.inboxItemId);
    });

    it("answers with the text of a capture that has none, an empty string, and not null", async () => {
      const capture = await propose(tenantA, justACompany(), "");
      const created = await confirm(tenantA, capture.cardId);

      expect((await bodyOf(tenantA, first(created.companies))).sourceText).toBe("");
    });

    it("labels a sibling whose title is empty by its id", async () => {
      const capture = await propose(tenantA, companyAndPerson("Acme", "Jane"));
      const created = await confirm(tenantA, capture.cardId);
      const person = first(created.people);
      await runInTenant(tenantA, () =>
        withTransaction(runtimePool, async (client) => {
          const people = await getDatabaseByModuleId(client, "people");
          if (!people) throw new Error("no people database");
          await updateItemWithClient(client, { databaseId: people.id, itemId: person, propertiesPatch: { name: "" } });
        }),
      );

      expect((await bodyOf(tenantA, first(created.companies))).siblings).toEqual([{ itemId: person, label: person }]);
    });
  });

  it("labels a sibling in a database that declares no title property by its id", async () => {
    const capture = await propose(tenantA, justACompany());
    const created = await confirm(tenantA, capture.cardId);
    const untitled = await runInTenant(tenantA, () =>
      withTransaction(runtimePool, async (client) => {
        const database = await createDatabase(client, { name: "Untitled rows" });
        return (await createItemWithClient(client, { databaseId: database.id, properties: {} })).id;
      }),
    );
    // Raw insert: a confirm writes only items of the databases its steps name, which all declare a title, so a sibling
    // of a database with none cannot be produced through the confirm path.
    await withTenantTransaction(runtimePool, tenantA, (client) =>
      client.query(
        `INSERT INTO item_origins (item_id, proposal_id, inbox_item_id, captured_at, capture_channel, capture_time_basis)
         VALUES ($1, $2, $3, now(), 'inbox', 'inboxCapture')`,
        [untitled, capture.cardId, capture.inboxItemId],
      ),
    );

    expect((await bodyOf(tenantA, first(created.companies))).siblings).toEqual([{ itemId: untitled, label: untitled }]);
  });

  describe("the capture time", () => {
    it.each([
      ["a date that is not a date", { date: "invalid" }],
      ["no date", { date: null }],
      ["a time that is not a time", { time: "invalid" }],
    ])("is null with the basis unknown for %s on the Inbox item", async (_name, patch) => {
      const capture = await propose(tenantA, justACompany());
      await runInTenant(tenantA, () =>
        withTransaction(runtimePool, async (client) => {
          const inbox = await getDatabaseByModuleId(client, "inbox");
          if (!inbox) throw new Error("no inbox database");
          await updateItemWithClient(client, {
            databaseId: inbox.id,
            itemId: capture.inboxItemId,
            propertiesPatch: patch,
          });
        }),
      );
      const created = await confirm(tenantA, capture.cardId);

      const origin = await bodyOf(tenantA, first(created.companies));

      expect(origin.capturedAt).toBeNull();
      expect(origin.captureTimeBasis).toBe("unknown");
    });

    it("keeps legacyUnverified, with the stored time, for a row written before the basis existed", async () => {
      const itemId = await createByHand(tenantA, "companies", { name: "Old" });
      const proposalId = randomUUID();
      // Raw insert: a row of the old writer, which the confirm path of this release can no longer produce; the column
      // default is what marks it `legacyUnverified`.
      await withTenantTransaction(runtimePool, tenantA, (client) =>
        client.query(
          `INSERT INTO item_origins (item_id, proposal_id, captured_at, capture_channel)
           VALUES ($1, $2, '2026-01-01T00:00:00Z', 'inbox')`,
          [itemId, proposalId],
        ),
      );

      const origin = await bodyOf(tenantA, itemId);

      expect(origin).toMatchObject({
        proposalId,
        capturedAt: "2026-01-01T00:00:00.000Z",
        captureTimeBasis: "legacyUnverified",
        captureChannel: "inbox",
        inboxItemId: null,
        sourceText: null,
        siblings: [],
      });
    });
  });

  describe("a transcript origin", () => {
    it("answers a null sourceText and an unknown capture time, and no Inbox item", async () => {
      const itemId = await createByHand(tenantA, "companies", { name: "From a call" });
      const transcriptId = randomUUID();
      const proposalId = randomUUID();
      // Raw insert: the row a confirmed transcript card writes (`resolveItemOriginSource`), whose confirm needs a
      // transcript, its Event and a matched card that this read does not depend on.
      await withTenantTransaction(runtimePool, tenantA, (client) =>
        client.query(
          `INSERT INTO item_origins (item_id, proposal_id, source_transcript_id, capture_channel, capture_time_basis)
           VALUES ($1, $2, $3, 'transcript', 'unknown')`,
          [itemId, proposalId, transcriptId],
        ),
      );

      expect(await bodyOf(tenantA, itemId)).toEqual({
        proposalId,
        inboxItemId: null,
        capturedAt: null,
        captureTimeBasis: "unknown",
        captureChannel: "transcript",
        sourceText: null,
        siblings: [],
      });
    });
  });

  describe("a transcript origin that names an Inbox item", () => {
    it("answers a null sourceText, since the text of an Inbox item is not the source of a transcript", async () => {
      const capture = await propose(tenantA, justACompany(), "Not the source");
      const itemId = await createByHand(tenantA, "companies", { name: "From a call" });
      // Raw insert: the confirm path writes no Inbox item id on a transcript row, so only a row written by hand can name one.
      await withTenantTransaction(runtimePool, tenantA, (client) =>
        client.query(
          `INSERT INTO item_origins (item_id, proposal_id, inbox_item_id, source_transcript_id, capture_channel, capture_time_basis)
           VALUES ($1, $2, $3, $4, 'transcript', 'unknown')`,
          [itemId, randomUUID(), capture.inboxItemId, randomUUID()],
        ),
      );

      const origin = await bodyOf(tenantA, itemId);

      expect(origin.sourceText).toBeNull();
      expect(origin.captureChannel).toBe("transcript");
    });
  });

  describe("the 404", () => {
    const expectNotFound = (error: unknown) => {
      expect(error).toBeInstanceOf(NotFoundError);
      expect(error).toMatchObject({ status: 404, code: "not_found" });
    };

    it("is the answer for an item created by hand", async () => {
      const itemId = await createByHand(tenantA, "companies", { name: "By hand" });

      expectNotFound(await failureOf(originOf(tenantA, itemId)));
    });

    it("is the answer for an id that names nothing", async () => {
      expectNotFound(await failureOf(originOf(tenantA, randomUUID())));
    });

    it("is the answer for a confirmed item that is in the Trash, though its origin row remains", async () => {
      const capture = await propose(tenantA, justACompany());
      const created = await confirm(tenantA, capture.cardId);
      const itemId = first(created.companies);
      expect((await bodyOf(tenantA, itemId)).proposalId).toBe(capture.cardId);

      await trash(tenantA, itemId);

      expectNotFound(await failureOf(originOf(tenantA, itemId)));
      const rows = await withTenantTransaction(runtimePool, tenantA, (client) =>
        client.query<{ item_id: string }>("SELECT item_id FROM item_origins WHERE item_id = $1", [itemId]),
      );
      expect(rows.rows).toHaveLength(1);
    });

    it("is the answer for another tenant's confirmed item, while that tenant still reads it", async () => {
      const capture = await propose(tenantA, companyAndPerson());
      const created = await confirm(tenantA, capture.cardId);
      const itemId = first(created.companies);

      expectNotFound(await failureOf(originOf(tenantB, itemId)));
      expect((await bodyOf(tenantA, itemId)).proposalId).toBe(capture.cardId);
    });

    it("has one body for all four causes, which names no id", async () => {
      const byHand = await createByHand(tenantA, "companies", { name: "By hand" });
      const trashedCapture = await propose(tenantA, justACompany("Trashed"));
      const trashedItem = first((await confirm(tenantA, trashedCapture.cardId)).companies);
      await trash(tenantA, trashedItem);
      const foreignCapture = await propose(tenantB, justACompany("Foreign"));
      const foreignItem = first((await confirm(tenantB, foreignCapture.cardId)).companies);

      const failures = await Promise.all([
        failureOf(originOf(tenantA, randomUUID())),
        failureOf(originOf(tenantA, byHand)),
        failureOf(originOf(tenantA, trashedItem)),
        failureOf(originOf(tenantA, foreignItem)),
      ]);

      for (const failure of failures) expectNotFound(failure);
      const shapes = failures.map((failure) =>
        failure instanceof NotFoundError
          ? { status: failure.status, code: failure.code, message: failure.message }
          : null,
      );
      expect(new Set(shapes.map((shape) => JSON.stringify(shape))).size).toBe(1);
      const message = failures[0] instanceof Error ? failures[0].message : "";
      for (const id of [byHand, trashedItem, foreignItem]) expect(message).not.toContain(id);
    });
  });

  describe("the id", () => {
    it.each(["not-a-uuid", "123", "00000000-0000-0000-0000-00000000000g"])(
      "refuses %s with a 400 on id",
      async (id) => {
        const error = await failureOf(originOf(tenantA, id));

        expect(error).toBeInstanceOf(ValidationError);
        expect(error).toMatchObject({ status: 400, details: { field: "id" } });
      },
    );

    it("refuses a request with no id", async () => {
      const error = await failureOf(
        runInTenant(tenantA, () => createItemOriginRouteHandler(runtimePool)({ params: {}, body: null })),
      );

      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toMatchObject({ details: { field: "id" } });
    });
  });
});
