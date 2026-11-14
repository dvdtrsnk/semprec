import "../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { DateTime } from "luxon";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { itemDeleteWithClient } from "../chokePoint/itemTrash.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { withTransaction } from "../db/pool.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { LocalFsBlobStorageWriter } from "../mail/blobStorage.js";
import { createEmailDraft } from "../mail/draft.js";
import { ensureFolderItem } from "../mail/folderDiscovery.js";
import { ingestEmailMessage, type IngestEmailMessageInput } from "../mail/ingest.js";
import { createPrefilledEmailDraft, type PrefilledDraftMode } from "../mail/mailDraftPrefill.js";
import { createMailDraftCreateRouteHandler, createMailDraftReadRouteHandler } from "../mail/mailDraftRouteHandlers.js";
import { getMailDraft } from "../mail/mailDraftsStore.js";
import type { MailEnvelope } from "../mail/mailMessageMetaStore.js";
import { writeMailboxAddresses } from "../mail/mailboxAddresses.js";
import { createActionQueueAffinity } from "../scheduler/actions.js";
import { setInvalidationHook, type InvalidationEvent } from "../realtimeHook.js";
import { seedSystem } from "../seed/seedSystem.js";
import { getSystemTimezone } from "../systemSettings.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

const UPLOAD_LIMIT_BYTES = 10 * 1024 * 1024;

let admin: Pool;
let runtime: Pool;
let tenant: string;
let foreign: string;
let storageRoot: string;
let events: InvalidationEvent[];

const USER_ID = randomUUID();
const OWN_ADDRESS = "me@example.test";
const ALIAS_ADDRESS = "alias@example.test";
const PETR = { name: "Petr Novák", address: "petr@example.test" };
const JANA = { name: "", address: "jana@example.test" };
const KAREL = { name: "Karel", address: "karel@example.test" };

interface Fixture {
  mailboxId: string;
  /** A mailbox of the tenant that has no address and no Drafts folder. */
  addresslessMailboxId: string;
  draftsFolderId: string;
  inboxId: string;
}

interface ReceiveOptions {
  messageId?: string;
  subject?: string;
  envelope?: MailEnvelope;
  bodyHtml?: string;
  bodyText?: string;
  date?: Date;
  references?: string[];
  deliveredToHeaders?: string[];
  attachmentNames?: string[];
}

describe("the prefill of a reply, a reply-all and a forward draft (issue gh-1899)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    storageRoot = await mkdtemp(join(tmpdir(), "semprec-mail-draft-prefill-"));
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

  async function schema() {
    const cp = createChokePoint(runtime);
    const databases = await cp.listDatabases();
    const db = (key: string) => {
      const found = databases.find((row) => row.ownerModuleId === key);
      if (!found) throw new Error(`Missing ${key}`);
      return found.id;
    };
    const emailProperties = await cp.listProperties(db("emails"));
    const folderProperties = await cp.listProperties(db("folders"));
    const property = (properties: typeof emailProperties, key: string) => {
      const found = properties.find((row) => row.key === key);
      if (!found) throw new Error(`Missing ${key}`);
      return found.id;
    };
    return { db, emailProperties, folderProperties, property };
  }

  /** A mailbox of the tenant in scope with the address and the alias, a Drafts folder and an Inbox. */
  async function setup(): Promise<Fixture> {
    const { db, folderProperties, property } = await schema();
    return withTransaction(runtime, async (client) => {
      const mailbox = await createItemWithClient(client, {
        databaseId: db("mailboxes"),
        properties: { name: "Personal", provider: "gmail" },
      });
      await writeMailboxAddresses(client, {
        mailboxesDatabaseId: db("mailboxes"),
        mailboxItemId: mailbox.id,
        address: OWN_ADDRESS,
        aliases: [ALIAS_ADDRESS],
      });
      const addressless = await createItemWithClient(client, {
        databaseId: db("mailboxes"),
        properties: { name: "Without an address", provider: "gmail" },
      });
      const folder = (specialPurpose: string) =>
        ensureFolderItem(client, {
          foldersDatabaseId: db("folders"),
          mailboxItemId: mailbox.id,
          mailboxRelationPropertyId: property(folderProperties, "mailbox"),
          providerId: specialPurpose.toUpperCase(),
          name: specialPurpose,
          behavior: "folder",
          specialPurpose,
        });
      return {
        mailboxId: mailbox.id,
        addresslessMailboxId: addressless.id,
        draftsFolderId: await folder("drafts"),
        inboxId: await folder("inbox"),
      };
    });
  }

  /** Ingests a received message into the Inbox of `f.mailboxId` as the sync worker does and returns its Emails item id. */
  async function receive(f: Fixture, options: ReceiveOptions = {}): Promise<string> {
    const { db, emailProperties, property } = await schema();
    const input: IngestEmailMessageInput = {
      emailsDatabaseId: db("emails"),
      filesDatabaseId: db("files"),
      folderRelationPropertyId: property(emailProperties, "folder"),
      attachmentsRelationPropertyId: property(emailProperties, "attachments"),
      mailboxItemId: f.mailboxId,
      folderItemId: f.inboxId,
      messageId: options.messageId ?? `<${randomUUID()}@example.test>`,
      subject: options.subject ?? "Offer",
      date: options.date ?? new Date("2026-10-01T09:00:00Z"),
      envelope: options.envelope ?? { from: PETR, to: [{ name: "Me", address: OWN_ADDRESS }] },
      bodyHtml: options.bodyHtml,
      bodyText: options.bodyText ?? (options.bodyHtml === undefined ? "Hello" : undefined),
      references: options.references,
      deliveredToHeaders: options.deliveredToHeaders,
      attachments: (options.attachmentNames ?? []).map((filename) => ({
        filename,
        contentType: "application/pdf",
        contentId: null,
        disposition: "attachment" as const,
        openStream: () => Readable.from([Buffer.from(`bytes of ${filename} ${randomUUID()}`)]),
      })),
      storage: new LocalFsBlobStorageWriter(storageRoot),
      storageKeyPrefix: "draft-prefill-fixtures",
    };
    const { itemId } = await withTransaction(runtime, (client) => ingestEmailMessage(client, input));
    return itemId;
  }

  const ctx = (body: unknown, locale = "en") => ({
    params: {},
    body,
    identity: { user: { id: USER_ID, locale } },
  });

  /** The create route as the composition root mounts it, with the upload limit. */
  function createDraft(body: unknown, locale = "en", inTenant = tenant) {
    return runInTenant(inTenant, () =>
      createMailDraftCreateRouteHandler(runtime, { maxFileSizeBytes: UPLOAD_LIMIT_BYTES })(ctx(body, locale)),
    ).then((answer) => answer.body);
  }

  function start(f: Fixture, mode: PrefilledDraftMode, sourceEmailId: string, extra: Record<string, unknown> = {}) {
    return createDraft({ mailboxId: f.mailboxId, mode, sourceEmailId, ...extra });
  }

  async function threadOf(emailItemId: string): Promise<string> {
    const { rows } = await runtime.query<{ thread_id: string }>(
      "SELECT thread_id FROM mail_message_meta WHERE tenant_id = app_tenant_default() AND item_id = $1",
      [emailItemId],
    );
    const threadId = rows[0]?.thread_id;
    if (!threadId) throw new Error("Missing thread");
    return threadId;
  }

  async function draftRow(draftId: string) {
    const row = await getMailDraft(runtime, draftId);
    if (!row) throw new Error("Missing draft row");
    return row;
  }

  async function draftCount(): Promise<number> {
    const { rows } = await runtime.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM mail_drafts WHERE tenant_id = app_tenant_default()",
    );
    return rows[0]?.n ?? -1;
  }

  /** The Files items an email holds through `Emails.attachments`, trashed ones included. */
  async function attachmentEdgesOf(emailItemId: string): Promise<{ fileId: string; blobId: string; name: string }[]> {
    const { rows } = await runtime.query<{ file_id: string; blob_id: string; name: string }>(
      `SELECT f.id::text AS file_id, f.properties->'file'->>'blobId' AS blob_id, f.properties->>'name' AS name
       FROM item_relations r
       JOIN relation_definitions rd ON rd.id = r.relation_definition_id AND rd.tenant_id = r.tenant_id
       JOIN properties p ON p.id = rd.property_id_a AND p.tenant_id = rd.tenant_id AND p.key = 'attachments'
       JOIN items f ON f.id = r.item_b AND f.tenant_id = r.tenant_id
       WHERE r.tenant_id = app_tenant_default() AND r.item_a = $1
       ORDER BY f.properties->>'name'`,
      [emailItemId],
    );
    return rows.map((row) => ({ fileId: row.file_id, blobId: row.blob_id, name: row.name }));
  }

  /** The date a quote shows, derived with Luxon like the code and the system timezone of the tenant. */
  async function shown(date: Date, locale: "en" | "cs"): Promise<string> {
    const zone = await getSystemTimezone(runtime);
    return DateTime.fromJSDate(date, { zone })
      .setLocale(locale)
      .toLocaleString({ dateStyle: "long", timeStyle: "short" });
  }

  /** Stores `timezone` as the System settings timezone of the tenant, as the settings writer validates it with Luxon. */
  async function setTenantTimezone(timezone: string): Promise<void> {
    await admin.query(
      `UPDATE items SET properties = properties || jsonb_build_object('timezone', $2::text)
       WHERE tenant_id = $1 AND database_id = (
         SELECT id FROM databases WHERE tenant_id = $1 AND system AND owner_module_id = 'systemSettings')`,
      [tenant, timezone],
    );
  }

  const SOURCE_DATE = new Date("2026-10-01T09:00:00Z");

  describe("recipients", () => {
    it("replies to all of a message from Gmail without any address of the mailbox and sends it from the address it was delivered to", async () => {
      await runInTenant(tenant, async () => {
        const f = await setup();
        const source = await receive(f, {
          envelope: {
            from: PETR,
            to: [{ name: "Me", address: OWN_ADDRESS }, JANA],
            // The same address in another letter case, an alias of the mailbox and a new person.
            cc: [{ name: "Karel", address: "Karel@Example.test" }, { name: "", address: "ALIAS@example.test" }, KAREL],
          },
          deliveredToHeaders: ["Me <alias@example.test>"],
        });

        const draft = await start(f, "replyAll", source);

        expect(draft.to).toEqual([PETR, JANA, { name: "Karel", address: "Karel@Example.test" }]);
        expect(draft.to.map((entry) => entry.address.toLowerCase())).not.toContain(OWN_ADDRESS);
        expect(draft.to.map((entry) => entry.address.toLowerCase())).not.toContain(ALIAS_ADDRESS);
        expect(draft.from).toBe(ALIAS_ADDRESS);
        expect(draft.cc).toEqual([]);
        expect(draft.bcc).toEqual([]);
        expect(draft).toMatchObject({ mode: "replyAll", sourceEmailId: source, createdBy: "user" });
      });
    });

    it("sends a reply to the Reply-To of the message and not to its sender", async () => {
      await runInTenant(tenant, async () => {
        const f = await setup();
        const source = await receive(f, {
          envelope: { from: PETR, to: [{ name: "Me", address: OWN_ADDRESS }], replyTo: [JANA, KAREL] },
        });

        const draft = await start(f, "reply", source);

        expect(draft.to).toEqual([JANA, KAREL]);
        expect(draft.cc).toEqual([]);
      });
    });

    it("sends a reply without a Reply-To to the sender", async () => {
      await runInTenant(tenant, async () => {
        const f = await setup();
        const source = await receive(f);

        const draft = await start(f, "reply", source);

        expect(draft.to).toEqual([PETR]);
      });
    });

    it("sends a reply whose Reply-To holds no usable address to the sender, and drops unusable addresses", async () => {
      await runInTenant(tenant, async () => {
        const f = await setup();
        const source = await receive(f, {
          envelope: {
            from: { name: "Petr\r\nBcc: x@example.test", address: PETR.address },
            to: [{ name: "Me", address: OWN_ADDRESS }],
            replyTo: [
              { name: "", address: "not an address" },
              { name: "", address: "no-at-sign" },
            ],
          },
        });

        const draft = await start(f, "reply", source);

        expect(draft.to).toEqual([{ name: "Petr  Bcc: x@example.test", address: PETR.address }]);
      });
    });

    it("sends a reply to nobody when the message has neither a Reply-To nor a sender", async () => {
      await runInTenant(tenant, async () => {
        const f = await setup();
        const source = await receive(f, { envelope: { to: [{ name: "Me", address: OWN_ADDRESS }] } });

        const draft = await start(f, "reply", source);

        expect(draft.to).toEqual([]);
      });
    });

    it("adds the Reply-To and the To and Cc recipients of the message to a reply-all, once each", async () => {
      await runInTenant(tenant, async () => {
        const f = await setup();
        const source = await receive(f, {
          envelope: {
            from: PETR,
            to: [KAREL, { name: "Me", address: OWN_ADDRESS }],
            cc: [JANA, KAREL],
            replyTo: [JANA],
          },
        });

        const draft = await start(f, "replyAll", source);

        expect(draft.to).toEqual([JANA, KAREL]);
      });
    });

    it("gives a forward no recipients", async () => {
      await runInTenant(tenant, async () => {
        const f = await setup();
        const source = await receive(f, { envelope: { from: PETR, to: [JANA], cc: [KAREL] } });

        const draft = await start(f, "forward", source);

        expect(draft).toMatchObject({ to: [], cc: [], bcc: [], mode: "forward" });
      });
    });

    it("ignores the values the request gives for the fields the prefill computes", async () => {
      await runInTenant(tenant, async () => {
        const f = await setup();
        const source = await receive(f, { subject: "Offer" });

        const draft = await start(f, "reply", source, {
          from: "attacker@example.test",
          to: [KAREL],
          cc: [JANA],
          bcc: [KAREL],
          subject: "Something else",
          threadId: randomUUID(),
        });

        expect(draft).toMatchObject({
          from: OWN_ADDRESS,
          to: [PETR],
          cc: [],
          bcc: [],
          subject: "Re: Offer",
          threadId: await threadOf(source),
        });
      });
    });
  });

  describe("the sending address", () => {
    it("is the address the message was delivered to when it belongs to the mailbox", async () => {
      await runInTenant(tenant, async () => {
        const f = await setup();
        const source = await receive(f, { deliveredToHeaders: [ALIAS_ADDRESS.toUpperCase()] });

        expect((await start(f, "reply", source)).from).toBe(ALIAS_ADDRESS);
      });
    });

    it("is the primary address of the mailbox when the message was delivered to an address it does not have", async () => {
      await runInTenant(tenant, async () => {
        const f = await setup();
        const source = await receive(f, { deliveredToHeaders: ["someone@elsewhere.test"] });

        expect((await start(f, "reply", source)).from).toBe(OWN_ADDRESS);
      });
    });

    it("is the primary address of the mailbox for a message that records no delivered-to address", async () => {
      await runInTenant(tenant, async () => {
        const f = await setup();
        const source = await receive(f);
        const { rows } = await runtime.query<{ delivered_to_address: string | null }>(
          "SELECT delivered_to_address FROM mail_message_meta WHERE tenant_id = app_tenant_default() AND item_id = $1",
          [source],
        );
        expect(rows[0]?.delivered_to_address).toBeNull();

        expect((await start(f, "reply", source)).from).toBe(OWN_ADDRESS);
      });
    });

    it("is refused with a 400 for a mailbox that has no address", async () => {
      await runInTenant(tenant, async () => {
        const f = await setup();
        const source = await receive(f);

        const refusal = await createDraft({
          mailboxId: f.addresslessMailboxId,
          mode: "reply",
          sourceEmailId: source,
        }).catch((error: unknown) => error);

        if (!(refusal instanceof ValidationError)) throw new Error("Expected a ValidationError");
        expect(refusal.details).toEqual({ field: "mailboxId" });
        expect(await draftCount()).toBe(0);
      });
    });
  });

  describe("the subject", () => {
    it.each([
      ["reply", "Offer", "Re: Offer"],
      ["reply", "Re: Offer", "Re: Offer"],
      ["replyAll", "RE: Offer", "RE: Offer"],
      ["reply", "re:Offer", "re:Offer"],
      ["reply", "Fwd: Offer", "Re: Fwd: Offer"],
      ["forward", "Offer", "Fwd: Offer"],
      ["forward", "FWD: Offer", "FWD: Offer"],
      ["forward", "Re: Offer", "Fwd: Re: Offer"],
    ] as const)("%s of the subject %j is %j", async (mode, subject, expected) => {
      await runInTenant(tenant, async () => {
        const f = await setup();
        const source = await receive(f, { subject });

        expect((await start(f, mode, source)).subject).toBe(expected);
      });
    });

    it("is cut to the length a header line may have and holds no line break", async () => {
      await runInTenant(tenant, async () => {
        const f = await setup();
        const source = await receive(f, { subject: `${"a\r\nb".repeat(400)}` });

        const { subject } = await start(f, "reply", source);

        expect(subject.length).toBeLessThanOrEqual(998);
        expect(subject.startsWith("Re: a  b")).toBe(true);
      });
    });

    it("is not cut inside a surrogate pair", async () => {
      await runInTenant(tenant, async () => {
        const f = await setup();
        // "Re: " takes four units, so the pair starts at unit 997 and its second half would be unit 998.
        const source = await receive(f, { subject: `${"a".repeat(993)}😀${"b".repeat(10)}` });

        const { subject } = await start(f, "reply", source);

        expect(subject).toBe(`Re: ${"a".repeat(993)}`);
      });
    });
  });

  describe("threading", () => {
    it("sets the Message-ID of the message as in-reply-to, ends the references with it and keeps the thread of the message", async () => {
      await runInTenant(tenant, async () => {
        const f = await setup();
        const source = await receive(f, {
          messageId: "<source@example.test>",
          references: ["<a@x.test>", "<b@x.test>"],
        });

        const draft = await start(f, "reply", source);

        const row = await draftRow(draft.id);
        expect(row.inReplyTo).toBe("<source@example.test>");
        expect(row.references).toEqual(["<a@x.test>", "<b@x.test>", "<source@example.test>"]);
        expect(row.threadId).toBe(await threadOf(source));
        expect(draft.threadId).toBe(row.threadId);
      });
    });

    it("lists only the Message-ID when the message has no references, for a reply-all as well", async () => {
      await runInTenant(tenant, async () => {
        const f = await setup();
        const source = await receive(f, { messageId: "<source@example.test>" });

        const draft = await start(f, "replyAll", source);

        const row = await draftRow(draft.id);
        expect(row.inReplyTo).toBe("<source@example.test>");
        expect(row.references).toEqual(["<source@example.test>"]);
      });
    });

    it("does not list the Message-ID twice when the references end with it already", async () => {
      await runInTenant(tenant, async () => {
        const f = await setup();
        const source = await receive(f, {
          messageId: "<source@example.test>",
          references: ["<a@x.test>", "<source@example.test>"],
        });

        const draft = await start(f, "reply", source);

        expect((await draftRow(draft.id)).references).toEqual(["<a@x.test>", "<source@example.test>"]);
      });
    });

    it("gives a forward the thread of the message and neither an in-reply-to nor references", async () => {
      await runInTenant(tenant, async () => {
        const f = await setup();
        const source = await receive(f, { messageId: "<source@example.test>", references: ["<a@x.test>"] });

        const draft = await start(f, "forward", source);

        const row = await draftRow(draft.id);
        expect(row.threadId).toBe(await threadOf(source));
        expect(row.inReplyTo).toBeNull();
        expect(row.references).toEqual([]);
      });
    });

    it("announces the change on the thread of the message once", async () => {
      await runInTenant(tenant, async () => {
        const f = await setup();
        const source = await receive(f);
        events = [];
        setInvalidationHook((event) => {
          if (event.scope === "mailThread") events.push(event);
        });

        await start(f, "reply", source);

        expect(events).toEqual([{ scope: "mailThread", threadId: await threadOf(source) }]);
      });
    });
  });

  describe("the body", () => {
    it("puts the quote of the message below the text of the person, behind an empty line, in English", async () => {
      await runInTenant(tenant, async () => {
        const f = await setup();
        const source = await receive(f, { bodyText: "Line one\r\n\r\nLine three", date: SOURCE_DATE });

        const draft = await start(f, "reply", source, { body: "Thanks" });

        expect(draft.body).toBe(
          `Thanks\n\nOn ${await shown(SOURCE_DATE, "en")}, Petr Novák wrote:\n> Line one\n> \n> Line three`,
        );
      });
    });

    it("writes the header of the quote in Czech for a user whose locale is Czech", async () => {
      await runInTenant(tenant, async () => {
        const f = await setup();
        const source = await receive(f, { bodyText: "Dobrý den", date: SOURCE_DATE });

        const draft = await createDraft({ mailboxId: f.mailboxId, mode: "reply", sourceEmailId: source }, "cs");

        expect(draft.body).toBe(`\n\nDne ${await shown(SOURCE_DATE, "cs")} napsal(a) Petr Novák:\n> Dobrý den`);
      });
    });

    it("writes the header in English for a locale the catalogs do not have", async () => {
      await runInTenant(tenant, async () => {
        const f = await setup();
        const source = await receive(f, { bodyText: "Hallo", date: SOURCE_DATE });

        const draft = await createDraft({ mailboxId: f.mailboxId, mode: "reply", sourceEmailId: source }, "de");

        expect(draft.body).toBe(`\n\nOn ${await shown(SOURCE_DATE, "en")}, Petr Novák wrote:\n> Hallo`);
      });
    });

    it("names a sender without a display name by the address", async () => {
      await runInTenant(tenant, async () => {
        const f = await setup();
        const source = await receive(f, { envelope: { from: JANA, to: [] }, bodyText: "Hi", date: SOURCE_DATE });

        const draft = await start(f, "reply", source);

        expect(draft.body).toBe(`\n\nOn ${await shown(SOURCE_DATE, "en")}, jana@example.test wrote:\n> Hi`);
      });
    });

    it("names the sender by the Emails sender property when the envelope has none", async () => {
      await runInTenant(tenant, async () => {
        const f = await setup();
        const source = await receive(f, { envelope: { to: [] }, bodyText: "Hi", date: SOURCE_DATE });
        // The Emails item of a message that was synced before the envelope was stored has a sender and no envelope sender.
        await admin.query(
          'UPDATE items SET properties = properties || \'{"sender": "Old Sender <old@example.test>"}\'::jsonb WHERE id = $1',
          [source],
        );

        const draft = await start(f, "reply", source);

        expect(draft.body).toBe(`\n\nOn ${await shown(SOURCE_DATE, "en")}, Old Sender <old@example.test> wrote:\n> Hi`);
      });
    });

    it("quotes the plain text of an HTML body, with its line breaks and without markup or escaped characters", async () => {
      await runInTenant(tenant, async () => {
        const f = await setup();
        const source = await receive(f, {
          bodyHtml: "<p>Tom &amp; Jerry &lt;3</p><div>Second<br>line</div><script>alert(1)</script>",
          date: SOURCE_DATE,
        });

        const draft = await start(f, "reply", source);

        expect(draft.body).toBe(
          `\n\nOn ${await shown(SOURCE_DATE, "en")}, Petr Novák wrote:\n> Tom & Jerry <3\n> Second\n> line`,
        );
      });
    });

    it("quotes the text part of a text-only message as it is, with the addresses and links in angle brackets and a literal entity", async () => {
      await runInTenant(tenant, async () => {
        const f = await setup();
        const text =
          "On Mon, Petr <petr@example.test> wrote:\n> see <https://example.test/a> and 1 < 2 > 0 &amp; x &lt;3";
        const source = await receive(f, { bodyText: text, date: SOURCE_DATE });

        const reply = await start(f, "reply", source);
        const forward = await start(f, "forward", source);

        const quoted = text
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n");
        expect(reply.body).toBe(`\n\nOn ${await shown(SOURCE_DATE, "en")}, Petr Novák wrote:\n${quoted}`);
        expect(forward.body).toContain(`\n\n${quoted}`);
      });
    });

    it("still strips the markup of an HTML body that has only an anchor and entities", async () => {
      await runInTenant(tenant, async () => {
        const f = await setup();
        const withMarkup = await receive(f, {
          bodyHtml: "<html><body><a href='https://example.test/a'>a link</a> &amp; co</body></html>",
          date: SOURCE_DATE,
        });

        const draft = await start(f, "reply", withMarkup);

        expect(draft.body).toBe(`\n\nOn ${await shown(SOURCE_DATE, "en")}, Petr Novák wrote:\n> a link & co`);
      });
    });

    it("has only the header line when the message has no text", async () => {
      await runInTenant(tenant, async () => {
        const f = await setup();
        const source = await receive(f, { bodyText: "", date: SOURCE_DATE });

        const draft = await start(f, "reply", source);

        expect(draft.body).toBe(`\n\nOn ${await shown(SOURCE_DATE, "en")}, Petr Novák wrote:`);
      });
    });

    it("dates the quote by the time the message entered Semprec when it has no date, and by its creation time when it has neither", async () => {
      await runInTenant(tenant, async () => {
        const f = await setup();
        const source = await receive(f, { bodyText: "Hi" });
        // A message synced before dates were stored has no date property; no write of the API removes one.
        await admin.query("UPDATE items SET properties = properties - 'date' WHERE id = $1", [source]);
        const { rows } = await runtime.query<{ ingested_at: Date; created_at: Date }>(
          `SELECT m.ingested_at, i.created_at FROM mail_message_meta m JOIN items i ON i.id = m.item_id AND i.tenant_id = m.tenant_id
           WHERE m.tenant_id = app_tenant_default() AND m.item_id = $1`,
          [source],
        );
        const ingestedAt = rows[0]?.ingested_at;
        const createdAt = rows[0]?.created_at;
        if (!ingestedAt || !createdAt) throw new Error("Missing timestamps");

        const byIngest = await start(f, "reply", source);
        expect(byIngest.body).toContain(`On ${await shown(ingestedAt, "en")}, Petr Novák wrote:`);

        await admin.query("UPDATE mail_message_meta SET ingested_at = NULL WHERE item_id = $1", [source]);
        const byCreation = await start(f, "reply", source);
        expect(byCreation.body).toContain(`On ${await shown(createdAt, "en")}, Petr Novák wrote:`);
      });
    });

    it("quotes at most 100000 characters of the message and does not cut a surrogate pair", async () => {
      await runInTenant(tenant, async () => {
        const f = await setup();
        const source = await receive(f, { bodyText: `${"a".repeat(99_999)}😀${"b".repeat(50)}`, date: SOURCE_DATE });

        const draft = await start(f, "reply", source);

        expect(draft.body.endsWith(`> ${"a".repeat(99_999)}`)).toBe(true);
      });
    });

    it("quotes at most 100000 characters of the message when the cut falls between whole characters", async () => {
      await runInTenant(tenant, async () => {
        const f = await setup();
        const source = await receive(f, { bodyText: "a".repeat(100_050), date: SOURCE_DATE });

        const draft = await start(f, "reply", source);

        expect(draft.body.endsWith(`> ${"a".repeat(100_000)}`)).toBe(true);
      });
    });

    it("heads a forward with the original sender, date, subject and recipients in English", async () => {
      await runInTenant(tenant, async () => {
        const f = await setup();
        const source = await receive(f, {
          subject: "Offer",
          envelope: { from: PETR, to: [JANA, { name: "Me", address: OWN_ADDRESS }], cc: [KAREL] },
          bodyText: "Body",
          date: SOURCE_DATE,
        });

        const draft = await start(f, "forward", source, { body: "FYI" });

        expect(draft.body).toBe(
          [
            "FYI",
            "",
            "---------- Forwarded message ----------",
            "From: Petr Novák <petr@example.test>",
            `Date: ${await shown(SOURCE_DATE, "en")}`,
            "Subject: Offer",
            "To: jana@example.test, Me <me@example.test>",
            "Cc: Karel <karel@example.test>",
            "",
            "> Body",
          ].join("\n"),
        );
      });
    });

    it("heads a forward in Czech, without a Cc line when the message has no Cc", async () => {
      await runInTenant(tenant, async () => {
        const f = await setup();
        const source = await receive(f, {
          subject: "Nabídka",
          envelope: { from: PETR, to: [JANA] },
          bodyText: "Text",
          date: SOURCE_DATE,
        });

        const draft = await createDraft({ mailboxId: f.mailboxId, mode: "forward", sourceEmailId: source }, "cs");

        expect(draft.body).toBe(
          [
            "",
            "",
            "---------- Přeposlaná zpráva ----------",
            "Od: Petr Novák <petr@example.test>",
            `Datum: ${await shown(SOURCE_DATE, "cs")}`,
            "Předmět: Nabídka",
            "Komu: jana@example.test",
            "",
            "> Text",
          ].join("\n"),
        );
      });
    });

    it("heads a forward of a message without a text with the header lines only", async () => {
      await runInTenant(tenant, async () => {
        const f = await setup();
        const source = await receive(f, { envelope: { from: PETR, to: [JANA] }, bodyText: "", date: SOURCE_DATE });

        const draft = await start(f, "forward", source);

        expect(draft.body.endsWith("To: jana@example.test")).toBe(true);
      });
    });

    it("names the sender of a forward by the Emails sender property when the envelope has none", async () => {
      await runInTenant(tenant, async () => {
        const f = await setup();
        const source = await receive(f, { envelope: { to: [JANA] }, bodyText: "Hi", date: SOURCE_DATE });
        await admin.query(
          'UPDATE items SET properties = properties || \'{"sender": "Old Sender <old@example.test>"}\'::jsonb WHERE id = $1',
          [source],
        );

        const draft = await start(f, "forward", source);

        expect(draft.body).toContain("From: Old Sender <old@example.test>\n");
      });
    });
  });

  describe("the date of the quote", () => {
    it("is written in a fixed-offset timezone such as UTC+2 that the tenant stored, for a reply, a reply-all and a forward", async () => {
      await runInTenant(tenant, async () => {
        await setTenantTimezone("UTC+2");
        const f = await setup();
        const source = await receive(f, { bodyText: "Hi", date: SOURCE_DATE });

        const date = await shown(SOURCE_DATE, "en");
        expect(date).toContain("11:00");
        for (const mode of ["reply", "replyAll", "forward"] as const) {
          const draft = await start(f, mode, source);
          expect(draft.body).toContain(date);
        }
      });
    });

    it("is refused with a 400 naming the timezone when the stored zone is one Luxon cannot read, and writes nothing", async () => {
      await runInTenant(tenant, async () => {
        await setTenantTimezone("Mars/Base");
        const f = await setup();
        const source = await receive(f, { bodyText: "Hi", date: SOURCE_DATE });

        await expect(start(f, "reply", source)).rejects.toMatchObject({
          status: 400,
          details: { field: "timezone" },
        });
        expect(await draftCount()).toBe(0);
      });
    });
  });

  describe("the forwarded attachments", () => {
    it("gives the new draft its own copies and leaves the files of the original message", async () => {
      await runInTenant(tenant, async () => {
        const f = await setup();
        const source = await receive(f, { attachmentNames: ["offer.pdf", "terms.pdf"] });
        const before = await attachmentEdgesOf(source);
        expect(before.map((file) => file.name)).toEqual(["offer.pdf", "terms.pdf"]);

        const draft = await start(f, "forward", source);

        // The copies are created in one transaction, so the view's order (creation time, then id) is not the source's.
        expect(draft.attachments.map((file) => file.filename).sort()).toEqual(["offer.pdf", "terms.pdf"]);
        const copies = await attachmentEdgesOf(draft.id);
        expect(copies.map((file) => [file.name, file.blobId])).toEqual(before.map((file) => [file.name, file.blobId]));
        for (const copy of copies) expect(before.map((file) => file.fileId)).not.toContain(copy.fileId);
        expect(await attachmentEdgesOf(source)).toEqual(before);
      });
    });

    it("attaches nothing to a reply of a message that has attachments", async () => {
      await runInTenant(tenant, async () => {
        const f = await setup();
        const source = await receive(f, { attachmentNames: ["offer.pdf"] });

        const draft = await start(f, "replyAll", source);

        expect(draft.attachments).toEqual([]);
        expect(await attachmentEdgesOf(draft.id)).toEqual([]);
      });
    });

    it("refuses a forward whose attachments are over the limit with a 413 and writes nothing", async () => {
      await runInTenant(tenant, async () => {
        const f = await setup();
        const source = await receive(f, { attachmentNames: ["offer.pdf"] });
        // The fixture mailbox is a Gmail one with a 25 MB limit, so the limit is lowered through its provider.
        await admin.query(
          'UPDATE items SET properties = properties || \'{"provider": "generic"}\'::jsonb WHERE id = $1',
          [f.mailboxId],
        );

        const refusal = await runInTenant(tenant, () =>
          createMailDraftCreateRouteHandler(runtime, { maxFileSizeBytes: 1 })(
            ctx({ mailboxId: f.mailboxId, mode: "forward", sourceEmailId: source }),
          ),
        ).catch((error: unknown) => error);

        expect(refusal).toMatchObject({ status: 413, code: "mail_attachment_too_large" });
        expect(await draftCount()).toBe(0);
        expect(await attachmentEdgesOf(source)).toHaveLength(1);
      });
    });

    it("fails a forward when the composition root configured no upload limit, and a reply does not need one", async () => {
      await runInTenant(tenant, async () => {
        const f = await setup();
        const source = await receive(f);

        const refusal = await runInTenant(tenant, () =>
          createMailDraftCreateRouteHandler(runtime)(
            ctx({ mailboxId: f.mailboxId, mode: "forward", sourceEmailId: source }),
          ),
        ).catch((error: unknown) => error);
        const reply = await runInTenant(tenant, () =>
          createMailDraftCreateRouteHandler(runtime)(
            ctx({ mailboxId: f.mailboxId, mode: "reply", sourceEmailId: source }),
          ),
        );

        expect(refusal).toBeInstanceOf(Error);
        expect(refusal).not.toHaveProperty("status");
        expect(reply.status).toBe(201);
        expect(await draftCount()).toBe(1);
      });
    });

    it("fails an operation call that forwards attachments without an upload limit and rolls the draft back", async () => {
      await runInTenant(tenant, async () => {
        const f = await setup();
        const source = await receive(f, { attachmentNames: ["offer.pdf"] });
        const input = {
          mailboxItemId: f.mailboxId,
          sourceEmailItemId: source,
          mode: "forward" as const,
          locale: "en",
          body: "",
        };

        const refusal = await withTransaction(runtime, (client) =>
          createPrefilledEmailDraft(client, input, { writer: { writerKind: "user" }, actingUserId: USER_ID }),
        ).catch((error: unknown) => error);

        expect(refusal).toBeInstanceOf(Error);
        expect(refusal).toHaveProperty("message", "A forward with attachments needs the upload limit");
        expect(await draftCount()).toBe(0);
      });
    });

    it("forwards a message without attachments when no upload limit is given", async () => {
      await runInTenant(tenant, async () => {
        const f = await setup();
        const source = await receive(f);
        const input = {
          mailboxItemId: f.mailboxId,
          sourceEmailItemId: source,
          mode: "forward" as const,
          locale: "en",
          body: "",
        };

        const draft = await withTransaction(runtime, (client) =>
          createPrefilledEmailDraft(client, input, { writer: { writerKind: "user" }, actingUserId: USER_ID }),
        );

        expect(draft).toMatchObject({ mode: "forward", attachments: [] });
      });
    });
  });

  describe("the writer", () => {
    it("records an agent as the creator of a draft it starts, with the prefill of the person's", async () => {
      await runInTenant(tenant, async () => {
        const f = await setup();
        const source = await receive(f, { messageId: "<source@example.test>" });
        const input = {
          mailboxItemId: f.mailboxId,
          sourceEmailItemId: source,
          mode: "reply" as const,
          locale: "cs",
          body: "Draft",
        };

        const draft = await withTransaction(runtime, (client) =>
          createPrefilledEmailDraft(client, input, { writer: { writerKind: "agent" }, actingUserId: USER_ID }),
        );

        expect(draft).toMatchObject({ createdBy: "agent", lastEditedBy: "agent", to: [PETR], subject: "Re: Offer" });
        expect(draft.body.startsWith("Draft\n\nDne ")).toBe(true);
        expect((await draftRow(draft.id)).inReplyTo).toBe("<source@example.test>");
      });
    });
  });

  describe("the refusals", () => {
    it.each(["reply", "replyAll", "forward"] as const)(
      "answers a %s without a source message with a 400",
      async (mode) => {
        await runInTenant(tenant, async () => {
          const f = await setup();

          const refusal = await createDraft({ mailboxId: f.mailboxId, mode }).catch((error: unknown) => error);

          if (!(refusal instanceof ValidationError)) throw new Error("Expected a ValidationError");
          expect(refusal.details).toEqual({ field: "sourceEmailId" });
          expect(await draftCount()).toBe(0);
        });
      },
    );

    it("still requires the fields of a new draft", async () => {
      await runInTenant(tenant, async () => {
        const f = await setup();

        const refusal = await createDraft({
          mailboxId: f.mailboxId,
          from: OWN_ADDRESS,
          cc: [],
          bcc: [],
          subject: "Subject",
          body: "Body",
        }).catch((error: unknown) => error);

        if (!(refusal instanceof ValidationError)) throw new Error("Expected a ValidationError");
        expect(refusal.details).toEqual({ field: "to" });
      });
    });

    it("answers 404 for a source message that does not exist, and writes nothing", async () => {
      await runInTenant(tenant, async () => {
        const f = await setup();

        const refusal = await start(f, "reply", randomUUID()).catch((error: unknown) => error);

        expect(refusal).toBeInstanceOf(NotFoundError);
        expect(await draftCount()).toBe(0);
      });
    });

    it("answers 404 for a source message in the Trash", async () => {
      await runInTenant(tenant, async () => {
        const f = await setup();
        const source = await receive(f);
        const { db } = await schema();
        await withTransaction(runtime, (client) =>
          itemDeleteWithClient(client, db("emails"), source, { queueAffinity: createActionQueueAffinity() }),
        );

        const refusal = await start(f, "reply", source).catch((error: unknown) => error);

        expect(refusal).toBeInstanceOf(NotFoundError);
        expect(await draftCount()).toBe(0);
      });
    });

    it("answers 404 for an Emails item that is no received message, as a draft is", async () => {
      await runInTenant(tenant, async () => {
        const f = await setup();
        const { db, emailProperties, property } = await schema();
        const own = await withTransaction(runtime, (client) =>
          createEmailDraft(client, {
            emailsDatabaseId: db("emails"),
            folderRelationPropertyId: property(emailProperties, "folder"),
            draftsFolderItemId: f.draftsFolderId,
            subject: "Mine",
          }),
        );

        const refusal = await start(f, "reply", own.id).catch((error: unknown) => error);

        expect(refusal).toBeInstanceOf(NotFoundError);
        expect(await draftCount()).toBe(0);
      });
    });

    it("answers 404 for a mailbox that does not exist", async () => {
      await runInTenant(tenant, async () => {
        const f = await setup();
        const source = await receive(f);

        const refusal = await createDraft({ mailboxId: randomUUID(), mode: "reply", sourceEmailId: source }).catch(
          (error: unknown) => error,
        );

        expect(refusal).toBeInstanceOf(NotFoundError);
        expect(await draftCount()).toBe(0);
      });
    });

    it("answers a source message of another tenant like one that does not exist, and a message of the tenant is not found from the other", async () => {
      const own = await runInTenant(tenant, async () => {
        const f = await setup();
        return { f, source: await receive(f, { attachmentNames: ["offer.pdf"] }) };
      });
      const other = await runInTenant(foreign, async () => {
        const f = await setup();
        return { f, source: await receive(f) };
      });

      const attempt = (inTenant: string, mailboxId: string, mode: PrefilledDraftMode, sourceEmailId: string) =>
        createDraft({ mailboxId, mode, sourceEmailId }, "en", inTenant).catch((error: unknown) => error);
      expect(await attempt(tenant, own.f.mailboxId, "forward", other.source)).toBeInstanceOf(NotFoundError);
      expect(await attempt(tenant, other.f.mailboxId, "reply", own.source)).toBeInstanceOf(NotFoundError);
      expect(await attempt(foreign, other.f.mailboxId, "forward", own.source)).toBeInstanceOf(NotFoundError);
      expect(await runInTenant(tenant, draftCount)).toBe(0);
      expect(await runInTenant(foreign, draftCount)).toBe(0);
      expect(await runInTenant(foreign, () => attachmentEdgesOf(own.source))).toEqual([]);

      const draft = await createDraft({ mailboxId: own.f.mailboxId, mode: "forward", sourceEmailId: own.source });
      expect(draft.attachments.map((file) => file.filename)).toEqual(["offer.pdf"]);
    });
  });

  it("opens a started draft again with the same fields", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const source = await receive(f, { subject: "Offer", bodyText: "Hello" });

      const draft = await start(f, "reply", source, { body: "Thanks" });

      expect(draft).toMatchObject({ mailboxId: f.mailboxId, mode: "reply", sourceEmailId: source, sentAt: null });
      const reopened = await createMailDraftReadRouteHandler(runtime)({
        params: { id: draft.id },
        body: undefined,
        identity: { user: { id: USER_ID } },
      });
      expect(reopened.body).toEqual(draft);
    });
  });
});
