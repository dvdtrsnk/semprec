import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { runInTenant } from "@semprec/shared";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import * as itemsStore from "../../chokePoint/itemsStore.js";
import { loadRelationEdgeContext } from "../../chokePoint/relationEdgeContext.js";
import {
  assertRelationCreatableWithClient,
  assertRelationTargetLinkableWithClient,
  createRelationIfAbsentWithClient,
  createRelationWithClient,
  type UpdateRelationInput,
} from "../../chokePoint/relationOps.js";
import { SYSTEM_WRITER, type WriterIdentity } from "../../chokePoint/writerKind.js";
import { withTransaction } from "../../db/pool.js";
import { ValueLinkBusyError } from "../../errors.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { setSelfPersonId } from "../../selfPerson.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { eventParticipantEdgeWriteHook } from "../eventParticipantEdgeHook.js";

let admin: Pool;
let runtime: Pool;
let tenant: string;

const USER: WriterIdentity = { writerKind: "user" };
const AGENT: WriterIdentity = { writerKind: "agent", onBehalfOfUserId: randomUUID() };
const PENDING = { status: "pending", email: "petr@example.com", mailboxId: randomUUID() };

/** A refused participant edge write: `validation_failed` on `metadata` with the stable `reason`. */
function refusedWith(reason: string) {
  return { status: 400, code: "validation_failed", details: { field: "metadata", reason } };
}

/** A participant edge write refused for the text form of an item id: `validation_failed` on the end that carries it. */
function refusedItemId(field: "callerItemId" | "targetItemId") {
  return { status: 400, code: "validation_failed", details: { field, reason: "nonCanonicalItemId" } };
}

describe("Event participant edge write hook (issue #1757)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(runtime));
  });

  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });

  /** The fixture of one test, built in the tenant in scope through the choke point. */
  async function setup() {
    const cp = createChokePoint(runtime);
    const databases = await cp.listDatabases();
    const db = (key: string) => {
      const row = databases.find((d) => d.ownerModuleId === key);
      if (!row) throw new Error(`Missing ${key}`);
      return row.id;
    };
    const property = async (database: string, key: string) => {
      const found = (await cp.listProperties(db(database))).find((p) => p.key === key);
      if (!found) throw new Error(`Missing ${database}.${key}`);
      return found.id;
    };
    const eventsPeople = await property("events", "people");
    const peopleEvents = await property("people", "events");
    // An Event needs a `date`; every other database of these fixtures needs a title only.
    const item = async (database: string, name: string) =>
      (
        await cp.createItem({
          databaseId: db(database),
          properties: database === "events" ? { name, date: "2026-11-16" } : { name },
        })
      ).id;
    const event = await item("events", "Client meeting");
    const petr = await item("people", "Petr");
    const edge = (personId: string) => ({
      relationPropertyId: eventsPeople,
      callerItemId: event,
      targetItemId: personId,
    });
    /** The metadata of the Event's stored edge to `personId`, or `null` when there is none. */
    const stored = async (personId: string, eventId = event) => {
      const edges = (await cp.listItemRelations(eventId, eventsPeople)) ?? [];
      return edges.find((entry) => entry.targetItemId === personId)?.metadata ?? null;
    };
    const setSelf = (personId: string | null) =>
      withTransaction(runtime, (client) => setSelfPersonId(client, personId));
    /** The two public write operations of an edge: add or replace, and replace the metadata of an existing edge. */
    const writesBy = (writer: WriterIdentity) => [
      (input: UpdateRelationInput) => cp.createRelation(input, writer),
      (input: UpdateRelationInput) => cp.updateRelation(input, writer),
    ];
    return { cp, db, property, eventsPeople, peopleEvents, item, event, petr, edge, stored, setSelf, writesBy };
  }

  describe("accepted shapes", () => {
    it("stores a public edge without metadata as {}", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        await f.cp.createRelation(f.edge(f.petr), USER);
        expect(await f.stored(f.petr)).toEqual({});
      }));

    it("stores a public edge with a plain role, and a later public change of that role", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        await f.setSelf(f.petr);
        await f.cp.createRelation({ ...f.edge(f.petr), metadata: { role: "attendee" } }, USER);
        expect(await f.stored(f.petr)).toEqual({ role: "attendee" });
        await f.cp.updateRelation({ ...f.edge(f.petr), metadata: { role: "organizer" } }, USER);
        expect(await f.stored(f.petr)).toEqual({ role: "organizer" });
      }));

    it("stores an invitation written with the system writer kind, and its later change by that writer", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        await f.cp.createRelation({ ...f.edge(f.petr), metadata: { invitation: PENDING } }, SYSTEM_WRITER);
        expect(await f.stored(f.petr)).toEqual({ invitation: PENDING });
        const accepted = { ...PENDING, status: "accepted", respondedAt: "2026-11-11T09:30:00Z" };
        await f.cp.updateRelation({ ...f.edge(f.petr), metadata: { role: "attendee", invitation: accepted } });
        expect(await f.stored(f.petr)).toEqual({ role: "attendee", invitation: accepted });
      }));

    it.each([USER, AGENT])("lets a $writerKind writer repeat the stored invitation while it sets the role", (writer) =>
      runInTenant(tenant, async () => {
        const f = await setup();
        await f.cp.createRelation({ ...f.edge(f.petr), metadata: { invitation: PENDING } });
        await f.cp.createRelation({ ...f.edge(f.petr), metadata: { role: "attendee", invitation: PENDING } }, writer);
        expect(await f.stored(f.petr)).toEqual({ role: "attendee", invitation: PENDING });
        await f.cp.updateRelation({ ...f.edge(f.petr), metadata: { invitation: PENDING } }, writer);
        expect(await f.stored(f.petr)).toEqual({ invitation: PENDING });
      }),
    );

    it("lets the organizer edge be written again while it is the Event's only organizer edge", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        await f.setSelf(f.petr);
        await f.cp.createRelation({ ...f.edge(f.petr), metadata: { role: "organizer" } }, USER);
        await f.cp.createRelation({ ...f.edge(f.petr), metadata: { role: "organizer" } }, USER);
        expect(await f.stored(f.petr)).toEqual({ role: "organizer" });
      }));
  });

  describe("refused shapes", () => {
    it.each<[string, Record<string, unknown>]>([
      ["an unknown key", { note: "x" }],
      ["a role outside the two roles", { role: "owner" }],
      ["an invitation status outside the four statuses", { invitation: { ...PENDING, status: "sent" } }],
      ["an invitation on an organizer edge", { role: "organizer", invitation: PENDING }],
    ])("refuses %s from a public writer and from the system writer, and stores no edge", (_label, metadata) =>
      runInTenant(tenant, async () => {
        const f = await setup();
        await f.setSelf(f.petr);
        for (const writer of [USER, SYSTEM_WRITER]) {
          await expect(f.cp.createRelation({ ...f.edge(f.petr), metadata }, writer)).rejects.toMatchObject(
            refusedWith("invalidParticipantMetadata"),
          );
        }
        expect(await f.stored(f.petr)).toBeNull();
      }),
    );

    it("refuses invalid metadata on a metadata replace and leaves the stored edge as it was", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        await f.cp.createRelation({ ...f.edge(f.petr), metadata: { role: "attendee" } }, USER);
        await expect(
          f.cp.updateRelation({ ...f.edge(f.petr), metadata: { role: "attendee", note: "x" } }, USER),
        ).rejects.toMatchObject(refusedWith("invalidParticipantMetadata"));
        expect(await f.stored(f.petr)).toEqual({ role: "attendee" });
      }));
  });

  describe("the organizer", () => {
    it("refuses an organizer edge to a person other than the linked one, and while no person is linked", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const metadata = { role: "organizer" };
        for (const writer of [USER, SYSTEM_WRITER]) {
          await expect(f.cp.createRelation({ ...f.edge(f.petr), metadata }, writer)).rejects.toMatchObject(
            refusedWith("organizerNotSelf"),
          );
        }
        const self = await f.item("people", "Me");
        await f.setSelf(self);
        await expect(f.cp.createRelation({ ...f.edge(f.petr), metadata }, USER)).rejects.toMatchObject(
          refusedWith("organizerNotSelf"),
        );
        expect(await f.stored(f.petr)).toBeNull();

        await f.cp.createRelation({ ...f.edge(self), metadata }, USER);
        expect(await f.stored(self)).toEqual(metadata);
      }));

    it("refuses a second organizer edge on the same Event and allows one on another Event", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const metadata = { role: "organizer" };
        const first = await f.item("people", "Me before");
        await f.setSelf(first);
        await f.cp.createRelation({ ...f.edge(first), metadata }, USER);
        // The linked person changes, so a second person passes the self check on the same Event.
        await f.setSelf(f.petr);
        for (const writer of [USER, SYSTEM_WRITER]) {
          await expect(f.cp.createRelation({ ...f.edge(f.petr), metadata }, writer)).rejects.toMatchObject(
            refusedWith("organizerAlreadySet"),
          );
        }
        expect(await f.stored(f.petr)).toBeNull();
        expect(await f.stored(first)).toEqual(metadata);

        const other = await f.item("events", "Another meeting");
        await f.cp.createRelation({ ...f.edge(f.petr), callerItemId: other, metadata }, USER);
        expect(await f.stored(f.petr, other)).toEqual(metadata);
      }));
  });

  describe("the invitation is written by the system writer only", () => {
    it.each([USER, AGENT])("refuses a $writerKind writer that adds an invitation to a new edge", (writer) =>
      runInTenant(tenant, async () => {
        const f = await setup();
        await expect(
          f.cp.createRelation({ ...f.edge(f.petr), metadata: { invitation: PENDING } }, writer),
        ).rejects.toMatchObject(refusedWith("invitationReadOnly"));
        expect(await f.stored(f.petr)).toBeNull();
      }),
    );

    it("refuses a public writer that adds an invitation to an edge stored without one", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        await f.cp.createRelation({ ...f.edge(f.petr), metadata: { role: "attendee" } }, USER);
        for (const write of f.writesBy(USER)) {
          await expect(
            write({ ...f.edge(f.petr), metadata: { role: "attendee", invitation: PENDING } }),
          ).rejects.toMatchObject(refusedWith("invitationReadOnly"));
        }
        expect(await f.stored(f.petr)).toEqual({ role: "attendee" });
      }));

    it.each([USER, AGENT])("refuses a $writerKind writer that changes the stored invitation", (writer) =>
      runInTenant(tenant, async () => {
        const f = await setup();
        await f.cp.createRelation({ ...f.edge(f.petr), metadata: { invitation: PENDING } });
        const changes = [
          { ...PENDING, status: "accepted" },
          { ...PENDING, email: "other@example.com" },
          { ...PENDING, sentAt: "2026-11-11T08:00:00Z" },
        ];
        for (const invitation of changes) {
          for (const write of f.writesBy(writer)) {
            await expect(write({ ...f.edge(f.petr), metadata: { invitation } })).rejects.toMatchObject(
              refusedWith("invitationReadOnly"),
            );
          }
        }
        expect(await f.stored(f.petr)).toEqual({ invitation: PENDING });
      }),
    );

    it.each([USER, AGENT])("refuses a $writerKind writer that leaves the stored invitation out", (writer) =>
      runInTenant(tenant, async () => {
        const f = await setup();
        await f.cp.createRelation({ ...f.edge(f.petr), metadata: { invitation: PENDING } });
        await expect(f.cp.createRelation(f.edge(f.petr), writer)).rejects.toMatchObject(
          refusedWith("invitationReadOnly"),
        );
        await expect(
          f.cp.createRelation({ ...f.edge(f.petr), metadata: { role: "attendee" } }, writer),
        ).rejects.toMatchObject(refusedWith("invitationReadOnly"));
        await expect(f.cp.updateRelation({ ...f.edge(f.petr), metadata: {} }, writer)).rejects.toMatchObject(
          refusedWith("invitationReadOnly"),
        );
        expect(await f.stored(f.petr)).toEqual({ invitation: PENDING });
      }),
    );

    it("compares with the stored edge when the caller writes the item ids in upper case", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        await f.cp.createRelation({ ...f.edge(f.petr), metadata: { invitation: PENDING } });
        const upper = {
          relationPropertyId: f.eventsPeople,
          callerItemId: f.event.toUpperCase(),
          targetItemId: f.petr.toUpperCase(),
        };
        await expect(f.cp.createRelation(upper, USER)).rejects.toMatchObject(refusedWith("invitationReadOnly"));
        expect(await f.stored(f.petr)).toEqual({ invitation: PENDING });
        await f.cp.createRelation({ ...upper, metadata: { role: "attendee", invitation: PENDING } }, USER);
        expect(await f.stored(f.petr)).toEqual({ role: "attendee", invitation: PENDING });
      }));

    // Postgres reads these as the same UUID, so the write itself would find the stored edge and replace its metadata.
    describe.each<[string, (id: string) => string]>([
      ["in braces", (id) => `{${id}}`],
      ["without hyphens", (id) => id.replaceAll("-", "")],
      ["with a hyphen after every four digits", (id) => (id.replaceAll("-", "").match(/.{4}/g) ?? []).join("-")],
    ])("an item id written %s", (_label, respell) => {
      it.each([USER, AGENT, SYSTEM_WRITER])(
        "is refused from a $writerKind writer on either end and through either property, and the stored invitation stays",
        (writer) =>
          runInTenant(tenant, async () => {
            const f = await setup();
            await f.cp.createRelation({ ...f.edge(f.petr), metadata: { invitation: PENDING } });
            const attempts: Array<[Omit<UpdateRelationInput, "metadata">, "callerItemId" | "targetItemId"]> = [
              [f.edge(respell(f.petr)), "targetItemId"],
              [{ ...f.edge(f.petr), callerItemId: respell(f.event) }, "callerItemId"],
              [
                { relationPropertyId: f.peopleEvents, callerItemId: respell(f.petr), targetItemId: f.event },
                "callerItemId",
              ],
              [
                { relationPropertyId: f.peopleEvents, callerItemId: f.petr, targetItemId: respell(f.event) },
                "targetItemId",
              ],
            ];
            for (const [input, field] of attempts) {
              for (const write of f.writesBy(writer)) {
                // With empty metadata, with a role only, and with the stored invitation repeated: the id decides each time.
                for (const metadata of [{}, { role: "attendee" }, { invitation: PENDING }]) {
                  await expect(write({ ...input, metadata })).rejects.toMatchObject(refusedItemId(field));
                }
              }
            }
            expect(await f.stored(f.petr)).toEqual({ invitation: PENDING });
          }),
      );

      it("is refused on an insert-only write and on a check that writes nothing", () =>
        runInTenant(tenant, async () => {
          const f = await setup();
          const jana = await f.item("people", "Jana");
          const input = f.edge(respell(jana));
          await expect(
            withTransaction(runtime, (client) => createRelationIfAbsentWithClient(client, input, undefined, USER)),
          ).rejects.toMatchObject(refusedItemId("targetItemId"));
          await expect(
            withTransaction(runtime, (client) => assertRelationCreatableWithClient(client, input, undefined, USER)),
          ).rejects.toMatchObject(refusedItemId("targetItemId"));
          expect(await f.stored(jana)).toBeNull();
        }));
    });

    it("makes a public write wait for a system write of the same Event and then refuses it", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        let release: () => void = () => {};
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        let written: () => void = () => {};
        const wrote = new Promise<void>((resolve) => {
          written = resolve;
        });
        const systemWrite = withTransaction(runtime, async (client) => {
          await createRelationWithClient(client, { ...f.edge(f.petr), metadata: { invitation: PENDING } });
          written();
          await released;
        });
        try {
          await wrote;
          // Starts while the system write is uncommitted: an unlocked check would read no stored invitation.
          const publicWrite = f.cp.createRelation(f.edge(f.petr), USER).then(
            () => "stored",
            (error: unknown) => error,
          );
          await waitForRowLockWaiter();
          release();
          await systemWrite;
          expect(await publicWrite).toMatchObject(refusedWith("invitationReadOnly"));
        } finally {
          release();
          await systemWrite.catch(() => undefined);
        }
        expect(await f.stored(f.petr)).toEqual({ invitation: PENDING });
      }));
  });

  describe("from the person's side", () => {
    it("applies the same rules to a write through People.events", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const fromPerson = { relationPropertyId: f.peopleEvents, callerItemId: f.petr, targetItemId: f.event };
        await expect(f.cp.createRelation({ ...fromPerson, metadata: { note: "x" } }, USER)).rejects.toMatchObject(
          refusedWith("invalidParticipantMetadata"),
        );
        await expect(
          f.cp.createRelation({ ...fromPerson, metadata: { invitation: PENDING } }, USER),
        ).rejects.toMatchObject(refusedWith("invitationReadOnly"));
        await expect(
          f.cp.createRelation({ ...fromPerson, metadata: { role: "organizer" } }, USER),
        ).rejects.toMatchObject(refusedWith("organizerNotSelf"));
        expect(await f.stored(f.petr)).toBeNull();

        await f.cp.createRelation({ ...fromPerson, metadata: { invitation: PENDING } });
        expect(await f.stored(f.petr)).toEqual({ invitation: PENDING });
        await expect(f.cp.createRelation(fromPerson, USER)).rejects.toMatchObject(refusedWith("invitationReadOnly"));
        await expect(f.cp.updateRelation({ ...fromPerson, metadata: {} }, USER)).rejects.toMatchObject(
          refusedWith("invitationReadOnly"),
        );
        expect(await f.stored(f.petr)).toEqual({ invitation: PENDING });

        await f.cp.createRelation({ ...fromPerson, metadata: { role: "attendee", invitation: PENDING } }, USER);
        expect(await f.stored(f.petr)).toEqual({ role: "attendee", invitation: PENDING });

        const self = await f.item("people", "Me");
        await f.setSelf(self);
        await f.cp.createRelation({ ...fromPerson, callerItemId: self, metadata: { role: "organizer" } }, USER);
        expect(await f.stored(self)).toEqual({ role: "organizer" });
      }));
  });

  describe("writes the rules do not judge", () => {
    it("leaves the metadata of other relations alone, a people relation of another database included", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const metadata = { invitation: "anything", note: 1 };
        const task = await f.item("tasks", "Call Petr");
        const tasksPeople = await f.property("tasks", "people");
        await f.cp.createRelation(
          { relationPropertyId: tasksPeople, callerItemId: task, targetItemId: f.petr, metadata },
          USER,
        );
        const company = await f.item("companies", "Acme");
        const eventsCompany = await f.property("events", "company");
        await f.cp.createRelation(
          { relationPropertyId: eventsCompany, callerItemId: f.event, targetItemId: company, metadata },
          USER,
        );
        // Files.area has no inverse property, so its definition has one side only.
        const file = await f.item("files", "Notes");
        const area = await f.item("areas", "Work");
        const filesArea = await f.property("files", "area");
        await f.cp.createRelation(
          { relationPropertyId: filesArea, callerItemId: file, targetItemId: area, metadata },
          USER,
        );
        expect((await f.cp.listItemRelations(task, tasksPeople))?.map((entry) => entry.metadata)).toEqual([metadata]);
        expect((await f.cp.listItemRelations(f.event, eventsCompany))?.map((entry) => entry.metadata)).toEqual([
          metadata,
        ]);
        expect((await f.cp.listItemRelations(file, filesArea))?.map((entry) => entry.metadata)).toEqual([metadata]);
      }));

    it("lets an insert-only public write without an invitation pass an edge that stores one", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        await f.cp.createRelation({ ...f.edge(f.petr), metadata: { invitation: PENDING } });
        const kept = await withTransaction(runtime, (client) =>
          createRelationIfAbsentWithClient(client, f.edge(f.petr), undefined, USER),
        );
        expect(kept.inserted).toBe(false);
        expect(await f.stored(f.petr)).toEqual({ invitation: PENDING });

        const jana = await f.item("people", "Jana");
        const added = await withTransaction(runtime, (client) =>
          createRelationIfAbsentWithClient(client, f.edge(jana), undefined, USER),
        );
        expect(added.inserted).toBe(true);
        expect(await f.stored(jana)).toEqual({});
      }));

    it("judges an insert-only organizer edge by the organizer rules and lets it leave a stored invitation", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const organizer = { role: "organizer" };
        const insertOnly = (eventId: string) =>
          withTransaction(runtime, (client) =>
            createRelationIfAbsentWithClient(
              client,
              { ...f.edge(f.petr), callerItemId: eventId, metadata: organizer },
              undefined,
              USER,
            ),
          );
        await expect(insertOnly(f.event)).rejects.toMatchObject(refusedWith("organizerNotSelf"));
        expect(await f.stored(f.petr)).toBeNull();

        await f.setSelf(f.petr);
        await f.cp.createRelation({ ...f.edge(f.petr), metadata: { invitation: PENDING } });
        expect((await insertOnly(f.event)).inserted).toBe(false);
        expect(await f.stored(f.petr)).toEqual({ invitation: PENDING });

        const other = await f.item("events", "Another meeting");
        expect((await insertOnly(other)).inserted).toBe(true);
        expect(await f.stored(f.petr, other)).toEqual(organizer);
      }));

    it("refuses an insert-only public write that carries an invitation, stored or not", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        await f.cp.createRelation({ ...f.edge(f.petr), metadata: { invitation: PENDING } });
        const jana = await f.item("people", "Jana");
        const forged = { invitation: { ...PENDING, status: "accepted" } };
        for (const personId of [f.petr, jana]) {
          await expect(
            withTransaction(runtime, (client) =>
              createRelationIfAbsentWithClient(client, { ...f.edge(personId), metadata: forged }, undefined, USER),
            ),
          ).rejects.toMatchObject(refusedWith("invitationReadOnly"));
        }
        expect(await f.stored(f.petr)).toEqual({ invitation: PENDING });
        expect(await f.stored(jana)).toBeNull();
      }));
  });

  describe("checks that write nothing", () => {
    it("judges the metadata of an edge that is only checked for creation", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const check = (metadata: Record<string, unknown>, writer: WriterIdentity) =>
          withTransaction(runtime, (client) =>
            assertRelationCreatableWithClient(client, { ...f.edge(f.petr), metadata }, undefined, writer),
          );
        await expect(check({ invitation: PENDING }, USER)).rejects.toMatchObject(refusedWith("invitationReadOnly"));
        await expect(check({ invitation: PENDING }, SYSTEM_WRITER)).resolves.toBeUndefined();
        expect(await f.stored(f.petr)).toBeNull();
      }));

    it("accepts a person as the participant of an Event that is only proposed", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        await expect(
          withTransaction(runtime, (client) =>
            assertRelationTargetLinkableWithClient(client, {
              relationPropertyId: f.eventsPeople,
              targetItemId: f.petr,
            }),
          ),
        ).resolves.toBeUndefined();
      }));
  });

  describe("the Event row lock", () => {
    const hookCall = (
      f: Awaited<ReturnType<typeof setup>>,
      lockMode?: "nowait",
      write: { metadata?: Record<string, unknown>; insertOnly?: true } = {},
    ) =>
      withTransaction(runtime, async (client) =>
        eventParticipantEdgeWriteHook({
          client,
          edgeContext: await loadRelationEdgeContext(client, f.eventsPeople),
          callerItemId: f.event,
          targetItemId: f.petr,
          writer: SYSTEM_WRITER,
          lockMode,
          ...write,
        }),
      );

    it("reports a held Event row as busy instead of waiting when the write asks not to wait", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        await expect(hookCall(f, "nowait")).resolves.toBeUndefined();
        await withTransaction(runtime, async (holder) => {
          await itemsStore.lockItemById(holder, f.db("events"), f.event);
          await expect(hookCall(f, "nowait")).rejects.toBeInstanceOf(ValueLinkBusyError);
        });
      }));

    it("takes no Event row lock for an insert-only write without an invitation that is not an organizer edge", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        await withTransaction(runtime, async (holder) => {
          await itemsStore.lockItemById(holder, f.db("events"), f.event);
          // A write that asked for the lock would be refused as busy while `holder` has the row.
          for (const metadata of [undefined, {}, { role: "attendee" }]) {
            await expect(hookCall(f, "nowait", { metadata, insertOnly: true })).resolves.toBeUndefined();
          }
        });
      }));

    it("takes the Event row lock for an insert-only write that carries an invitation or is an organizer edge", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        await f.setSelf(f.petr);
        for (const metadata of [{ invitation: PENDING }, { role: "organizer" }]) {
          await expect(hookCall(f, "nowait", { metadata, insertOnly: true })).resolves.toBeUndefined();
        }
        await withTransaction(runtime, async (holder) => {
          await itemsStore.lockItemById(holder, f.db("events"), f.event);
          for (const metadata of [{ invitation: PENDING }, { role: "organizer" }]) {
            await expect(hookCall(f, "nowait", { metadata, insertOnly: true })).rejects.toBeInstanceOf(
              ValueLinkBusyError,
            );
          }
        });
      }));

    it("lets an insert-only write add a participant while another transaction holds the Event's row lock", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        let insert: Promise<{ inserted: boolean }> | undefined;
        try {
          const added = await withTransaction(runtime, async (holder) => {
            await itemsStore.lockItemById(holder, f.db("events"), f.event);
            insert = withTransaction(runtime, (client) =>
              createRelationIfAbsentWithClient(client, f.edge(f.petr), undefined, USER),
            );
            // A write that waited for `holder` could not end inside this callback, so the wait is given a limit.
            return settledWithin(insert);
          });
          expect(added).toMatchObject({ inserted: true });
        } finally {
          // After the holder ended, a write that did wait ends too; it is settled before the test does.
          await insert?.catch(() => undefined);
        }
        expect(await f.stored(f.petr)).toEqual({});
      }));
  });

  /**
   * The value of `work`, or the string `"still waiting"` when it has not settled after `milliseconds`. The
   * limit only ends a wait that would otherwise last as long as a lock is held; a write that does not wait
   * settles long before it.
   */
  async function settledWithin<T>(work: Promise<T>, milliseconds = 10_000): Promise<T | "still waiting"> {
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<"still waiting">((resolve) => {
      timer = setTimeout(() => resolve("still waiting"), milliseconds);
    });
    try {
      return await Promise.race([work, limit]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Resolves once a backend of this database waits for a row lock taken with `FOR UPDATE`; read through `pg_stat_activity`. */
  async function waitForRowLockWaiter(): Promise<void> {
    for (let attempt = 0; attempt < 250; attempt += 1) {
      const { rows } = await admin.query<{ waiting: number }>(
        `SELECT count(*)::int AS waiting FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%FOR UPDATE%'`,
      );
      if ((rows[0]?.waiting ?? 0) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("No write waited for the Event row lock");
  }
});
