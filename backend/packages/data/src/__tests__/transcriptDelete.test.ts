import "../domainWriteHooks.js";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { DatabaseError, type Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { createItemWithClient, updateItemWithClient } from "../chokePoint/itemWrites.js";
import { writeComputed } from "../chokePoint/itemsStore.js";
import { withTransaction } from "../db/pool.js";
import { ConflictError, NotFoundError, ValidationError } from "../errors.js";
import { setInvalidationHook, type InvalidationEvent } from "../realtimeHook.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { matchTranscriptToEvent } from "../transcription/transcriptEventMatch.js";
import { TRANSCRIPTION_OWNER_PROCESS, transcriptionSourceLink } from "../transcription/transcriptionJob.js";
import { createTranscriptDeleteRouteHandler } from "../transcription/transcriptionRouteHandlers.js";
import { proposeSpeakerMappings } from "../transcription/transcriptSpeakerSuggestion.js";

let admin: Pool;
let runtime: Pool;
let tenant: string;
let foreign: string;
const USER = "4a3b2c1d-0e9f-4a8b-9c7d-6e5f4a3b2c1d";

const SEGMENTS = [
  { speaker: "SPEAKER_00", text: "Začneme.", startsAt: 0, endsAt: 2 },
  { speaker: "SPEAKER_01", text: "Dobře.", startsAt: 2.5, endsAt: 4 },
];

interface RowState {
  id: string;
  deleted_at: string | null;
  updated_at: string;
  status: string | null;
  history: unknown;
}

describe("DELETE /api/transcripts/:id and its restore (issue #1642)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("verify transcript delete role", () =>
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

  afterEach(() => {
    setInvalidationHook(() => {});
  });

  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });

  /**
   * A recording as the pipeline leaves it: a Files item and the Transcripts item step 0 links to it
   * (written with the transcription process's system keys), with the pairing card of the real
   * event-match producer and the speaker cards of the real speaker-suggestion producer.
   */
  async function recording(pool: Pool = runtime) {
    const cp = createChokePoint(pool);
    const databases = await cp.listDatabases();
    const db = (key: string) => {
      const row = databases.find((d) => d.ownerModuleId === key);
      if (!row) throw new Error(`Missing ${key}`);
      return row.id;
    };
    const file = await cp.createItem({ databaseId: db("files"), properties: { name: "recording.m4a" } });
    const transcript = await withTransaction(pool, async (client) => {
      const item = await createItemWithClient(
        client,
        {
          databaseId: db("transcripts"),
          properties: {
            name: "Schůzka",
            status: "done",
            link: transcriptionSourceLink(file.id),
            date: "2026-10-16T08:00:00Z",
          },
        },
        { allowedSystemKeys: ["status", "link", "date"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
      );
      await writeComputed(client, db("transcripts"), item.id, "segments", SEGMENTS);
      await matchTranscriptToEvent(client, { transcriptId: item.id, durationSeconds: 60 });
      await proposeSpeakerMappings(client, { transcriptId: item.id, suggestions: [] });
      return item;
    });
    const cards = (
      await pool.query<{ id: string }>(
        `SELECT card.id FROM items card JOIN item_relations r ON r.tenant_id = card.tenant_id AND r.item_a = card.id
         WHERE card.tenant_id = app_tenant_default() AND card.database_id = $1 AND r.item_b = $2 ORDER BY card.id`,
        [db("processingProposals"), transcript.id],
      )
    ).rows.map((row) => row.id);
    expect(cards).toHaveLength(3);
    return { cp, db, file, transcript, cards };
  }

  async function state(ids: string[]): Promise<RowState[]> {
    const { rows } = await runtime.query<RowState>(
      `SELECT id, to_char(deleted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS deleted_at,
              to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at,
              properties->>'status' AS status, properties->'history' AS history
       FROM items WHERE tenant_id = app_tenant_default() AND id = ANY($1::uuid[]) ORDER BY id`,
      [ids],
    );
    return rows;
  }

  const remove = (id: string, pool: Pool = runtime) =>
    createTranscriptDeleteRouteHandler(pool)({ params: { id }, identity: { user: { id: USER } } });

  /** Every queued job by key and task, read through graphile-worker's public `jobs` view. */
  async function jobs() {
    const { rows } = await admin.query<{ key: string | null; task_identifier: string }>(
      "SELECT key, task_identifier FROM graphile_worker.jobs ORDER BY id",
    );
    return rows;
  }

  /**
   * Fault injection (R1 P3, parent D5): makes every update of exactly one card row fail, so the card
   * owner's own reject fails inside the DELETE, which no production input can arrange. The id reaches
   * the trigger's WHEN clause as a literal quoted by Postgres (`format('%L')` in a DO block, read from
   * a session setting). Cleanup runs after `run` settled, on the same dedicated client; a failed
   * cleanup discards that client and is reported with any primary failure.
   */
  async function withCardUpdateFault(cardId: string, run: () => Promise<void>): Promise<void> {
    const client = await admin.connect();
    let primary: { error: unknown } | undefined;
    try {
      await client.query("SELECT set_config('semprec_test.fault_item', $1, false)", [cardId]);
      await client.query(`CREATE FUNCTION fail_card_update_test() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'card owner failure'; END $$`);
      await client.query(`DO $$ BEGIN EXECUTE format(
        'CREATE TRIGGER fail_card_update_test BEFORE UPDATE ON items FOR EACH ROW '
        'WHEN (NEW.id = %L::uuid) EXECUTE FUNCTION fail_card_update_test()',
        current_setting('semprec_test.fault_item')); END $$`);
      await run();
    } catch (error) {
      primary = { error };
    }
    let cleanup: { error: unknown } | undefined;
    try {
      await client.query("DROP TRIGGER IF EXISTS fail_card_update_test ON items");
      await client.query("DROP FUNCTION IF EXISTS fail_card_update_test()");
    } catch (error) {
      cleanup = { error };
    }
    client.release(cleanup ? new Error("Fault trigger cleanup failed; the connection is discarded") : undefined);
    if (primary && cleanup)
      throw new AggregateError([primary.error, cleanup.error], "Fault test and its cleanup failed");
    if (primary) throw primary.error;
    if (cleanup) throw cleanup.error;
  }

  it("trashes the transcript and its source together, rejects its open cards, and a second call changes nothing", async () => {
    await runInTenant(tenant, async () => {
      const f = await recording();
      const before = await state(f.cards);
      expect(before.map((row) => row.status).sort()).toEqual(["needsClarification", "needsClarification", "proposed"]);
      expect(await remove(f.transcript.id)).toEqual({
        status: 200,
        body: { id: f.transcript.id, fileItemId: f.file.id },
      });
      const [fileRow, transcriptRow] = [(await state([f.file.id]))[0], (await state([f.transcript.id]))[0]];
      expect(fileRow?.deleted_at).toEqual(expect.any(String));
      // One transaction: the two trashes share its now() exactly.
      expect(transcriptRow?.deleted_at).toBe(fileRow?.deleted_at);
      const cards = await state(f.cards);
      expect(cards.map((row) => row.status)).toEqual(["rejected", "rejected", "rejected"]);
      const after = await state([f.file.id, f.transcript.id, ...f.cards]);
      expect(await remove(f.transcript.id)).toEqual({
        status: 200,
        body: { id: f.transcript.id, fileItemId: f.file.id },
      });
      expect(await state([f.file.id, f.transcript.id, ...f.cards])).toEqual(after);
    });
  });

  it("brings the source back when the transcript is restored from the generic Trash, and the cards stay rejected", async () => {
    await runInTenant(tenant, async () => {
      const f = await recording();
      await remove(f.transcript.id);
      const rejected = await state(f.cards);
      const events: InvalidationEvent[] = [];
      setInvalidationHook((event) => {
        events.push(event);
      });
      const restored = await f.cp.restoreItem(f.db("transcripts"), f.transcript.id, USER, { writerKind: "user" });
      expect(restored?.deletedAt).toBeNull();
      expect((await state([f.file.id, f.transcript.id])).map((row) => row.deleted_at)).toEqual([null, null]);
      expect(await state(f.cards)).toEqual(rejected);
      expect(events.flatMap((event) => (event.scope === "item" ? [event.itemId] : [])).sort()).toEqual(
        [f.file.id, f.transcript.id].sort(),
      );
    });
  });

  it("leaves a source trashed on its own at another time in the Trash", async () => {
    await runInTenant(tenant, async () => {
      const f = await recording();
      await f.cp.softDeleteItem(f.db("files"), f.file.id);
      const separately = (await state([f.file.id]))[0]?.deleted_at;
      await remove(f.transcript.id);
      expect((await state([f.transcript.id]))[0]?.deleted_at).not.toBe(separately);
      await f.cp.restoreItem(f.db("transcripts"), f.transcript.id);
      expect((await state([f.transcript.id]))[0]?.deleted_at).toBeNull();
      expect((await state([f.file.id]))[0]?.deleted_at).toBe(separately);
    });
  });

  it.each([
    ["one microsecond apart within the same millisecond stays in the Trash", "2026-10-16 08:00:00.123457+00", false],
    ["at exactly the transcript's microsecond is restored with it", "2026-10-16 08:00:00.123456+00", true],
  ] as const)("a source trashed %s", async (_label, sourceEpoch, restoredTogether) => {
    await runInTenant(tenant, async () => {
      const f = await recording();
      await remove(f.transcript.id);
      // Two trash transactions within one millisecond cannot be produced on demand, so after the real
      // DELETE the two owned fixture rows' epochs are relabelled in the tenant's scope. Not a production
      // timestamp producer.
      await withTransaction(runtime, async (client) => {
        const relabelled = await client.query(
          `UPDATE items SET deleted_at = CASE WHEN id = $1 THEN '2026-10-16 08:00:00.123456+00'::timestamptz ELSE $3::timestamptz END
           WHERE tenant_id = app_tenant_default() AND id = ANY(ARRAY[$1, $2]::uuid[])`,
          [f.transcript.id, f.file.id, sourceEpoch],
        );
        expect(relabelled.rowCount).toBe(2);
      });
      // An ItemRow keeps whole milliseconds, so both read alike there.
      expect((await f.cp.findItemIncludingDeleted(f.file.id))?.deletedAt).toBe("2026-10-16T08:00:00.123Z");
      await f.cp.restoreItem(f.db("transcripts"), f.transcript.id);
      expect((await state([f.transcript.id]))[0]?.deleted_at).toBeNull();
      expect((await state([f.file.id]))[0]?.deleted_at).toBe(restoredTogether ? null : "2026-10-16T08:00:00.123457Z");
    });
  });

  it("fails the whole restore with 55P03 while another transaction holds the source, then a later restore succeeds", async () => {
    await runInTenant(tenant, async () => {
      const f = await recording();
      await remove(f.transcript.id);
      const trashed = await state([f.file.id, f.transcript.id, ...f.cards]);
      const jobsBefore = await jobs();
      const events: InvalidationEvent[] = [];
      setInvalidationHook((event) => {
        events.push(event);
      });
      let failure: unknown;
      await withTransaction(runtime, async (holder: PoolClient) => {
        const held = await holder.query("SELECT id FROM items WHERE id = $1 FOR UPDATE", [f.file.id]);
        expect(held.rowCount).toBe(1);
        try {
          await f.cp.restoreItem(f.db("transcripts"), f.transcript.id, USER, { writerKind: "user" });
        } catch (error) {
          failure = error;
        }
      });
      expect(failure).toBeInstanceOf(DatabaseError);
      expect(failure).toMatchObject({ code: "55P03" });
      expect(await state([f.file.id, f.transcript.id, ...f.cards])).toEqual(trashed);
      expect(await jobs()).toEqual(jobsBefore);
      expect(events).toEqual([]);
      await f.cp.restoreItem(f.db("transcripts"), f.transcript.id, USER, { writerKind: "user" });
      expect((await state([f.file.id, f.transcript.id])).map((row) => row.deleted_at)).toEqual([null, null]);
    });
  });

  it("rolls the whole delete back when the card owner's reject fails (R1 P3)", async () => {
    await runInTenant(tenant, async () => {
      const f = await recording();
      const before = await state([f.file.id, f.transcript.id, ...f.cards]);
      const jobsBefore = await jobs();
      const events: InvalidationEvent[] = [];
      setInvalidationHook((event) => {
        events.push(event);
      });
      // Cards are rejected in id order after the source Files item was trashed in the same transaction.
      const firstCard = f.cards[0];
      if (!firstCard) throw new Error("Expected open cards");
      await withCardUpdateFault(firstCard, async () => {
        await expect(remove(f.transcript.id)).rejects.toThrow("card owner failure");
      });
      expect(await state([f.file.id, f.transcript.id, ...f.cards])).toEqual(before);
      expect(await jobs()).toEqual(jobsBefore);
      expect(events).toEqual([]);
    });
  });

  it("rolls everything back when the transcript's source changes before the transcript is locked", async () => {
    await runInTenant(tenant, async () => {
      const f = await recording();
      const other = await f.cp.createItem({ databaseId: f.db("files"), properties: { name: "other.m4a" } });
      const before = await state([f.file.id, f.transcript.id, ...f.cards]);
      let relinked = false;
      // After the handler trashed the source, another transaction relinks the transcript and commits.
      const racingPool = new Proxy(runtime, {
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
                  const result: unknown = await Reflect.apply(connection.query.bind(connection), undefined, args);
                  const values = args[1];
                  if (
                    !relinked &&
                    typeof args[0] === "string" &&
                    args[0].startsWith("UPDATE items SET deleted_at = now()") &&
                    Array.isArray(values) &&
                    values[1] === f.file.id
                  ) {
                    relinked = true;
                    await withTransaction(runtime, (writer) =>
                      updateItemWithClient(
                        writer,
                        {
                          databaseId: f.db("transcripts"),
                          itemId: f.transcript.id,
                          propertiesPatch: { link: transcriptionSourceLink(other.id) },
                        },
                        { allowedSystemKeys: ["link"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
                      ),
                    );
                  }
                  return result;
                };
              },
            });
          };
        },
      });
      await expect(remove(f.transcript.id, racingPool)).rejects.toBeInstanceOf(ConflictError);
      expect(relinked).toBe(true);
      const after = await state([f.file.id, ...f.cards]);
      expect(after).toEqual(before.filter((row) => row.id !== f.transcript.id));
      expect((await state([f.transcript.id]))[0]?.deleted_at).toBeNull();
    });
  });

  it("trashes a transcript without a source link on its own", async () => {
    await runInTenant(tenant, async () => {
      const cp = createChokePoint(runtime);
      const transcripts = (await cp.listDatabases()).find((d) => d.ownerModuleId === "transcripts");
      if (!transcripts) throw new Error("Missing transcripts");
      const transcript = await cp.createItem({ databaseId: transcripts.id, properties: { name: "Manual" } });
      expect(await remove(transcript.id)).toEqual({ status: 200, body: { id: transcript.id, fileItemId: null } });
      expect((await state([transcript.id]))[0]?.deleted_at).toEqual(expect.any(String));
    });
  });

  it("answers an unknown id, another database's id and another tenant's id with the same 404", async () => {
    const foreignTranscript = await runInTenant(foreign, async () => (await recording()).transcript.id);
    const outcome = async (id: string) => {
      try {
        await runInTenant(tenant, () => remove(id));
        return { ok: true };
      } catch (error) {
        if (!(error instanceof NotFoundError)) throw error;
        return { name: error.name, code: error.code, message: error.message };
      }
    };
    const own = await runInTenant(tenant, () => recording());
    const random = await outcome("2f3e4d5c-6b7a-4980-a1b2-c3d4e5f6a7b8");
    expect(random).toMatchObject({ code: "not_found", message: "Transcript not found" });
    expect(await outcome(foreignTranscript)).toEqual(random);
    expect(await outcome(own.file.id)).toEqual(random);
    await runInTenant(foreign, async () => {
      const rows = await runtime.query<{ deleted_at: Date | null }>(
        "SELECT deleted_at FROM items WHERE tenant_id = app_tenant_default() AND id = $1",
        [foreignTranscript],
      );
      expect(rows.rows).toEqual([{ deleted_at: null }]);
    });
    await expect(runInTenant(tenant, () => remove("not-a-uuid"))).rejects.toBeInstanceOf(ValidationError);
  });
});
