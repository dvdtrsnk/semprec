import "../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { runAsSystem, runInTenant } from "@semprec/shared";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { createRelationWithClient } from "../chokePoint/relationOps.js";
import { withTransaction } from "../db/pool.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { TRANSCRIPTION_OWNER_PROCESS } from "../transcription/transcriptionJob.js";
import { createTranscriptSummariesRouteHandler } from "../transcription/transcriptionRouteHandlers.js";

let admin: Pool;
let runtime: Pool;
let tenant: string;
let foreign: string;

const summariesBodySchema = z.record(
  z.string(),
  z.object({ count: z.number().int(), doneCount: z.number().int() }).strict(),
);

/** Parses the handler body at the boundary, so every assertion reads a checked shape. */
function bodyOf(result: { status: number; body: unknown }) {
  expect(result.status).toBe(200);
  return summariesBodySchema.parse(JSON.parse(JSON.stringify(result.body)));
}

describe("GET /api/transcript-summaries (issue #1693)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("verify transcript summaries role", () =>
      runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    foreign = await createTestTenant(admin);
    for (const id of [tenant, foreign]) await runInTenant(id, () => seedSystem(runtime));
  });

  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });

  /** The writes a fixture is built from, in the tenant in scope: Events through the choke point, transcripts with the transcription process's system key `status`. */
  async function setup() {
    const cp = createChokePoint(runtime);
    const databases = await cp.listDatabases();
    const db = (key: string) => {
      const row = databases.find((d) => d.ownerModuleId === key);
      if (!row) throw new Error(`Missing ${key}`);
      return row.id;
    };
    const eventProperty = (await cp.listProperties(db("transcripts"))).find((p) => p.key === "event");
    if (!eventProperty) throw new Error("Missing Transcripts.event");
    const event = async (name: string) =>
      (await cp.createItem({ databaseId: db("events"), properties: { name, date: "2026-10-16T08:00:00Z" } })).id;
    /** A transcript with `status`, linked to `eventId` through its `event` relation. */
    const transcript = (eventId: string, status: string) =>
      withTransaction(runtime, async (client) => {
        const item = await createItemWithClient(
          client,
          { databaseId: db("transcripts"), properties: { name: `Part of ${eventId}`, status } },
          { allowedSystemKeys: ["status"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
        );
        await createRelationWithClient(client, {
          relationPropertyId: eventProperty.id,
          callerItemId: item.id,
          targetItemId: eventId,
        });
        return item.id;
      });
    return { cp, db, event, transcript };
  }

  const summaries = (query: string, pool: Pool = runtime) =>
    createTranscriptSummariesRouteHandler(pool)({ req: { url: `/api/transcript-summaries${query}` } });

  /** A pool whose connections record every statement they run, to count what one request issues. */
  function recordingPool(statements: string[]): Pool {
    return new Proxy(runtime, {
      get(target, property, receiver) {
        if (property !== "connect") {
          const value: unknown = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async (): Promise<PoolClient> => {
          const client = await target.connect();
          return new Proxy(client, {
            get(connection, key, innerReceiver) {
              if (key !== "query") {
                const value: unknown = Reflect.get(connection, key, innerReceiver);
                return typeof value === "function" ? value.bind(connection) : value;
              }
              return async (...args: unknown[]) => {
                if (typeof args[0] === "string") statements.push(args[0]);
                const result: unknown = await Reflect.apply(connection.query.bind(connection), undefined, args);
                return result;
              };
            },
          });
        };
      },
    });
  }

  it("returns count and doneCount for each of a day's events from one SQL statement", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const morning = await f.event("Morning call");
      const noon = await f.event("Lunch meeting");
      const evening = await f.event("Evening review");
      const notRequested = await f.event("Another day");
      await f.transcript(morning, "done");
      await f.transcript(morning, "processing");
      await f.transcript(morning, "error");
      await f.transcript(noon, "done");
      await f.transcript(noon, "done");
      await f.transcript(notRequested, "done");

      const statements: string[] = [];
      const body = bodyOf(await summaries(`?eventIds=${morning},${noon},${evening}`, recordingPool(statements)));
      expect(body).toEqual({
        [morning]: { count: 3, doneCount: 1 },
        [noon]: { count: 2, doneCount: 2 },
        [evening]: { count: 0, doneCount: 0 },
      });
      const queries = statements.filter(
        (sql) => !/^\s*(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql) && !sql.includes("set_config("),
      );
      expect(queries).toHaveLength(1);
    });
  });

  it("does not count a transcript in the Trash", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const event = await f.event("Two parts");
      await f.transcript(event, "done");
      const trashed = await f.transcript(event, "done");
      expect(bodyOf(await summaries(`?eventIds=${event}`))).toEqual({ [event]: { count: 2, doneCount: 2 } });
      await f.cp.softDeleteItem(f.db("transcripts"), trashed);
      expect(bodyOf(await summaries(`?eventIds=${event}`))).toEqual({ [event]: { count: 1, doneCount: 1 } });
    });
  });

  it("answers zeros for an event in the Trash, and its counts again after the restore", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const event = await f.event("Trashed meeting");
      await f.transcript(event, "done");
      await f.cp.softDeleteItem(f.db("events"), event);
      expect(bodyOf(await summaries(`?eventIds=${event}`))).toEqual({ [event]: { count: 0, doneCount: 0 } });
      await f.cp.restoreItem(f.db("events"), event);
      expect(bodyOf(await summaries(`?eventIds=${event}`))).toEqual({ [event]: { count: 1, doneCount: 1 } });
    });
  });

  it("answers zeros for an unknown id and for an id that is not an Event", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const event = await f.event("Linked");
      const transcript = await f.transcript(event, "done");
      const unknown = randomUUID();
      // The transcript's own id is an endpoint of the counted edge, on the other side of the relation.
      expect(bodyOf(await summaries(`?eventIds=${unknown},${transcript},${event}`))).toEqual({
        [unknown]: { count: 0, doneCount: 0 },
        [transcript]: { count: 0, doneCount: 0 },
        [event]: { count: 1, doneCount: 1 },
      });
    });
  });

  it("keys each answer by the id as the caller wrote it", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const event = await f.event("Upper case");
      await f.transcript(event, "done");
      const written = event.toUpperCase();
      expect(written).not.toBe(event);
      expect(bodyOf(await summaries(`?eventIds=${written}`))).toEqual({ [written]: { count: 1, doneCount: 1 } });
    });
  });

  it("accepts 100 ids and refuses 101", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const event = await f.event("One of a hundred");
      await f.transcript(event, "done");
      const others = Array.from({ length: 99 }, () => randomUUID());
      const body = bodyOf(await summaries(`?eventIds=${[...others, event].join(",")}`));
      expect(Object.keys(body).sort()).toEqual([...others, event].sort());
      expect(body[event]).toEqual({ count: 1, doneCount: 1 });
      for (const id of others) expect(body[id], id).toEqual({ count: 0, doneCount: 0 });

      const statements: string[] = [];
      await expect(
        summaries(`?eventIds=${[...others, event, randomUUID()].join(",")}`, recordingPool(statements)),
      ).rejects.toMatchObject({ status: 400, code: "validation_failed", details: { field: "eventIds" } });
      expect(statements).toEqual([]);
    });
  });

  it("refuses a missing, repeated, empty, malformed or duplicated eventIds before any statement runs", async () => {
    await runInTenant(tenant, async () => {
      const id = randomUUID();
      const other = randomUUID();
      const statements: string[] = [];
      const pool = recordingPool(statements);
      for (const query of [
        "",
        "?eventIds=",
        "?eventIds=nope",
        `?eventIds=${id},nope`,
        `?eventIds=${id},`,
        `?eventIds=${id},${id}`,
        `?eventIds=${id},${id.toUpperCase()}`,
        `?eventIds=${id}&eventIds=${other}`,
      ]) {
        await expect(summaries(query, pool), query).rejects.toMatchObject({
          status: 400,
          code: "validation_failed",
          details: { field: "eventIds" },
        });
      }
      await expect(createTranscriptSummariesRouteHandler(pool)({ req: {} })).rejects.toMatchObject({
        status: 400,
        code: "validation_failed",
        details: { field: "eventIds" },
      });
      expect(statements).toEqual([]);
    });
  });

  it("answers another tenant's event exactly like an unknown id, while its owner reads the real counts", async () => {
    const foreignEvent = await runInTenant(foreign, async () => {
      const f = await setup();
      const event = await f.event("Foreign meeting");
      await f.transcript(event, "done");
      await f.transcript(event, "processing");
      return event;
    });
    await runInTenant(tenant, async () => {
      const f = await setup();
      const own = await f.event("Own meeting");
      await f.transcript(own, "done");
      const unknown = randomUUID();
      const body = bodyOf(await summaries(`?eventIds=${own},${foreignEvent},${unknown}`));
      expect(body).toEqual({
        [own]: { count: 1, doneCount: 1 },
        [foreignEvent]: { count: 0, doneCount: 0 },
        [unknown]: { count: 0, doneCount: 0 },
      });
      const asForeign = JSON.stringify(bodyOf(await summaries(`?eventIds=${foreignEvent}`)));
      const asUnknown = JSON.stringify(bodyOf(await summaries(`?eventIds=${unknown}`)));
      expect(asForeign.split(foreignEvent).join("<id>")).toBe(asUnknown.split(unknown).join("<id>"));
    });
    // The owner's own request counts the same rows, so the zeros above are a refusal and not an empty fixture.
    await runInTenant(foreign, async () => {
      expect(bodyOf(await summaries(`?eventIds=${foreignEvent}`))).toEqual({
        [foreignEvent]: { count: 2, doneCount: 1 },
      });
    });
  });
});
