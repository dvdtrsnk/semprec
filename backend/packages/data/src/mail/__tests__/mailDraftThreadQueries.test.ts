import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../../db/pool.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import {
  findOpenAgentDraftOfThread,
  hasDraftOfSourceMessage,
  insertMailDraft,
  markMailDraftSent,
  updateMailDraft,
} from "../mailDraftsStore.js";
import { createMailThread, reassignThread } from "../mailMessageMetaStore.js";

let admin: Pool;
let runtime: Pool;
let tenant: string;
let foreign: string;
let emailsDatabaseId: string;

function inTenant<T>(fn: () => Promise<T>, tenantId = tenant): Promise<T> {
  return runInTenant(tenantId, fn);
}

async function newThread(): Promise<string> {
  return inTenant(() => withTransaction(runtime, async (client) => (await createMailThread(client)).id));
}

/** A live Emails item with a `mail_drafts` row, written the way the draft store writes it. */
async function newDraft(
  threadId: string,
  options: { createdBy?: "user" | "agent"; sourceEmailItemId?: string | null } = {},
): Promise<string> {
  return inTenant(() =>
    withTransaction(runtime, async (client) => {
      const item = await createItemWithClient(client, { databaseId: emailsDatabaseId, properties: {} });
      await insertMailDraft(client, {
        emailItemId: item.id,
        mailboxItemId: randomUUID(),
        threadId,
        mode: "reply",
        sourceEmailItemId: options.sourceEmailItemId ?? null,
        fromAddress: "me@example.test",
        createdBy: options.createdBy ?? "agent",
      });
      return item.id;
    }),
  );
}

const openDraftOf = (threadId: string, tenantId = tenant) =>
  inTenant(() => withTransaction(runtime, (client) => findOpenAgentDraftOfThread(client, threadId)), tenantId);
const hasDraftFor = (threadId: string, sourceId: string, tenantId = tenant) =>
  inTenant(() => withTransaction(runtime, (client) => hasDraftOfSourceMessage(client, threadId, sourceId)), tenantId);

describe("the thread queries of the mail drafts store (issue gh-1941)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end();
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    foreign = await createTestTenant(admin);
    for (const id of [tenant, foreign]) await runInTenant(id, () => seedSystem(runtime, createViewTypeRegistry()));
    emailsDatabaseId = await inTenant(async () => {
      const emails = (await createChokePoint(runtime).listDatabases()).find((row) => row.ownerModuleId === "emails");
      if (!emails) throw new Error("Missing the Emails database");
      return emails.id;
    });
  });

  describe("findOpenAgentDraftOfThread", () => {
    it("answers the unsent agent draft of the thread with the actor that wrote it last, and none for a thread without one", async () => {
      const thread = await newThread();
      expect(await openDraftOf(thread)).toBeNull();
      const draft = await newDraft(thread);

      expect(await openDraftOf(thread)).toEqual({ emailItemId: draft, lastEditedBy: "agent" });

      await inTenant(() =>
        withTransaction(runtime, (client) => updateMailDraft(client, draft, { lastEditedBy: "user" })),
      );
      expect(await openDraftOf(thread)).toEqual({ emailItemId: draft, lastEditedBy: "user" });
    });

    it("does not count a draft of a person, a sent draft, a discarded one or the draft of another thread", async () => {
      const personal = await newThread();
      await newDraft(personal, { createdBy: "user" });
      const sent = await newThread();
      const sentDraft = await newDraft(sent);
      await inTenant(() => withTransaction(runtime, (client) => markMailDraftSent(client, sentDraft)));
      const discarded = await newThread();
      const discardedDraft = await newDraft(discarded);
      await inTenant(async () => {
        await createChokePoint(runtime).softDeleteItem(emailsDatabaseId, discardedDraft);
      });
      const unrelated = await newThread();
      await newDraft(await newThread());

      for (const thread of [personal, sent, discarded, unrelated]) expect(await openDraftOf(thread)).toBeNull();
    });

    it("finds the draft of a thread that was merged into the thread asked about", async () => {
      const loser = await newThread();
      const winner = await newThread();
      const draft = await newDraft(loser);
      await inTenant(() => withTransaction(runtime, (client) => reassignThread(client, loser, winner)));

      expect(await openDraftOf(winner)).toEqual({ emailItemId: draft, lastEditedBy: "agent" });
    });

    it("does not see the draft of another tenant", async () => {
      const thread = await newThread();
      await newDraft(thread);

      expect(await openDraftOf(thread, foreign)).toBeNull();
    });
  });

  describe("hasDraftOfSourceMessage", () => {
    it("is true for a draft of the thread made in answer to the message, sent or not, by anybody", async () => {
      const source = randomUUID();
      const thread = await newThread();
      const draft = await newDraft(thread, { sourceEmailItemId: source });
      expect(await hasDraftFor(thread, source)).toBe(true);

      await inTenant(() => withTransaction(runtime, (client) => markMailDraftSent(client, draft)));
      expect(await hasDraftFor(thread, source)).toBe(true);

      const personal = await newThread();
      const personalSource = randomUUID();
      await newDraft(personal, { createdBy: "user", sourceEmailItemId: personalSource });
      expect(await hasDraftFor(personal, personalSource)).toBe(true);
    });

    it("is false for another message, another thread, a discarded draft and a thread without a draft", async () => {
      const source = randomUUID();
      const thread = await newThread();
      await newDraft(thread, { sourceEmailItemId: source });
      const discardedThread = await newThread();
      const discardedSource = randomUUID();
      const discarded = await newDraft(discardedThread, { sourceEmailItemId: discardedSource });
      await inTenant(async () => {
        await createChokePoint(runtime).softDeleteItem(emailsDatabaseId, discarded);
      });

      expect(await hasDraftFor(thread, randomUUID())).toBe(false);
      expect(await hasDraftFor(await newThread(), source)).toBe(false);
      expect(await hasDraftFor(discardedThread, discardedSource)).toBe(false);
      expect(await hasDraftFor(await newThread(), randomUUID())).toBe(false);
    });

    it("finds the draft of a thread merged into the thread asked about, and none in another tenant", async () => {
      const source = randomUUID();
      const loser = await newThread();
      const winner = await newThread();
      await newDraft(loser, { sourceEmailItemId: source });
      await inTenant(() => withTransaction(runtime, (client) => reassignThread(client, loser, winner)));

      expect(await hasDraftFor(winner, source)).toBe(true);
      expect(await hasDraftFor(winner, source, foreign)).toBe(false);
    });
  });
});
