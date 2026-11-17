import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { runInTenant } from "@semprec/shared";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createUser } from "../../auth/usersStore.js";
import { materializeEventOccurrence } from "../../calendar/materializeEventOccurrence.js";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import * as itemsStore from "../../chokePoint/itemsStore.js";
import type { WriterIdentity } from "../../chokePoint/writerKind.js";
import { withTransaction } from "../../db/pool.js";
import { ValidationError } from "../../errors.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { matchTranscriptToEvent } from "../../transcription/transcriptEventMatch.js";
import { TRANSCRIPTION_OWNER_PROCESS } from "../../transcription/transcriptionJob.js";
import { assertValidProposalEnvelope, type ProposalEnvelope } from "../inboxTickAction.js";
import { reviseProposalWithClient } from "../proposalActions.js";

let admin: Pool;
let runtime: Pool;
let tenant: string;
let foreign: string;
let userId: string;

const USER: WriterIdentity = { writerKind: "user" };

/** A Standup that repeats Monday to Friday from Monday 12 October 2026, 9:00-9:30. */
const STANDUP = {
  name: "Standup",
  type: "standup",
  date: "2026-10-12",
  timeFrom: "09:00",
  timeTo: "09:30",
  recurrence: { kind: "weekdays", days: ["mon", "tue", "wed", "thu", "fri"] },
};

async function seededTenant(): Promise<{ tenantId: string; userId: string }> {
  const tenantId = await createTestTenant(admin);
  const user = await createUser(admin, {
    tenantId,
    email: `${randomUUID()}@example.com`,
    passwordHash: "unused",
    locale: "en",
  });
  await runInTenant(tenantId, () => seedSystem(runtime));
  return { tenantId, userId: user.id };
}

function eventLink(target: string): ProposalEnvelope {
  return { entityKind: "relation", target, properties: { propertyKey: "event" } };
}

describe("a synthetic occurrence id as the target of a proposal (issue gh-1850)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    const seeded = await seededTenant();
    tenant = seeded.tenantId;
    userId = seeded.userId;
    foreign = (await seededTenant()).tenantId;
  });

  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });

  async function setup() {
    const cp = createChokePoint(runtime);
    const databases = await cp.listDatabases();
    const db = (key: string) => {
      const row = databases.find((d) => d.ownerModuleId === key);
      if (!row) throw new Error(`Missing ${key}`);
      return row.id;
    };
    const event = async (properties: Record<string, unknown>) =>
      (await cp.createItem({ databaseId: db("events"), properties }, userId, userId, USER)).id;
    const validate = (envelope: ProposalEnvelope) =>
      withTransaction(runtime, (client) => assertValidProposalEnvelope(client, envelope));
    const refusal = (envelope: ProposalEnvelope) => validate(envelope).catch((error: unknown) => error);
    /** The card `matchTranscriptToEvent` makes for a recording that overlaps no Event, and its transcript. */
    const newMeetingCard = async () =>
      withTransaction(runtime, async (client) => {
        const transcript = await createItemWithClient(
          client,
          { databaseId: db("transcripts"), properties: { date: "2026-10-14T07:01:00.000Z" } },
          { allowedSystemKeys: ["date"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
        );
        await matchTranscriptToEvent(client, { transcriptId: transcript.id, durationSeconds: 1200 });
        const { rows } = await client.query<{ id: string }>(
          "SELECT id FROM items WHERE database_id = $1 AND properties ->> 'kind' = 'transcript'",
          [db("processingProposals")],
        );
        if (!rows[0]) throw new Error("The match stored no card");
        return rows[0].id;
      });
    const revise = (cardId: string, envelope: ProposalEnvelope) =>
      withTransaction(runtime, (client) =>
        reviseProposalWithClient(client, { processingProposalsDatabaseId: db("processingProposals") }, cardId, {
          message: "Revised by user.",
          ...envelope,
        }),
      );
    const storedProposal = async (cardId: string) =>
      (await withTransaction(runtime, (client) => itemsStore.getItemById(client, db("processingProposals"), cardId)))
        ?.properties.proposal;
    return { cp, db, event, validate, refusal, newMeetingCard, revise, storedProposal };
  }

  it("accepts the id of an occurrence of a live recurring Event, in either letter case of the series id", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const series = await f.event(STANDUP);

      await expect(f.validate(eventLink(`${series}@2026-10-14`))).resolves.toBeNull();
      await expect(f.validate(eventLink(`${series.toUpperCase()}@2026-10-14`))).resolves.toBeNull();
    }));

  it("refuses an id whose series does not exist, naming the target", () =>
    runInTenant(tenant, async () => {
      const f = await setup();

      const error = await f.refusal(eventLink(`${randomUUID()}@2026-10-14`));

      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toMatchObject({
        message: expect.stringContaining("names no recurring Event"),
        details: { field: "target" },
      });
    }));

  it("refuses an id whose date the rule does not give, naming the target", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const series = await f.event(STANDUP);

      // 17 October 2026 is a Saturday, and 9 October is before the series starts.
      for (const date of ["2026-10-17", "2026-10-09"]) {
        const error = await f.refusal(eventLink(`${series}@${date}`));
        expect(error).toBeInstanceOf(ValidationError);
        expect(error).toMatchObject({
          message: expect.stringContaining("is not an occurrence of its series"),
          details: { field: "target" },
        });
      }
    }));

  it("refuses the id of a trashed series, a plain Event, an occurrence item and a series of another tenant", async () => {
    const theirs = await runInTenant(foreign, async () => (await setup()).event(STANDUP));
    await runInTenant(tenant, async () => {
      const f = await setup();
      const trashed = await f.event(STANDUP);
      await f.cp.softDeleteItem(f.db("events"), trashed);
      const plain = await f.event({ name: "Review", type: "meeting", date: "2026-10-14", timeFrom: "09:00" });
      const series = await f.event(STANDUP);
      const occurrence = await withTransaction(runtime, (client) =>
        materializeEventOccurrence(client, {
          seriesId: series,
          occurrenceDate: "2026-10-14",
          options: { writer: USER },
        }),
      );

      for (const id of [trashed, plain, occurrence.item.id, theirs]) {
        const error = await f.refusal(eventLink(`${id}@2026-10-14`));
        expect(error).toBeInstanceOf(ValidationError);
        expect(error).toMatchObject({
          message: expect.stringContaining("names no recurring Event"),
          details: { field: "target" },
        });
      }
    });
  });

  it("refuses a target that is neither an item id nor an occurrence id, as before", () =>
    runInTenant(tenant, async () => {
      const f = await setup();
      const series = await f.event(STANDUP);

      for (const target of ["not-an-id", `${series}@2026-02-30`, `${series}@2026-10-14@x`, `x@2026-10-14`]) {
        const error = await f.refusal(eventLink(target));
        expect(error).toBeInstanceOf(ValidationError);
        expect(error).toMatchObject({
          message: `Proposal envelope target '${target}' is not an item id`,
          details: { field: "target" },
        });
      }
    }));

  describe("revising a transcript card", () => {
    it("accepts a link to an occurrence in place of the new meeting it proposed", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        // The card is made before the series exists, as the card of a recording that overlapped nothing.
        const cardId = await f.newMeetingCard();
        const series = await f.event(STANDUP);
        expect(await f.storedProposal(cardId)).toMatchObject({ entityKind: "database" });

        await f.revise(cardId, eventLink(`${series}@2026-10-14`));

        expect(await f.storedProposal(cardId)).toEqual(eventLink(`${series}@2026-10-14`));
      }));

    it("refuses a link to an unknown series and leaves the card as it was", () =>
      runInTenant(tenant, async () => {
        const f = await setup();
        const cardId = await f.newMeetingCard();
        await f.event(STANDUP);
        const before = await f.storedProposal(cardId);

        await expect(f.revise(cardId, eventLink(`${randomUUID()}@2026-10-14`))).rejects.toBeInstanceOf(ValidationError);

        expect(await f.storedProposal(cardId)).toEqual(before);
      }));
  });
});
