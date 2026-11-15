import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { simpleParser } from "mailparser";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { runOnce } from "@semprec/queue";
import { readJobPayloadsByIdentifier } from "@semprec/queue/testSupport";
import { runInTenant } from "@semprec/shared";
import { SYSTEM_WRITER } from "../../chokePoint/writerKind.js";
import { withTransaction } from "../../db/pool.js";
import { MailRecipientRejectedError, MailTransportUnavailableError } from "../../mail/providerTypes.js";
import { writeMailboxAddresses } from "../../mail/mailboxAddresses.js";
import { createMailTransportFactory, type MailTransport } from "../../mail/mailTransport.js";
import { loadFullModuleRegistry } from "../../manifest/fullModuleRegistry.js";
import { mergeModuleTaskListForAffinity } from "../../moduleTasks.js";
import { ValidationError } from "../../errors.js";
import { recordingTransport, transportFor, type RecordingTransport } from "../../testSupport/mailSendFakes.js";
import type { MailAttachmentWorld as World } from "../../testSupport/mailAttachmentFixtures.js";
import { createRuntimeRolePool, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import {
  CALENDAR_SEND_INVITATION_REPLY_TASK,
  enqueueInvitationReply,
  handleCalendarSendInvitationReply,
  setInvitationReplyDelivery,
} from "../invitationReplyJob.js";
import { logger } from "../logger.js";
import { createInvitation } from "./invitationFixtures.js";
import {
  createInvitationMail,
  ics,
  ORGANIZER_ADDRESS,
  type InvitationMail,
  type MailTenant,
} from "./invitationMailFixtures.js";

/**
 * The iMIP `REPLY` that follows an answer (issue gh-1953): the job the respond route queues in the answer's
 * transaction, and the message the job sends to the organizer. Everything runs on the runtime role pool, in tenants
 * of their own; the queue is the real one, and the transport records instead of sending.
 */

const TASK = CALENDAR_SEND_INVITATION_REPLY_TASK;
/** The address of the mailbox of `setupMailAttachmentWorld`, which receives every invitation below. */
const MAILBOX_ADDRESS = "me@example.test";
const ALIAS_ADDRESS = "alias@example.test";

let admin: Pool;
let runtime: Pool;
let mail: InvitationMail;
let transport: RecordingTransport;
let tenant: MailTenant;
let world: World;

const jobSchema = z.object({
  key: z.string().nullable(),
  attempts: z.number(),
  lastError: z.string().nullable(),
  runsLater: z.boolean(),
});

/** The queued jobs of the task, from the queue's public view, oldest first. */
async function queuedJobs() {
  const { rows } = await admin.query<Record<string, unknown>>(
    `SELECT key, attempts, last_error AS "lastError", (run_at > now()) AS "runsLater"
     FROM graphile_worker.jobs WHERE task_identifier = $1 ORDER BY id`,
    [TASK],
  );
  return rows.map((row) => jobSchema.parse(row));
}

const envelopeSchema = z.object({ tenantId: z.string(), payload: z.record(z.string(), z.unknown()) });

async function queuedPayloads() {
  return (await readJobPayloadsByIdentifier(admin, TASK)).map((raw) => envelopeSchema.parse(raw));
}

const invitationRow = z.object({ id: z.string(), properties: z.record(z.string(), z.unknown()) });

/** The tenant's invitations, trashed ones included, in id order, read as the superuser (a read, not an isolation proof). */
async function invitationsOf(of: World) {
  const { rows } = await admin.query("SELECT id, properties FROM items WHERE database_id = $1 ORDER BY id", [
    of.databases.invitations,
  ]);
  return z.array(invitationRow).parse(rows);
}

async function onlyInvitation(of: World = world) {
  const found = await invitationsOf(of);
  expect(found).toHaveLength(1);
  return found[0]!;
}

/** The invitation arrives (delivered to `deliveredTo` when given) and is ingested; returns its id. */
async function receiveInvitation(
  options: { text?: string; deliveredTo?: string } = {},
  into: { world: World } = tenant,
): Promise<string> {
  await mail.deliver(
    into.world,
    `<${randomUUID()}@example.test>`,
    options.text ?? ics(),
    ORGANIZER_ADDRESS,
    options.deliveredTo,
  );
  return (await onlyInvitation(into.world)).id;
}

const respond = (invitationId: string, response: string) => mail.respond(tenant, invitationId, response);

/** Runs the queued jobs of the task once, through the module registry's task list as the API runtime hosts it. */
async function runQueued(): Promise<void> {
  const taskList = await mergeModuleTaskListForAffinity({}, await loadFullModuleRegistry(), "api");
  await runOnce({ pgPool: admin }, { [TASK]: taskList[TASK]! });
}

/** Runs one payload through the task handler in the tenant's scope, as a retry of the job would. */
const handle = (payload: unknown, tenantId: string = world.tenantId) =>
  runInTenant(tenantId, () => handleCalendarSendInvitationReply(payload));

function payloadOf(invitation: { id: string; properties: Record<string, unknown> }, response = "accepted") {
  return { invitationId: invitation.id, response, respondedAt: invitation.properties.respondedAt };
}

/** What a sent message says: its envelope, headers, the plain-text part and the lines of its calendar part. */
async function readMessage(raw: Buffer) {
  const parsed = await simpleParser(raw);
  const calendar = parsed.attachments.find((attachment) => attachment.contentType === "text/calendar");
  if (!calendar) throw new Error("The message has no text/calendar part");
  return {
    from: parsed.from?.value.map((entry) => entry.address),
    to: parsed.to && !Array.isArray(parsed.to) ? parsed.to.value.map((entry) => entry.address) : [],
    subject: parsed.subject,
    text: parsed.text?.trim(),
    method: /^Content-Type: text\/calendar; method=(\w+)/im.exec(raw.toString("utf8"))?.[1],
    lines: calendar.content.toString("utf8").replace(/\r\n /g, "").split("\r\n"),
  };
}

/** The `PARTSTAT` of the one `ATTENDEE` line of a message's calendar part. */
function partstatOf(lines: string[]): string | undefined {
  return lines.find((line) => line.startsWith("ATTENDEE"))?.match(/PARTSTAT=([A-Z-]+)/)?.[1];
}

async function sentMessages() {
  return Promise.all(transport.sent.map((message) => readMessage(message.raw)));
}

/** The `reason` of each logged call of a spied logger method. */
function reasonsOf(spy: { mock: { calls: unknown[][] } }): unknown[] {
  return spy.mock.calls.map(([fields]) => z.object({ reason: z.string() }).parse(fields).reason);
}

describe("the reply to an answered invitation (issue gh-1953)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    mail = createInvitationMail(runtime);
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    transport = recordingTransport();
    setInvitationReplyDelivery({ pool: runtime, transports: transportFor(transport) });
    tenant = await mail.tenant(admin);
    world = tenant.world;
  });

  afterEach(() => {
    setInvitationReplyDelivery(null);
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });

  describe("queueing the reply with the answer", () => {
    it("queues one job for an accepted answer, keyed by the invitation and the moment of the answer", async () => {
      const id = await receiveInvitation();
      await respond(id, "accepted");

      const stored = await onlyInvitation();
      expect(stored.properties.status).toBe("accepted");
      const respondedAt = z.string().parse(stored.properties.respondedAt);
      expect((await queuedJobs()).map((job) => job.key)).toEqual([`invitation-reply:${id}:${respondedAt}`]);
      expect(await queuedPayloads()).toEqual([
        {
          tenantId: world.tenantId,
          payload: { invitationId: id, response: "accepted", respondedAt },
        },
      ]);
    });

    it.each(["tentative", "declined"])("queues a job carrying the answer for %s", async (response) => {
      const id = await receiveInvitation();
      await respond(id, response);

      expect((await queuedPayloads()).map((job) => job.payload.response)).toEqual([response]);
    });

    it("queues nothing for the notice of a shared calendar that is acknowledged", async () => {
      const notice = await runInTenant(world.tenantId, () =>
        createInvitation(runtime, { kind: "sharedCalendarNotice" }, null),
      );
      await respond(notice, "acknowledged");

      expect((await onlyInvitation()).properties.status).toBe("acknowledged");
      expect(await queuedJobs()).toEqual([]);
    });

    it("queues nothing for an answer equal to the stored one, which writes nothing", async () => {
      const id = await receiveInvitation();
      await respond(id, "accepted");
      const first = await onlyInvitation();

      await respond(id, "accepted");

      expect(await onlyInvitation()).toEqual(first);
      expect(await queuedJobs()).toHaveLength(1);
    });

    it("queues nothing for an answer that is refused", async () => {
      const id = await receiveInvitation();
      await expect(respond(id, "acknowledged")).rejects.toMatchObject({ details: { field: "response" } });

      expect(await queuedJobs()).toEqual([]);
    });

    it("queues nothing when the answering transaction fails after the job was queued, and keeps the invitation pending", async () => {
      const id = await receiveInvitation();
      // The ingest notified the user; resolving that notification is the last step of the answer, after the job was
      // queued. Raw DDL, because only a failing statement at that point shows that the job went away with the answer.
      await admin.query(`CREATE FUNCTION fail_notification_update() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'injected failure'; END $$`);
      await admin.query(
        "CREATE TRIGGER fail_notification_update BEFORE UPDATE ON notifications FOR EACH ROW EXECUTE FUNCTION fail_notification_update()",
      );
      try {
        await expect(respond(id, "accepted")).rejects.toThrow("injected failure");
      } finally {
        await admin.query("DROP TRIGGER fail_notification_update ON notifications");
        await admin.query("DROP FUNCTION fail_notification_update()");
      }

      expect((await onlyInvitation()).properties.status).toBe("pending");
      expect(await queuedJobs()).toEqual([]);
    });

    it("collapses a repeat of the same answer onto one job and keeps a changed answer as its own job", async () => {
      const id = await receiveInvitation();
      await respond(id, "accepted");
      const [queued] = await queuedPayloads();
      const input = z
        .object({ invitationId: z.string(), response: z.literal("accepted"), respondedAt: z.string() })
        .parse(queued?.payload);

      await runInTenant(world.tenantId, () =>
        withTransaction(runtime, (client) => enqueueInvitationReply(client, input)),
      );
      expect(await queuedJobs()).toHaveLength(1);

      await respond(id, "tentative");
      expect((await queuedJobs()).map((job) => job.key)).toHaveLength(2);
    });

    it.each([
      ["a moment that is not a timestamp", { respondedAt: "yesterday" }],
      ["an invitation id that is not a UUID", { invitationId: "invitation" }],
    ])("refuses %s before it queues anything", async (_label, override) => {
      const input = {
        invitationId: randomUUID(),
        response: "accepted" as const,
        respondedAt: new Date().toISOString(),
        ...override,
      };
      await expect(
        runInTenant(world.tenantId, () => withTransaction(runtime, (client) => enqueueInvitationReply(client, input))),
      ).rejects.toThrow();
      expect(await queuedJobs()).toEqual([]);
    });
  });

  describe("sending the reply", () => {
    it("sends one REPLY with PARTSTAT=ACCEPTED to the organizer from the mailbox that received the invitation, with the address it was delivered to as the attendee", async () => {
      const id = await receiveInvitation({ deliveredTo: ALIAS_ADDRESS });
      await respond(id, "accepted");

      await runQueued();

      expect(await queuedJobs()).toEqual([]);
      expect(transport.sent).toHaveLength(1);
      expect(transport.sent[0]?.envelope).toEqual({ from: MAILBOX_ADDRESS, recipients: [ORGANIZER_ADDRESS] });
      const [message] = await sentMessages();
      expect(message).toMatchObject({
        from: [MAILBOX_ADDRESS],
        to: [ORGANIZER_ADDRESS],
        subject: "Accepted: Sprint review",
        text: 'I have accepted the invitation "Sprint review".',
        method: "REPLY",
      });
      expect(message?.lines).toEqual(
        expect.arrayContaining([
          "METHOD:REPLY",
          "UID:sprint-review@example.test",
          "SEQUENCE:0",
          "DTSTART:20261022T110000Z",
          "DTEND:20261022T120000Z",
          "SUMMARY:Sprint review",
          `ORGANIZER:mailto:${ORGANIZER_ADDRESS}`,
          `ATTENDEE;PARTSTAT=ACCEPTED:mailto:${ALIAS_ADDRESS}`,
        ]),
      );
      expect(message?.lines.filter((line) => line.startsWith("ATTENDEE"))).toHaveLength(1);
      expect(message?.lines.some((line) => /^DTSTAMP:\d{8}T\d{6}Z$/.test(line))).toBe(true);
      // The answer stays as recorded.
      expect((await onlyInvitation()).properties.status).toBe("accepted");
    });

    it("takes the first address of the mailbox as the attendee when the message names no delivered-to address", async () => {
      const id = await receiveInvitation();
      // The mailbox keeps `PRIMARY` first and the address of the world's mailbox as an alias.
      await runInTenant(world.tenantId, () =>
        withTransaction(runtime, (client) =>
          writeMailboxAddresses(client, {
            mailboxesDatabaseId: world.databases.mailboxes!,
            mailboxItemId: world.inbox.mailboxId,
            address: "primary@example.test",
            aliases: [MAILBOX_ADDRESS],
          }),
        ),
      );
      await respond(id, "accepted");

      await runQueued();

      const [message] = await sentMessages();
      expect(message?.from).toEqual(["primary@example.test"]);
      expect(partstatOf(message?.lines ?? [])).toBe("ACCEPTED");
      expect(message?.lines).toContain("ATTENDEE;PARTSTAT=ACCEPTED:mailto:primary@example.test");
    });

    it("sends PARTSTAT=DECLINED for a declined answer", async () => {
      const id = await receiveInvitation({ deliveredTo: ALIAS_ADDRESS });
      await respond(id, "declined");

      await runQueued();

      const [message] = await sentMessages();
      expect(transport.sent).toHaveLength(1);
      expect(message?.subject).toBe("Declined: Sprint review");
      expect(partstatOf(message?.lines ?? [])).toBe("DECLINED");
    });

    it("sends PARTSTAT=TENTATIVE for a tentative answer", async () => {
      const id = await receiveInvitation({ deliveredTo: ALIAS_ADDRESS });
      await respond(id, "tentative");

      await runQueued();

      const [message] = await sentMessages();
      expect(message?.subject).toBe("Tentative: Sprint review");
      expect(partstatOf(message?.lines ?? [])).toBe("TENTATIVE");
    });

    it("sends the reply in the language of the tenant's user", async () => {
      await admin.query("UPDATE users SET locale = 'cs' WHERE tenant_id = $1", [world.tenantId]);
      const id = await receiveInvitation();
      await respond(id, "accepted");

      await runQueued();

      const [message] = await sentMessages();
      expect(message?.subject).toBe("Přijato: Sprint review");
      expect(message?.text).toBe("Pozvánku „Sprint review“ jsem přijal(a).");
    });

    it("sends a new reply with the new PARTSTAT when an accepted answer is changed to tentative", async () => {
      const id = await receiveInvitation({ deliveredTo: ALIAS_ADDRESS });
      await respond(id, "accepted");
      await runQueued();
      await respond(id, "tentative");
      expect(await queuedJobs()).toHaveLength(1);

      await runQueued();

      expect((await sentMessages()).map((message) => partstatOf(message.lines))).toEqual(["ACCEPTED", "TENTATIVE"]);
    });

    it("sends only the latest answer when the answer is changed again before the first reply job ran", async () => {
      const id = await receiveInvitation({ deliveredTo: ALIAS_ADDRESS });
      await respond(id, "accepted");
      await respond(id, "tentative");
      expect(await queuedJobs()).toHaveLength(2);
      const info = vi.spyOn(logger, "info").mockImplementation(() => {});

      await runQueued();

      expect(await queuedJobs()).toEqual([]);
      expect((await sentMessages()).map((message) => partstatOf(message.lines))).toEqual(["TENTATIVE"]);
      expect(reasonsOf(info)).toEqual(["superseded"]);
    });

    it("ends a job whose answer was superseded without sending, even when run on its own", async () => {
      const id = await receiveInvitation({ deliveredTo: ALIAS_ADDRESS });
      await respond(id, "accepted");
      const first = payloadOf(await onlyInvitation());
      await respond(id, "declined");
      const info = vi.spyOn(logger, "info").mockImplementation(() => {});

      await handle(first);

      expect(transport.sent).toEqual([]);
      expect(info).toHaveBeenCalledWith(
        { reason: "superseded", invitationId: id, response: "accepted" },
        expect.any(String),
      );
    });

    it("writes the DATE values of an all-day invitation", async () => {
      const id = await receiveInvitation({
        text: ics({ dtStart: "DTSTART;VALUE=DATE:20261029", dtEnd: "DTEND;VALUE=DATE:20261101" }),
      });
      await respond(id, "accepted");

      await runQueued();

      const [message] = await sentMessages();
      expect(message?.lines).toContain("DTSTART;VALUE=DATE:20261029");
      expect(message?.lines).toContain("DTEND;VALUE=DATE:20261101");
    });

    it("hands the factory the mailbox and its sync mode", async () => {
      const calls: Array<[string, string]> = [];
      setInvitationReplyDelivery({
        pool: runtime,
        transports: {
          async forMailbox(mailboxId, syncMode) {
            calls.push([mailboxId, syncMode]);
            return transport;
          },
        },
      });
      const id = await receiveInvitation();
      await respond(id, "accepted");

      await runQueued();

      // The mailbox of the world is a Gmail one, which sends through the Gmail API.
      expect(calls).toEqual([[world.inbox.mailboxId, "gmail_api"]]);
    });
  });

  describe("failures", () => {
    it("retries a transient transport failure and delivers one reply for the answer", async () => {
      const id = await receiveInvitation({ deliveredTo: ALIAS_ADDRESS });
      setInvitationReplyDelivery({
        pool: runtime,
        transports: transportFor({ send: () => Promise.reject(new Error("connection reset")) }),
      });
      await respond(id, "accepted");

      await runQueued();

      const [job] = await queuedJobs();
      expect(job).toMatchObject({ attempts: 1, runsLater: true });
      expect(job?.lastError).toContain("connection reset");
      expect(transport.sent).toEqual([]);
      expect((await onlyInvitation()).properties.status).toBe("accepted");

      // The queue runs the same job again once its backoff has passed; it finds a working transport and sends once.
      setInvitationReplyDelivery({ pool: runtime, transports: transportFor(transport) });
      await admin.query(
        `SELECT graphile_worker.reschedule_jobs(array_agg(id), run_at := now())
         FROM graphile_worker.jobs WHERE task_identifier = $1`,
        [TASK],
      );
      await runQueued();

      expect(transport.sent).toHaveLength(1);
      expect(await queuedJobs()).toEqual([]);
    });

    it("rethrows a failure of the transport factory that is neither a validation failure nor an unavailable transport", async () => {
      const id = await receiveInvitation();
      await respond(id, "accepted");
      setInvitationReplyDelivery({
        pool: runtime,
        transports: { forMailbox: () => Promise.reject(new Error("connection terminated")) },
      });

      await expect(handle(payloadOf(await onlyInvitation()))).rejects.toThrow("connection terminated");
    });

    it.each<[string, () => MailTransport | Error, string]>([
      ["a mailbox with no SMTP settings", () => new ValidationError("no smtp", { field: "smtp" }), "noTransport"],
      [
        "a transport the factory cannot build",
        () => new MailTransportUnavailableError("No Gmail OAuth client is configured"),
        "noTransport",
      ],
      [
        "an organizer the server refused",
        () => ({ send: () => Promise.reject(new MailRecipientRejectedError()) }),
        "recipientRejected",
      ],
    ])("ends with a reason code and no retry for %s", async (_label, make, reason) => {
      const id = await receiveInvitation();
      await respond(id, "accepted");
      const made = make();
      setInvitationReplyDelivery({
        pool: runtime,
        transports: made instanceof Error ? { forMailbox: () => Promise.reject(made) } : transportFor(made),
      });
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

      await runQueued();

      expect(await queuedJobs()).toEqual([]);
      expect(warn.mock.calls).toEqual([[{ reason, invitationId: id, response: "accepted" }, expect.any(String)]]);
      expect((await onlyInvitation()).properties.status).toBe("accepted");
    });

    it("ends with the noTransport reason for a Gmail mailbox in a root with no OAuth client", async () => {
      const id = await receiveInvitation();
      await respond(id, "accepted");
      setInvitationReplyDelivery({ pool: runtime, transports: createMailTransportFactory(runtime) });
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

      await runQueued();

      expect(await queuedJobs()).toEqual([]);
      expect(reasonsOf(warn)).toEqual(["noTransport"]);
    });

    it("ends without a retry when the invitation has no organizer address, and the answer stays recorded", async () => {
      const id = await receiveInvitation({ text: ics({ organizer: "X-NO-ORGANIZER:none" }) });
      expect((await onlyInvitation()).properties).not.toHaveProperty("organizerEmail");
      await respond(id, "accepted");
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

      await runQueued();

      expect(await queuedJobs()).toEqual([]);
      expect(transport.sent).toEqual([]);
      expect(reasonsOf(warn)).toEqual(["noOrganizerAddress"]);
      expect((await onlyInvitation()).properties.status).toBe("accepted");
    });

    it("ends without a retry when the mailbox is trashed, and the answer stays recorded", async () => {
      const id = await receiveInvitation();
      await respond(id, "accepted");
      await runInTenant(world.tenantId, () =>
        world.cp.softDeleteItem(world.databases.mailboxes!, world.inbox.mailboxId, undefined, SYSTEM_WRITER),
      );
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

      await runQueued();

      expect(await queuedJobs()).toEqual([]);
      expect(transport.sent).toEqual([]);
      expect(reasonsOf(warn)).toEqual(["mailboxMissing"]);
      expect((await onlyInvitation()).properties.status).toBe("accepted");
    });

    it("ends without sending when the invitation has no mailbox edge", async () => {
      // A state the ingest does not produce for a message of a mailbox: an invitation written without its edge.
      const id = await runInTenant(world.tenantId, () =>
        createInvitation(
          runtime,
          { organizerEmail: ORGANIZER_ADDRESS, status: "accepted", respondedAt: "2026-10-20T08:00:00.000Z" },
          null,
        ),
      );
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

      await handle({ invitationId: id, response: "accepted", respondedAt: "2026-10-20T08:00:00.000Z" });

      expect(transport.sent).toEqual([]);
      expect(reasonsOf(warn)).toEqual(["mailboxMissing"]);
    });

    it("ends without sending when the mailbox has no address", async () => {
      const id = await receiveInvitation();
      await respond(id, "accepted");
      // A state the API cannot produce: a mailbox whose addresses were never written.
      await admin.query("UPDATE items SET properties = properties - 'addresses' WHERE id = $1", [
        world.inbox.mailboxId,
      ]);
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

      await handle(payloadOf(await onlyInvitation()));

      expect(transport.sent).toEqual([]);
      expect(reasonsOf(warn)).toEqual(["noMailboxAddress"]);
    });

    it("ends without sending a message the builders refuse", async () => {
      const id = await receiveInvitation();
      await respond(id, "accepted");
      // A value the ingest does not store: it keeps only addresses of the parsed ORGANIZER line.
      await admin.query(
        `UPDATE items SET properties = jsonb_set(properties, '{organizerEmail}', '"not-an-address"') WHERE id = $1`,
        [id],
      );
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

      await handle(payloadOf(await onlyInvitation()));

      expect(transport.sent).toEqual([]);
      expect(reasonsOf(warn)).toEqual(["invalidMessage"]);
    });

    it("ends without sending for an invitation that is unknown, trashed or unreadable", async () => {
      const unreadable = await runInTenant(world.tenantId, () =>
        createInvitation(
          runtime,
          { uid: undefined, status: "accepted", respondedAt: "2026-10-20T08:00:00.000Z" },
          null,
        ),
      );
      const trashed = await runInTenant(world.tenantId, () =>
        createInvitation(runtime, { uid: "gone@example.test", respondedAt: "2026-10-20T08:00:00.000Z" }, null),
      );
      await runInTenant(world.tenantId, () =>
        world.cp.softDeleteItem(world.databases.invitations!, trashed, undefined, SYSTEM_WRITER),
      );
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
      const respondedAt = "2026-10-20T08:00:00.000Z";

      await handle({ invitationId: randomUUID(), response: "accepted", respondedAt });
      await handle({ invitationId: trashed, response: "accepted", respondedAt });
      await handle({ invitationId: unreadable, response: "accepted", respondedAt });

      expect(transport.sent).toEqual([]);
      expect(reasonsOf(warn)).toEqual(["invitationMissing", "invitationMissing", "invitationUnreadable"]);
    });

    it("answers another tenant's invitation like an unknown one: nothing is sent", async () => {
      const id = await receiveInvitation({ deliveredTo: ALIAS_ADDRESS });
      await respond(id, "accepted");
      const foreign = await mail.tenant(admin);
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

      await handle(payloadOf(await onlyInvitation()), foreign.world.tenantId);

      expect(transport.sent).toEqual([]);
      expect(reasonsOf(warn)).toEqual(["invitationMissing"]);
    });

    it("refuses to run without bound dependencies, so the queue retries the job", async () => {
      const id = await receiveInvitation();
      await respond(id, "accepted");
      setInvitationReplyDelivery(null);

      await expect(handle(payloadOf(await onlyInvitation()))).rejects.toThrow(
        "No invitation reply delivery is configured for this composition root",
      );
    });

    it("refuses a payload the task does not declare", async () => {
      const id = await receiveInvitation();
      await respond(id, "accepted");
      const payload = payloadOf(await onlyInvitation());

      await expect(handle({ ...payload, extra: true })).rejects.toThrow();
      await expect(handle({ ...payload, response: "acknowledged" })).rejects.toThrow();
      await expect(handle({ ...payload, respondedAt: "yesterday" })).rejects.toThrow();
      expect(transport.sent).toEqual([]);
    });

    it("keeps the title, the addresses and the delivered-to address out of the log", async () => {
      const id = await receiveInvitation({ text: ics({ summary: "CONFIDENTIAL-MARKER" }), deliveredTo: ALIAS_ADDRESS });
      await respond(id, "accepted");
      await respond(id, "declined");
      const info = vi.spyOn(logger, "info").mockImplementation(() => {});
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

      await runQueued();

      const logged = JSON.stringify([...info.mock.calls, ...warn.mock.calls]);
      expect(logged).toContain("superseded");
      for (const secret of ["CONFIDENTIAL-MARKER", ORGANIZER_ADDRESS, ALIAS_ADDRESS, MAILBOX_ADDRESS]) {
        expect(logged).not.toContain(secret);
      }
    });
  });
});
