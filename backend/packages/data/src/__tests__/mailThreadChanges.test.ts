import "../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { runInTenant } from "@alldots/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import { createRelationWithClient } from "../chokePoint/relationOps.js";
import { itemDeleteWithClient } from "../chokePoint/itemTrash.js";
import { SYSTEM_WRITER } from "../chokePoint/writerKind.js";
import { withTransaction } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import { LocalFsBlobStorageWriter } from "../mail/blobStorage.js";
import { applyObservedMailMessageFlags } from "../mail/mailFlagObservation.js";
import { reassignThread } from "../mail/mailMessageMetaStore.js";
import { resolveMailModuleIds } from "../mail/mailModuleIds.js";
import { MAIL_THREAD_CHANGES_LIMIT, touchMailThreads } from "../mail/mailThreadChanges.js";
import {
  createMailThreadArchiveRouteHandler,
  createMailThreadChangesRouteHandler,
  createMailThreadFlagRouteHandler,
  createMailThreadListRouteHandler,
  createMailThreadReadRouteHandler,
  createMailThreadRestoreRouteHandler,
  createMailThreadTrashRouteHandler,
} from "../mail/mailThreadRoutes.js";
import { handleMailboxRemovalTask } from "../mail/mailboxRemovalJob.js";
import { setInvalidationHook, type InvalidationEvent } from "../realtimeHook.js";
import { createActionQueueAffinity } from "../scheduler/actions.js";
import { seedSystem } from "../seed/seedSystem.js";
import {
  MOVE_FIXTURE_OWN_ADDRESS,
  createMoveFixtureIngest,
  createMoveFixtureMailbox,
  moveFixtureThreadOf,
  type MoveFixtureMailbox,
} from "../testSupport/mailThreadMoveFixtures.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

const USER_ID = randomUUID();
const USER_WRITER = { writerKind: "user" } as const;

let admin: Pool;
let runtime: Pool;
let tenant: string;
let foreign: string;
let storageRoot: string;
let events: InvalidationEvent[];

interface Fixture {
  gmail: MoveFixtureMailbox;
  ingest: ReturnType<typeof createMoveFixtureIngest>;
  /** The conversation of day 1, its message in the Inbox. */
  first: { threadId: string; emailId: string };
  /** The conversation of day 2, its message in the Inbox. */
  second: { threadId: string; emailId: string };
}

describe("GET /api/mail/threads/changes", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "alldots_data");
    storageRoot = await mkdtemp(join(tmpdir(), "alldots-mail-thread-changes-"));
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    foreign = await createTestTenant(admin);
    for (const id of [tenant, foreign]) await runInTenant(id, () => seedSystem(runtime));
    events = [];
  });

  afterEach(() => {
    setInvalidationHook(() => {});
  });

  afterAll(async () => {
    await runtime.end();
    await admin.end();
    await rm(storageRoot, { recursive: true, force: true });
  });

  /** Run inside the tenant scope. */
  async function offerMail(): Promise<Fixture> {
    const gmail = await createMoveFixtureMailbox(runtime, {
      name: "Personal",
      kind: "gmail",
      ownAddress: MOVE_FIXTURE_OWN_ADDRESS,
    });
    const ingest = createMoveFixtureIngest(runtime, new LocalFsBlobStorageWriter(storageRoot));
    const firstEmail = await ingest({ id: "<first@example.test>", day: 1, mailbox: gmail, folders: ["inbox"] });
    const secondEmail = await ingest({
      id: "<second@example.test>",
      day: 2,
      mailbox: gmail,
      folders: ["inbox"],
      subject: "Invoice",
    });
    return {
      gmail,
      ingest,
      first: { threadId: await moveFixtureThreadOf(runtime, firstEmail), emailId: firstEmail },
      second: { threadId: await moveFixtureThreadOf(runtime, secondEmail), emailId: secondEmail },
    };
  }

  function list(query = "box=inbox") {
    return createMailThreadListRouteHandler(runtime)({ req: { url: `/api/mail/threads?${query}` } });
  }

  async function cursorNow(query = "box=inbox"): Promise<string> {
    return (await list(query)).body.changesCursor;
  }

  async function changes(since: string, query = "box=inbox") {
    return (
      await createMailThreadChangesRouteHandler(runtime)({
        req: { url: `/api/mail/threads/changes?since=${since}&${query}` },
      })
    ).body;
  }

  /** The delta as ids: the changed rows of the view and the ids removed from it. */
  async function delta(since: string, query = "box=inbox") {
    const body = await changes(since, query);
    return {
      reset: body.reset,
      threads: body.threads.map((thread) => thread.threadId).sort(),
      removed: [...body.removed].sort(),
      cursor: body.cursor,
    };
  }

  const identity = { user: { id: USER_ID } };

  function post(
    action: "read" | "flag" | "archive" | "trash" | "restore",
    threadId: string,
    body: Record<string, unknown> = {},
  ) {
    switch (action) {
      case "read":
        return createMailThreadReadRouteHandler(runtime)({ params: { threadId }, body, identity });
      case "flag":
        return createMailThreadFlagRouteHandler(runtime)({ params: { threadId }, body, identity });
      case "archive":
        return createMailThreadArchiveRouteHandler(runtime)({ params: { threadId } });
      case "trash":
        return createMailThreadTrashRouteHandler(runtime)({ params: { threadId } });
      case "restore":
        return createMailThreadRestoreRouteHandler(runtime)({ params: { threadId } });
    }
  }

  async function databaseId(moduleId: string): Promise<string> {
    const databases = await createChokePoint(runtime).listDatabases();
    const database = databases.find((row) => row.ownerModuleId === moduleId);
    if (!database) throw new Error(`Missing ${moduleId}`);
    return database.id;
  }

  async function threadItemOf(threadId: string): Promise<string> {
    const { rows } = await runtime.query<{ item_id: string | null }>(
      "SELECT item_id FROM mail_threads WHERE tenant_id = app_tenant_default() AND id = $1",
      [threadId],
    );
    const itemId = rows[0]?.item_id;
    if (!itemId) throw new Error("The thread has no Threads item");
    return itemId;
  }

  async function linkThread(threadId: string, key: "project" | "company", targetItemId: string): Promise<void> {
    const threadItemId = await threadItemOf(threadId);
    await withTransaction(runtime, async (client) => {
      const property = await getPropertyByKey(client, await databaseId("threads"), key);
      if (!property) throw new Error(`Threads has no ${key}`);
      await createRelationWithClient(client, {
        relationPropertyId: property.id,
        callerItemId: threadItemId,
        targetItemId,
      });
    });
  }

  async function createNamed(moduleId: "projects" | "companies", name: string): Promise<string> {
    const item = await createChokePoint(runtime).createItem({
      databaseId: await databaseId(moduleId),
      properties: { name },
    });
    return item.id;
  }

  async function rename(moduleId: string, itemId: string, name: string): Promise<void> {
    await createChokePoint(runtime).updateItem(
      { databaseId: await databaseId(moduleId), itemId, propertiesPatch: { name } },
      USER_ID,
      USER_ID,
      USER_WRITER,
    );
  }

  function recordThreadAnnouncements(): void {
    events = [];
    setInvalidationHook((event) => {
      if (event.scope === "mailThread") events.push(event);
    });
  }

  it("lists nothing from the cursor of the list's own snapshot", async () => {
    await runInTenant(tenant, async () => {
      await offerMail();
      const since = await cursorNow();
      expect(await delta(since)).toEqual({ reset: false, threads: [], removed: [], cursor: since });
    });
  });

  interface ChangeCase {
    name: string;
    /** The list view, as query parameters. */
    view?: string;
    /** Runs before the cursor is taken. */
    prepare?: (fixture: Fixture) => Promise<unknown>;
    change: (fixture: Fixture) => Promise<unknown>;
    expected: (fixture: Fixture) => { threads: string[]; removed: string[] };
  }

  const cases: ChangeCase[] = [
    {
      name: "a new conversation from sync",
      change: (f) => f.ingest({ id: "<third@example.test>", day: 3, mailbox: f.gmail, folders: ["inbox"] }),
      expected: () => ({ threads: [], removed: [] }),
    },
    {
      name: "a reply from sync",
      change: (f) =>
        f.ingest({
          id: "<reply@example.test>",
          day: 3,
          refs: ["<first@example.test>"],
          mailbox: f.gmail,
          folders: ["inbox"],
        }),
      expected: (f) => ({ threads: [f.first.threadId], removed: [] }),
    },
    {
      name: "read through the thread route, in the unread view",
      view: "box=inbox&unread=true",
      change: (f) => post("read", f.first.threadId, { read: true }),
      expected: (f) => ({ threads: [], removed: [f.first.threadId] }),
    },
    {
      name: "unread through the thread route",
      prepare: (f) => post("read", f.first.threadId, { read: true }),
      change: (f) => post("read", f.first.threadId, { read: false }),
      expected: (f) => ({ threads: [f.first.threadId], removed: [] }),
    },
    {
      name: "flagged through the thread route, in the flagged view",
      view: "box=flagged",
      change: (f) => post("flag", f.second.threadId, { flagged: true }),
      expected: (f) => ({ threads: [f.second.threadId], removed: [] }),
    },
    {
      name: "a flag the provider reported, in the flagged view",
      view: "box=flagged",
      change: async (f) => {
        const inbox = f.gmail.folders.inbox;
        if (inbox === undefined) throw new Error("The mailbox has no Inbox");
        await withTransaction(runtime, async (client) => {
          const ids = await resolveMailModuleIds(client);
          await applyObservedMailMessageFlags(client, {
            emailsDatabaseId: ids.emailsDatabaseId,
            messageItemId: f.second.emailId,
            folderItemId: inbox,
            flags: ["\\Flagged"],
          });
        });
      },
      expected: (f) => ({ threads: [f.second.threadId], removed: [] }),
    },
    {
      name: "archive",
      change: (f) => post("archive", f.first.threadId),
      expected: (f) => ({ threads: [], removed: [f.first.threadId] }),
    },
    {
      name: "trash",
      change: (f) => post("trash", f.second.threadId),
      expected: (f) => ({ threads: [], removed: [f.second.threadId] }),
    },
    {
      name: "restore from the archive",
      prepare: (f) => post("archive", f.first.threadId),
      change: (f) => post("restore", f.first.threadId),
      expected: (f) => ({ threads: [f.first.threadId], removed: [] }),
    },
    {
      name: "a project edge",
      change: async (f) => linkThread(f.first.threadId, "project", await createNamed("projects", "Redesign")),
      expected: (f) => ({ threads: [f.first.threadId], removed: [] }),
    },
    {
      name: "a company edge",
      change: async (f) => linkThread(f.second.threadId, "company", await createNamed("companies", "Acme")),
      expected: (f) => ({ threads: [f.second.threadId], removed: [] }),
    },
    {
      name: "a rename of the thread's project",
      prepare: async (f) => {
        const projectId = await createNamed("projects", "Website");
        await linkThread(f.first.threadId, "project", projectId);
        return projectId;
      },
      change: async (f) => {
        const threadItemId = await threadItemOf(f.first.threadId);
        const { rows } = await runtime.query<{ project_id: string }>(
          `SELECT CASE WHEN r.item_a = $1 THEN r.item_b ELSE r.item_a END AS project_id FROM item_relations r
           WHERE r.tenant_id = app_tenant_default() AND (r.item_a = $1 OR r.item_b = $1)`,
          [threadItemId],
        );
        const projectId = rows[0]?.project_id;
        if (!projectId) throw new Error("The thread has no project");
        await rename("projects", projectId, "Website 2027");
      },
      expected: (f) => ({ threads: [f.first.threadId], removed: [] }),
    },
    {
      name: "a merge",
      change: (f) => withTransaction(runtime, (client) => reassignThread(client, f.second.threadId, f.first.threadId)),
      expected: (f) => ({ threads: [f.first.threadId], removed: [f.second.threadId] }),
    },
    {
      name: "a trashed message",
      change: (f) =>
        withTransaction(runtime, async (client) => {
          const ids = await resolveMailModuleIds(client);
          await itemDeleteWithClient(client, ids.emailsDatabaseId, f.second.emailId, {
            queueAffinity: createActionQueueAffinity(),
            writer: SYSTEM_WRITER,
          });
        }),
      expected: (f) => ({ threads: [], removed: [f.second.threadId] }),
    },
  ];

  it.each(cases)("$name advances the cursor and names the thread", async ({ view, prepare, change, expected }) => {
    await runInTenant(tenant, async () => {
      const f = await offerMail();
      await prepare?.(f);
      const query = view ?? "box=inbox";
      const since = await cursorNow(query);
      const threadsBefore = new Set((await list(query)).body.threads.map((thread) => thread.threadId));
      await change(f);
      const answer = await delta(since, query);
      const want = expected(f);
      const newThreads = (await list(query)).body.threads
        .map((thread) => thread.threadId)
        .filter((threadId) => !threadsBefore.has(threadId) && !want.threads.includes(threadId));
      expect(answer.reset).toBe(false);
      expect(answer.cursor).not.toBe(since);
      expect({ threads: answer.threads, removed: answer.removed }).toEqual({
        threads: [...want.threads, ...newThreads].sort(),
        removed: want.removed,
      });
      expect(await delta(answer.cursor, query)).toEqual({
        reset: false,
        threads: [],
        removed: [],
        cursor: answer.cursor,
      });
    });
  });

  it("answers a changed row as the list shapes it", async () => {
    await runInTenant(tenant, async () => {
      const f = await offerMail();
      const since = await cursorNow();
      await post("read", f.first.threadId, { read: true });
      const [row] = (await changes(since)).threads;
      const listed = (await list()).body.threads.find((thread) => thread.threadId === f.first.threadId);
      expect(row).toEqual(listed);
      expect(row?.unread).toBe(false);
    });
  });

  it("publishes one mailThread invalidation per thread a sync pass changed", async () => {
    await runInTenant(tenant, async () => {
      const f = await offerMail();
      recordThreadAnnouncements();
      await f.ingest({
        id: "<reply@example.test>",
        day: 3,
        refs: ["<first@example.test>"],
        mailbox: f.gmail,
        folders: ["inbox"],
      });
      expect(events).toEqual([{ scope: "mailThread", threadId: f.first.threadId }]);
      const inbox = f.gmail.folders.inbox;
      if (inbox === undefined) throw new Error("The mailbox has no Inbox");
      events = [];
      await withTransaction(runtime, async (client) => {
        const ids = await resolveMailModuleIds(client);
        await applyObservedMailMessageFlags(client, {
          emailsDatabaseId: ids.emailsDatabaseId,
          messageItemId: f.second.emailId,
          folderItemId: inbox,
          flags: ["\\Seen"],
        });
      });
      expect(events).toEqual([{ scope: "mailThread", threadId: f.second.threadId }]);
    });
  });

  it("stamps nothing and publishes nothing when the transaction rolls back", async () => {
    await runInTenant(tenant, async () => {
      const f = await offerMail();
      const since = await cursorNow();
      recordThreadAnnouncements();
      await expect(
        withTransaction(runtime, async (client) => {
          touchMailThreads(client, [f.first.threadId]);
          throw new Error("rolled back");
        }),
      ).rejects.toThrow("rolled back");
      expect(await delta(since)).toEqual({ reset: false, threads: [], removed: [], cursor: since });
      expect(events).toEqual([]);
    });
  });

  it("numbers changes in commit order, so a change that commits after a later one is not skipped", async () => {
    await runInTenant(tenant, async () => {
      const f = await offerMail();
      const since = await cursorNow();
      let touched!: () => void;
      const firstTouched = new Promise<void>((resolve) => {
        touched = resolve;
      });
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      // Records its change first and commits last.
      const early = withTransaction(runtime, async (client) => {
        touchMailThreads(client, [f.first.threadId]);
        touched();
        await released;
      });
      await firstTouched;
      await withTransaction(runtime, async (client) => {
        touchMailThreads(client, [f.second.threadId]);
      });
      const between = await delta(since);
      expect({ threads: between.threads, removed: between.removed }).toEqual({
        threads: [f.second.threadId],
        removed: [],
      });
      release();
      await early;
      const after = await delta(between.cursor);
      expect({ reset: after.reset, threads: after.threads, removed: after.removed }).toEqual({
        reset: false,
        threads: [f.first.threadId],
        removed: [],
      });
    });
  });

  describe("reset", () => {
    it("answers a reset after a change of every row, and none from a cursor taken after it", async () => {
      await runInTenant(tenant, async () => {
        const f = await offerMail();
        const since = await cursorNow();
        await rename("mailboxes", f.gmail.id, "Private");
        const answer = await delta(since);
        expect({ reset: answer.reset, threads: answer.threads, removed: answer.removed }).toEqual({
          reset: true,
          threads: [],
          removed: [],
        });
        expect(await delta(answer.cursor)).toEqual({ reset: false, threads: [], removed: [], cursor: answer.cursor });
      });
    });

    it("answers a reset once Mail is switched off and its folders leave", async () => {
      await runInTenant(tenant, async () => {
        const f = await offerMail();
        const since = await cursorNow();
        await createChokePoint(runtime).updateItem(
          { databaseId: await databaseId("mailboxes"), itemId: f.gmail.id, propertiesPatch: { mailEnabled: false } },
          USER_ID,
          USER_ID,
          USER_WRITER,
        );
        await handleMailboxRemovalTask(runtime, { mailboxItemId: f.gmail.id, purpose: "mailOff" });
        const answer = await delta(since);
        expect({ reset: answer.reset, threads: answer.threads, removed: answer.removed }).toEqual({
          reset: true,
          threads: [],
          removed: [],
        });
        expect((await list()).body.threads).toEqual([]);
      });
    });

    it("answers a reset when more threads changed than one delta carries", async () => {
      await runInTenant(tenant, async () => {
        await offerMail();
        const atLimit = await cursorNow();
        const ids = Array.from({ length: MAIL_THREAD_CHANGES_LIMIT }, () => randomUUID());
        await withTransaction(runtime, async (client) => touchMailThreads(client, ids));
        const full = await delta(atLimit);
        expect({ reset: full.reset, threads: full.threads, removed: full.removed }).toEqual({
          reset: false,
          threads: [],
          removed: [...ids].sort(),
        });
        await withTransaction(runtime, async (client) => touchMailThreads(client, [randomUUID()]));
        expect((await delta(atLimit)).reset).toBe(true);
      });
    });

    it.each([
      ["another counter's epoch", { e: randomUUID(), s: 0 }],
      ["a step the tenant never reached", { e: null, s: 1_000_000 }],
    ])("answers a reset for %s", async (_name, raw) => {
      await runInTenant(tenant, async () => {
        await offerMail();
        const since = Buffer.from(JSON.stringify(raw)).toString("base64url");
        const answer = await delta(since);
        expect({ reset: answer.reset, threads: answer.threads, removed: answer.removed }).toEqual({
          reset: true,
          threads: [],
          removed: [],
        });
        expect(answer.cursor).toBe(await cursorNow());
      });
    });

    it.each([
      ["no since", "/api/mail/threads/changes?box=inbox", "since"],
      ["a since that is not base64url", "/api/mail/threads/changes?since=%2B%2B", "since"],
      [
        "a since of another shape",
        `/api/mail/threads/changes?since=${Buffer.from('{"at":1}').toString("base64url")}`,
        "since",
      ],
      ["a search", "/api/mail/threads/changes?since=eyJlIjpudWxsLCJzIjowfQ&q=offer", "q"],
      ["an unknown box", "/api/mail/threads/changes?since=eyJlIjpudWxsLCJzIjowfQ&box=spam", "box"],
    ])("refuses %s with a 400", async (_name, url, field) => {
      await runInTenant(tenant, async () => {
        const answer = createMailThreadChangesRouteHandler(runtime)({ req: { url } });
        await expect(answer).rejects.toBeInstanceOf(ValidationError);
        await expect(answer).rejects.toMatchObject({ details: { field } });
      });
    });
  });

  it("counts each tenant's changes apart", async () => {
    const own = await runInTenant(tenant, async () => {
      const f = await offerMail();
      return { f, since: await cursorNow() };
    });
    const foreignSince = await runInTenant(foreign, async () => {
      const f = await offerMail();
      const since = await cursorNow();
      await post("read", f.first.threadId, { read: true });
      return since;
    });
    await runInTenant(tenant, async () => {
      expect(await delta(own.since)).toEqual({ reset: false, threads: [], removed: [], cursor: own.since });
      await post("read", own.f.second.threadId, { read: true });
      const answer = await delta(own.since);
      expect({ threads: answer.threads, removed: answer.removed }).toEqual({
        threads: [own.f.second.threadId],
        removed: [],
      });
      // The foreign cursor names the foreign counter: a reset that lists nothing.
      const crossed = await delta(foreignSince);
      expect({ reset: crossed.reset, threads: crossed.threads, removed: crossed.removed }).toEqual({
        reset: true,
        threads: [],
        removed: [],
      });
    });
    const foreignRows = await runInTenant(foreign, () =>
      runtime.query<{ thread_id: string }>("SELECT thread_id FROM mail_thread_changes"),
    );
    expect(foreignRows.rows.map((row) => row.thread_id)).not.toContain(own.f.second.threadId);
  });
});
