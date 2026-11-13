import "../domainWriteHooks.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { Pool } from "pg";
import {
  runAsSystem,
  runInTenant,
  SearchOutputSchema,
  type SearchGroup,
  type SearchMailResult,
  type SearchOutput,
} from "@semprec/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setAgentDatabaseGrant } from "../agentGrants/agentDatabaseGrantsAdminStore.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { withTransaction } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import { LocalFsBlobStorageWriter } from "../mail/blobStorage.js";
import { ingestEmailMessage } from "../mail/ingest.js";
import { writeMailboxAddresses } from "../mail/mailboxAddresses.js";
import { createMailThreadListRouteHandler } from "../mail/mailThreadRoutes.js";
import { reindexPersonEmails } from "../mail/personEmailIndexStore.js";
import { searchItemGroups } from "../search/searchItemsQuery.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

let admin: Pool;
let runtime: Pool;
let tenant: string;
let foreign: string;
let storageRoot: string;

beforeAll(async () => {
  admin = getTestPool();
  runtime = await createRuntimeRolePool(admin, "semprec_data");
  storageRoot = await mkdtemp(join(tmpdir(), "semprec-mail-search-group-"));
  const role = await runAsSystem("verify mail search group test role", () =>
    runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    ),
  );
  expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
}, 120_000);
beforeEach(async () => {
  await resetDatabase(admin);
  tenant = await createTestTenant(admin);
  foreign = await createTestTenant(admin);
  for (const id of [tenant, foreign]) await runInTenant(id, () => seedSystem(runtime));
}, 120_000);
afterAll(async () => {
  await runtime?.end();
  await admin?.end();
  await rm(storageRoot, { recursive: true, force: true });
});

interface MailGroup {
  total: number;
  items: SearchMailResult[];
  nextCursor: string | null;
}

function isMailResult(item: object): item is SearchMailResult {
  return "itemId" in item;
}

/** The `mail` group of an answer, or undefined when the answer has none. Every entry must be a mail entry. */
function mailGroupOf(output: SearchOutput): MailGroup | undefined {
  const group: SearchGroup | undefined = output.groups.find((candidate) => candidate.type === "mail");
  if (group === undefined) return undefined;
  const items = group.items.map((item) => {
    if (!isMailResult(item)) throw new Error("A mail entry carries no item");
    return item;
  });
  return { total: group.total, items, nextCursor: group.nextCursor };
}

/** Searches the mail group only, in `asTenant`, as a person unless the input says otherwise. */
async function searchMail(
  q: string,
  input: { perGroupLimit?: number; cursor?: string; agentProjectItemId?: string; humanActor?: boolean } = {},
  asTenant: string = tenant,
): Promise<MailGroup | undefined> {
  const answer = await runInTenant(asTenant, () =>
    searchItemGroups(runtime, { q, scope: ["mail"], perGroupLimit: 4, humanActor: true, ...input }),
  );
  expect(SearchOutputSchema.safeParse(answer).success).toBe(true);
  return mailGroupOf(answer);
}

const threadList = (url: string) => createMailThreadListRouteHandler(runtime)({ req: { url } });

interface IngestInput {
  id: string;
  subject?: string;
  refs?: string[];
  from?: string;
  fromName?: string;
  noFrom?: boolean;
  mailbox?: string;
  folder?: string;
  date?: Date;
  body?: string;
  html?: string;
  attachment?: boolean;
  flags?: string[];
}

/** The mailboxes and folders of the current tenant, and an `ingest` that writes through the production ingest path. */
async function setup() {
  const cp = createChokePoint(runtime);
  const databases = await cp.listDatabases();
  const db = (key: string) => {
    const database = databases.find((row) => row.ownerModuleId === key);
    if (!database) throw new Error(`Missing ${key}`);
    return database.id;
  };
  const properties = await cp.listProperties(db("emails"));
  const property = (key: string) => {
    const found = properties.find((row) => row.key === key);
    if (!found) throw new Error(`Missing ${key}`);
    return found.id;
  };
  const box = await cp.createItem({ databaseId: db("mailboxes"), properties: { name: "Personal", provider: "gmail" } });
  const folders = await withTransaction(runtime, async (client) => {
    await writeMailboxAddresses(client, {
      mailboxesDatabaseId: db("mailboxes"),
      mailboxItemId: box.id,
      address: "me@example.test",
    });
    const create = async (name: string, specialPurpose: string) =>
      createItemWithClient(
        client,
        { databaseId: db("folders"), properties: { name, behavior: "folder", specialPurpose } },
        { allowedSystemKeys: ["name", "behavior", "specialPurpose"] },
      );
    return {
      inbox: await create("Inbox", "inbox"),
      sent: await create("Sent", "sent"),
      drafts: await create("Drafts", "drafts"),
      spam: await create("Spam", "junk"),
      trash: await create("Trash", "trash"),
    };
  });
  const storage = new LocalFsBlobStorageWriter(storageRoot);
  const ingest = (input: IngestInput) =>
    withTransaction(runtime, (client) =>
      ingestEmailMessage(client, {
        emailsDatabaseId: db("emails"),
        filesDatabaseId: db("files"),
        folderRelationPropertyId: property("folder"),
        attachmentsRelationPropertyId: property("attachments"),
        mailboxItemId: box.id,
        folderItemId: input.folder ?? folders.inbox.id,
        messageId: input.id,
        references: input.refs ?? [],
        subject: input.subject ?? "Re: Website proposal",
        date: input.date,
        envelope: {
          ...(input.noFrom === true
            ? {}
            : { from: { name: input.fromName ?? "Sender", address: input.from ?? "sender@example.test" } }),
          to: [{ name: "Me", address: "me@example.test" }],
        },
        ...(input.html === undefined ? { bodyText: input.body ?? "preview" } : { bodyHtml: input.html }),
        flags: input.flags,
        attachments: input.attachment
          ? [
              {
                filename: "note.txt",
                contentType: "text/plain",
                contentId: null,
                disposition: "attachment",
                openStream: () => Readable.from(["attachment"]),
              },
            ]
          : [],
        storage,
        storageKeyPrefix: "fixtures",
      }),
    );
  return { cp, db, property, box, folders, ingest };
}

const day = (n: number): Date => new Date(`2026-03-${String(n).padStart(2, "0")}T09:30:00Z`);

describe("the mail group of global search: one entry per thread", () => {
  it("lists a thread whose three messages match once, and counts it once", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      await f.ingest({ id: "<one@example.test>", date: day(1), body: "The invoice is attached" });
      await f.ingest({ id: "<two@example.test>", refs: ["<one@example.test>"], date: day(2), body: "Invoice 4711" });
      const last = await f.ingest({
        id: "<three@example.test>",
        refs: ["<one@example.test>"],
        date: day(3),
        body: "Paid the invoice today",
      });
      await f.ingest({ id: "<other@example.test>", subject: "Unrelated", date: day(4), body: "Lunch on Friday" });

      const group = await searchMail("invoice");

      expect(group?.total).toBe(1);
      expect(group?.items).toHaveLength(1);
      expect(group?.items[0]?.itemId).toBe(last.itemId);
      expect(group?.nextCursor).toBeNull();
    });
  });

  it("gives the subject, the sender and the date as parts, the matching fragment as snippet and the thread, the item and the database", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const person = await f.cp.createItem({ databaseId: f.db("people"), properties: { name: "Petr Novák" } });
      await withTransaction(runtime, (client) => reindexPersonEmails(client, person.id, ["petr@example.test"]));
      const last = await f.ingest({
        id: "<offer@example.test>",
        subject: "Re: Nabídka na web",
        from: "petr@example.test",
        fromName: "Petr Novák",
        date: new Date("2026-03-04T09:30:00.123456Z"),
        body: "Dobrý den, posílám nabídku na nový web. Celková cena je 12000 Kč.",
      });

      const group = await searchMail("cena");

      const listed = (await threadList("/api/mail/threads")).body.threads[0];
      expect(group?.items).toHaveLength(1);
      expect(group?.items[0]).toEqual({
        threadId: listed?.threadId,
        itemId: last.itemId,
        databaseId: f.db("emails"),
        databaseKey: "emails",
        title: "Re: Nabídka na web",
        subtitleParts: [
          { kind: "sender", value: "Petr Novák", itemId: person.id },
          { kind: "date", value: listed?.lastMessageAt },
        ],
        snippet: expect.stringContaining("Celková cena"),
      });
      expect(listed?.lastMessageAt).toMatch(/^2026-03-04T09:30:00\.\d{6}Z$/);
      expect(group?.items[0]?.snippet?.length).toBeLessThanOrEqual(160);
    });
  });

  it("names the last message even when an earlier one matches, and excerpts the message that matches", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      await f.ingest({
        id: "<q1@example.test>",
        subject: "Question",
        date: day(1),
        body: "The invoice number is 4711 and it is due on Friday afternoon at the latest",
      });
      const last = await f.ingest({
        id: "<q2@example.test>",
        refs: ["<q1@example.test>"],
        subject: "Question",
        date: day(2),
        body: "Thanks a lot",
      });

      const group = await searchMail("invoice");

      expect(group?.total).toBe(1);
      expect(group?.items[0]?.itemId).toBe(last.itemId);
      expect(group?.items[0]?.snippet).toContain("invoice");
    });
  });

  it("excerpts the older message that holds the words when the newest one is found only through the subject", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      await f.ingest({
        id: "<s1@example.test>",
        subject: "Re: Invoice 4711",
        date: day(1),
        body: "Hello, the invoice is attached to this message as a PDF",
      });
      const last = await f.ingest({
        id: "<s2@example.test>",
        refs: ["<s1@example.test>"],
        subject: "Re: Invoice 4711",
        date: day(2),
        body: "Thanks",
      });

      const group = await searchMail("invoice");

      expect(group?.total).toBe(1);
      expect(group?.items[0]?.itemId).toBe(last.itemId);
      expect(group?.items[0]?.snippet).toContain("invoice is attached");
    });
  });

  it("takes the excerpt from the newest message whose body holds the words, not from an older one", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      await f.ingest({ id: "<n1@example.test>", subject: "Re: Offer", date: day(1), body: "The offer is old news" });
      await f.ingest({
        id: "<n2@example.test>",
        refs: ["<n1@example.test>"],
        subject: "Re: Offer",
        date: day(2),
        body: "The offer was renewed this week",
      });
      await f.ingest({
        id: "<n3@example.test>",
        refs: ["<n1@example.test>"],
        subject: "Re: Offer",
        date: day(3),
        body: "Ok",
      });

      const group = await searchMail("offer");

      expect(group?.items[0]?.snippet).toContain("offer was renewed this week");
    });
  });

  it("falls back to the preview when no message body holds the words, and caps it at 160 characters", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      await f.ingest({ id: "<short@example.test>", subject: "Quarterly report", body: "Short body text here" });
      await f.ingest({
        id: "<long@example.test>",
        subject: "Quarterly figures",
        date: day(9),
        body: "lorem ipsum ".repeat(20),
      });

      const group = await searchMail("quarterly");

      expect(group?.total).toBe(2);
      const long = group?.items.find((item) => item.title === "Quarterly figures");
      const short = group?.items.find((item) => item.title === "Quarterly report");
      expect(short?.snippet).toBe("Short body text here");
      expect(long?.snippet).toBe("lorem ipsum ".repeat(20).trim().slice(0, 160));
    });
  });

  it("builds the fragment of an HTML message from its text, without markup", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      await f.ingest({
        id: "<html@example.test>",
        subject: "Greetings",
        html: "<style>p { color: red }</style><p>Hello <b>wonderful</b> customer, welcome back</p>",
      });

      const group = await searchMail("wonderful");

      expect(group?.items).toHaveLength(1);
      expect(group?.items[0]?.snippet).toBe("Hello wonderful customer, welcome back");
    });
  });

  it("uses the address as the sender when the name is empty, and no sender part without a From", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      await f.ingest({
        id: "<anon@example.test>",
        subject: "Anonymous offer",
        fromName: "",
        from: "anon@example.test",
      });
      await f.ingest({ id: "<nofrom@example.test>", subject: "Orphan offer", noFrom: true, date: day(5) });

      const group = await searchMail("offer");

      const anonymous = group?.items.find((item) => item.title === "Anonymous offer");
      const orphan = group?.items.find((item) => item.title === "Orphan offer");
      expect(anonymous?.subtitleParts.map((part) => [part.kind, part.kind === "sender" ? part.value : null])).toEqual([
        ["sender", "anon@example.test"],
        ["date", null],
      ]);
      expect(orphan?.subtitleParts.map((part) => part.kind)).toEqual(["date"]);
    });
  });
});

describe("the mail group of global search: what is never found", () => {
  it("leaves out a deleted message, and a thread whose only matching message was deleted", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const matching = await f.ingest({ id: "<m1@example.test>", date: day(1), body: "Quotation for the garden" });
      const lastKept = await f.ingest({
        id: "<m2@example.test>",
        refs: ["<m1@example.test>"],
        date: day(2),
        body: "See you soon",
      });
      expect((await searchMail("quotation"))?.items.map((item) => item.itemId)).toEqual([lastKept.itemId]);

      await f.cp.softDeleteItem(f.db("emails"), matching.itemId);

      expect(await searchMail("quotation")).toBeUndefined();
    });
  });

  it("represents a thread by its last live message once the newest one is deleted", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const first = await f.ingest({ id: "<d1@example.test>", date: day(1), body: "Tender documents" });
      const newest = await f.ingest({
        id: "<d2@example.test>",
        refs: ["<d1@example.test>"],
        date: day(2),
        body: "Tender documents again",
      });
      expect((await searchMail("tender"))?.items[0]?.itemId).toBe(newest.itemId);

      await f.cp.softDeleteItem(f.db("emails"), newest.itemId);

      const group = await searchMail("tender");
      expect(group?.total).toBe(1);
      expect(group?.items[0]?.itemId).toBe(first.itemId);
    });
  });

  it("finds only the mail of the asking tenant", async () => {
    const own = await runInTenant(tenant, async () => {
      const f = await setup();
      return f.ingest({ id: "<own@example.test>", subject: "Shared word", body: "mine" });
    });
    const theirs = await runInTenant(foreign, async () => {
      const f = await setup();
      return f.ingest({ id: "<their@example.test>", subject: "Shared word", body: "theirs" });
    });

    const ownAnswer = await searchMail("shared", {}, tenant);
    const foreignAnswer = await searchMail("shared", {}, foreign);

    expect(ownAnswer?.items.map((item) => item.itemId)).toEqual([own.itemId]);
    expect(foreignAnswer?.items.map((item) => item.itemId)).toEqual([theirs.itemId]);
    expect(ownAnswer?.total).toBe(1);
    expect(foreignAnswer?.total).toBe(1);
  });

  it("leaves out a thread that is only in Junk or Trash or only in Drafts, and finds one with a copy elsewhere", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      await f.ingest({ id: "<spam@example.test>", subject: "Spam parcel", folder: f.folders.spam.id });
      await f.ingest({ id: "<trash@example.test>", subject: "Trash parcel", folder: f.folders.trash.id });
      await f.ingest({ id: "<draft@example.test>", subject: "Draft parcel", folder: f.folders.drafts.id });
      const sent = await f.ingest({ id: "<sent@example.test>", subject: "Sent parcel", folder: f.folders.sent.id });
      const mixed = await f.ingest({
        id: "<mixed@example.test>",
        subject: "Mixed parcel",
        folder: f.folders.trash.id,
        date: day(10),
      });
      await f.ingest({
        id: "<mixed-reply@example.test>",
        refs: ["<mixed@example.test>"],
        subject: "Mixed parcel",
        date: day(20),
      });

      const group = await searchMail("parcel");

      expect(group?.items.map((item) => item.title).sort()).toEqual(["Mixed parcel", "Sent parcel"]);
      expect(group?.total).toBe(2);
      expect(group?.items.map((item) => item.itemId)).toContain(sent.itemId);
      // The message in Trash is not the thread's last one: the reply in the Inbox is.
      expect(group?.items.map((item) => item.itemId)).not.toContain(mixed.itemId);
    });
  });
});

describe("the mail group of global search: operators", () => {
  it("applies the operators of the thread search, with accents and case folded", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      await f.ingest({
        id: "<op@example.test>",
        subject: "Operator thread",
        from: "petr@example.test",
        fromName: "Petr Novák",
        date: new Date("2026-01-02T12:00:00Z"),
        flags: ["\\Seen", "\\Flagged"],
        attachment: true,
        body: "Cena je dohodnuta",
      });
      const found = async (q: string) => (await searchMail(q))?.total ?? 0;

      for (const q of [
        "from:novak",
        "from:NOVAK",
        "has:attachment",
        "is:read",
        "is:flagged",
        "before:2026-01-03",
        "after:2026-01-01",
        "from:novak cena",
        "has:attachment is:read is:flagged cena",
      ]) {
        expect(await found(q), q).toBe(1);
      }
      for (const q of ["is:unread", "is:unflagged", "before:2026-01-01", "after:2026-01-03", "from:novak jinak"]) {
        expect(await found(q), q).toBe(0);
      }
    });
  });

  it("matches nothing for contradictory operators, a text that is no condition and a date that is not a date", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      await f.ingest({ id: "<edge@example.test>", subject: "Edge thread", body: "words" });

      expect(await searchMail("is:unread is:read")).toBeUndefined();
      expect(await searchMail("is:flagged is:unflagged")).toBeUndefined();
      // `has:` with another value is removed from the text, which would leave a query that matches every message.
      expect(await searchMail("has:foo")).toBeUndefined();
      expect(await searchMail("before:not-a-date")).toBeUndefined();
      expect(await searchMail("after:2026-13-45 edge")).toBeUndefined();
      expect((await searchMail("edge"))?.total).toBe(1);
    });
  });

  it("finds the same threads as the thread list for the same text", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      await f.ingest({ id: "<p1@example.test>", subject: "Re: Nabídka na web", fromName: "Petr Novák", date: day(1) });
      await f.ingest({ id: "<p2@example.test>", subject: "Siko Koupelny", date: day(2) });
      await f.ingest({ id: "<p3@example.test>", subject: "Dovolená", date: day(3) });

      for (const q of ["nab", "koupelny", "from:novak", "dovolená", "nonexistent"]) {
        const listed = (await threadList(`/api/mail/threads?q=${encodeURIComponent(q)}`)).body.threads.map(
          (thread) => thread.threadId,
        );
        const group = await searchMail(q);
        expect(group?.items.map((item) => item.threadId) ?? [], q).toEqual(listed);
      }
    });
  });
});

describe("the mail group of global search: paging", () => {
  it("lists newest thread first, and continues with nextCursor of the group", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      for (const n of [1, 2, 3]) await f.ingest({ id: `<pg${n}@example.test>`, subject: `Paged ${n}`, date: day(n) });

      const first = await searchMail("paged", { perGroupLimit: 2 });
      expect(first?.total).toBe(3);
      expect(first?.items.map((item) => item.title)).toEqual(["Paged 3", "Paged 2"]);
      expect(first?.nextCursor).toEqual(expect.any(String));

      const second = await searchMail("paged", { perGroupLimit: 2, cursor: first?.nextCursor ?? undefined });
      expect(second?.total).toBe(3);
      expect(second?.items.map((item) => item.title)).toEqual(["Paged 1"]);
      expect(second?.nextCursor).toBeNull();
    });
  });

  it("refuses a malformed cursor of the group before searching, for a person and for an agent", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      await f.ingest({ id: "<cur@example.test>", subject: "Cursor thread" });
      const forged = Buffer.from(JSON.stringify({ at: "yesterday", id: "nope" })).toString("base64url");

      for (const cursor of ["not a cursor!", forged]) {
        for (const actor of [{ humanActor: true }, { agentProjectItemId: "11111111-1111-4111-8111-111111111111" }]) {
          await expect(searchMail("cursor", { cursor, ...actor }), cursor).rejects.toBeInstanceOf(ValidationError);
        }
      }
      await expect(searchMail("cursor", { cursor: "not a cursor!" })).rejects.toMatchObject({
        details: { field: "cursor" },
      });
    });
  });
});

describe("the mail group of global search: who may read the Emails database", () => {
  it("is given to a person, an agent and an MCP client alike while the Emails database is open", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      await f.ingest({ id: "<open@example.test>", subject: "Open thread" });
      const agent = await f.cp.createItem({ databaseId: f.db("projects"), properties: { name: "Agent project" } });

      expect((await searchMail("open", { humanActor: true }))?.total).toBe(1);
      expect((await searchMail("open", { humanActor: false }))?.total).toBe(1);
      expect((await searchMail("open", { humanActor: false, agentProjectItemId: agent.id }))?.total).toBe(1);
    });
  });

  it("leaves it out for an agent whose project has no grant on a sensitive Emails database, and returns it with a read grant", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      await f.ingest({ id: "<closed@example.test>", subject: "Closed thread" });
      const agent = await f.cp.createItem({ databaseId: f.db("projects"), properties: { name: "Agent project" } });
      // The seeded Emails database is open to agents; the flag that makes it need a grant is set directly, since no API sets it on it.
      await admin.query("UPDATE databases SET sensitive = true WHERE id = $1", [f.db("emails")]);

      expect(await searchMail("closed", { agentProjectItemId: agent.id })).toBeUndefined();
      expect((await searchMail("closed", { humanActor: true }))?.total).toBe(1);

      await withTransaction(runtime, (client) =>
        setAgentDatabaseGrant(client, { projectItemId: agent.id, databaseId: f.db("emails"), access: "read" }),
      );
      expect((await searchMail("closed", { agentProjectItemId: agent.id }))?.total).toBe(1);

      await withTransaction(runtime, (client) =>
        setAgentDatabaseGrant(client, { projectItemId: agent.id, databaseId: f.db("emails"), access: "none" }),
      );
      expect(await searchMail("closed", { agentProjectItemId: agent.id })).toBeUndefined();
    });
  });

  it("names the sender's People item only when an agent's project may read the People database", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const person = await f.cp.createItem({ databaseId: f.db("people"), properties: { name: "Petr Novák" } });
      await withTransaction(runtime, (client) => reindexPersonEmails(client, person.id, ["petr@example.test"]));
      await f.ingest({
        id: "<known@example.test>",
        subject: "Known sender",
        from: "petr@example.test",
        fromName: "Petr Novák",
      });
      const agent = await f.cp.createItem({ databaseId: f.db("projects"), properties: { name: "Agent project" } });
      const senderOf = async (input: { agentProjectItemId?: string }) =>
        (await searchMail("known", input))?.items[0]?.subtitleParts.find((part) => part.kind === "sender");
      const linked = { kind: "sender", value: "Petr Novák", itemId: person.id };
      // The seeded People database is open to agents; the flag that closes it by default is set directly, since no API sets it on it.
      await admin.query("UPDATE databases SET sensitive = true WHERE id = $1", [f.db("people")]);

      expect(await senderOf({ agentProjectItemId: agent.id })).toEqual({ kind: "sender", value: "Petr Novák" });
      expect(await senderOf({})).toEqual(linked);

      await withTransaction(runtime, (client) =>
        setAgentDatabaseGrant(client, { projectItemId: agent.id, databaseId: f.db("people"), access: "none" }),
      );
      expect(await senderOf({ agentProjectItemId: agent.id })).toEqual({ kind: "sender", value: "Petr Novák" });

      await withTransaction(runtime, (client) =>
        setAgentDatabaseGrant(client, { projectItemId: agent.id, databaseId: f.db("people"), access: "read" }),
      );
      expect(await senderOf({ agentProjectItemId: agent.id })).toEqual(linked);
    });
  });

  it("finds nothing in an archived Emails database", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      await f.ingest({ id: "<archived@example.test>", subject: "Archived thread" });
      expect((await searchMail("archived"))?.total).toBe(1);

      await admin.query("UPDATE databases SET archived_at = now() WHERE id = $1", [f.db("emails")]);

      expect(await searchMail("archived")).toBeUndefined();
    });
  });
});
