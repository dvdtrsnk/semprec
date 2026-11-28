import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { inflateRawSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { runInTenant } from "@alldots/shared";
import { CORE_TASK_NAMES } from "@alldots/queue";
import { readJobPayloadsByIdentifier } from "@alldots/queue/testSupport";
import "../domainWriteHooks.js";
import { createUser } from "../auth/usersStore.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { createItemWithClient, updateItemWithClient } from "../chokePoint/itemWrites.js";
import { getDecryptedCredential, storeCredential } from "../credentials/externalCredentialsStore.js";
import { logger as dbLogger } from "../db/logger.js";
import { withTransaction } from "../db/pool.js";
import { ChokePointError, RateLimitedError, ValidationError } from "../errors.js";
import type { BlobStorageWriter } from "../mail/blobStorage.js";
import { logger as mailLogger } from "../mail/logger.js";
import {
  ensureMailAccountSyncState,
  getMailAccountSyncState,
  getProviderAccountAddress,
  ProviderAccountAlreadyConnectedError,
  recordProviderAccountAddress,
  recordSyncError,
} from "../mail/mailAccountSyncStateStore.js";
import { writeMailboxAddresses } from "../mail/mailboxAddresses.js";
import {
  createMailboxPasswordConnectRouteHandler,
  createMailboxPasswordReplaceRouteHandler,
  type MailboxPasswordRouteDependencies,
} from "../mail/mailboxPasswordRouteHandlers.js";
import {
  verifyMailCredentials,
  type VerifiedMailServerSettings,
  type VerifyMailCredentialsInput,
} from "../mail/mailCredentialVerification.js";
import { resolveMailModuleIds } from "../mail/mailModuleIds.js";
import { removeMailbox } from "../mail/mailboxRemoval.js";
import { createActionQueueAffinity } from "../scheduler/actions.js";
import * as connections from "../mail/mailServerConnections.js";
import { getMailServerSettings, upsertMailServerSettings } from "../mail/mailServerSettingsStore.js";
import * as mailSyncEnqueue from "../mail/mailSyncEnqueue.js";
import {
  MailAppPasswordRequiredError,
  MailAuthFailedError,
  MailServerUnreachableError,
  MailTlsFailedError,
} from "../mail/providerTypes.js";
import type { VerifyCalDavServerInput } from "../calendar/sync/adapters/caldav/caldavConnectVerification.js";
import {
  CalDavAuthFailedError,
  CalDavServerInvalidError,
  CalDavServerUnreachableError,
} from "../calendar/sync/adapters/caldav/caldavErrors.js";
import { getCalendarAccountSyncState, recordCalendarSyncFailure } from "../calendar/sync/calendarSyncStore.js";
import { seedSystem } from "../seed/seedSystem.js";
import { PURELYMAIL_FOLDERS } from "../testSupport/imapMailboxFixture.js";
import { provisionTenant } from "../tenancy/provisionTenant.js";
import { handleTenantExportTask } from "../tenancy/tenantExportJob.js";
import { requestTenantExport } from "../tenancy/tenantExportsStore.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";
import type { ItemRow } from "../types.js";

/** Unique per run, so a hit in a response, a log call or the export can only be this password. */
const PASSWORD = `pw-sentinel-${randomUUID()}`;
const ADDRESS = "owner@example.test";
const IMAP_HOST = "imap.example.test";
const SMTP_HOST = "smtp.example.test";
const CALDAV_URL = "https://caldav.example.test/dav/";

const ICLOUD_BODY = { provider: "icloud", address: ADDRESS, password: PASSWORD };
const GENERIC_BODY = {
  provider: "generic",
  address: ADDRESS,
  password: PASSWORD,
  imapHost: IMAP_HOST,
  smtpHost: SMTP_HOST,
};

/** The endpoints `verifyMailCredentials` fixes for iCloud, as they are stored. */
const ICLOUD_ENDPOINTS = {
  imap: { host: "imap.mail.me.com", port: 993, security: "tls" },
  smtp: { host: "smtp.mail.me.com", port: 587, security: "starttls" },
} as const;

const ICLOUD_SETTINGS: VerifiedMailServerSettings = { ...ICLOUD_ENDPOINTS, folders: null };

/** What the verification lists on a Purelymail account's verified IMAP connection. */
const LISTED_FOLDERS = PURELYMAIL_FOLDERS.map((folder) => ({ path: folder.path, specialUse: folder.specialUse }));

let admin: Pool;
let runtime: Pool;
let tenant: string;
let userId: string;

function inTenant<T>(fn: (client: PoolClient) => Promise<T>, tenantId = tenant): Promise<T> {
  return runInTenant(tenantId, () => withTransaction(runtime, fn));
}

/**
 * The member as `serve.ts` sets it (the real `verifyMailCredentials`); a case mounting it stubs the
 * per-endpoint connection attempts.
 */
const PRODUCTION_VERIFICATION: MailboxPasswordRouteDependencies = {
  mailServerClients: { verifyPassword: verifyMailCredentials },
};

interface AcceptingVerifier {
  dependencies: MailboxPasswordRouteDependencies;
  calls: VerifyMailCredentialsInput[];
  calDavCalls: VerifyCalDavServerInput[];
}

/** `delegatedServerUrl` is where the CalDAV verification reports a well-known address delegated the account. */
function acceptingVerifier(delegatedServerUrl: string | null = null): AcceptingVerifier {
  const calls: VerifyMailCredentialsInput[] = [];
  const calDavCalls: VerifyCalDavServerInput[] = [];
  return {
    calls,
    calDavCalls,
    dependencies: {
      mailServerClients: {
        verifyCalDav: async (input) => {
          calDavCalls.push(input);
          return { delegatedServerUrl };
        },
        verifyPassword: async (input) => {
          calls.push(input);
          const folders = input.listFolders === true ? LISTED_FOLDERS : null;
          if (input.imapHost === undefined || input.smtpHost === undefined) return { ...ICLOUD_SETTINGS, folders };
          return {
            imap: { host: input.imapHost, port: 993, security: "tls" },
            smtp: { host: input.smtpHost, port: 465, security: "tls" },
            folders,
          };
        },
      },
    },
  };
}

/**
 * A mail and a CalDAV verification that each wait up to a second for the other to have started, so a route running
 * them one after the other fails with `not concurrent`. Once both run, the mail verification settles first and the
 * CalDAV one 50 ms later, each with its refusal when one is given; `settled` records the order.
 */
function overlappingVerifier(refusals: { mail?: Error; calDav?: Error } = {}) {
  const settled: Array<"mail" | "calDav"> = [];
  let mailStarted = () => {};
  let calDavStarted = () => {};
  const mailRunning = new Promise<void>((resolve) => (mailStarted = resolve));
  const calDavRunning = new Promise<void>((resolve) => (calDavStarted = resolve));
  const afterStart = async (other: Promise<void>) => {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        other,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("not concurrent")), 1_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const dependencies: MailboxPasswordRouteDependencies = {
    mailServerClients: {
      verifyPassword: async (input) => {
        mailStarted();
        try {
          await afterStart(calDavRunning);
          if (refusals.mail) throw refusals.mail;
          if (input.imapHost === undefined || input.smtpHost === undefined) return ICLOUD_SETTINGS;
          return {
            imap: { host: input.imapHost, port: 993, security: "tls" },
            smtp: { host: input.smtpHost, port: 465, security: "tls" },
            folders: null,
          };
        } finally {
          settled.push("mail");
        }
      },
      verifyCalDav: async () => {
        calDavStarted();
        try {
          await afterStart(mailRunning);
          await new Promise((resolve) => setTimeout(resolve, 50));
          if (refusals.calDav) throw refusals.calDav;
          return { delegatedServerUrl: null };
        } finally {
          settled.push("calDav");
        }
      },
    },
  };
  return { dependencies, settled };
}

type Throttle = NonNullable<MailboxPasswordRouteDependencies["throttle"]>;

interface RecordingThrottle {
  throttle: Throttle;
  attempts: Array<[string, string]>;
  releases: () => number;
}

/**
 * A limiter answering like `alldots-api`'s `ClientIpThrottle`: it grants every attempt with a
 * reservation, or refuses every one with `refuseWithSeconds`. `onAttempt` runs when the route asks.
 */
function recordingThrottle(options: { refuseWithSeconds?: number; onAttempt?: () => void } = {}): RecordingThrottle {
  const attempts: Array<[string, string]> = [];
  let releases = 0;
  const reservation = {
    release: () => {
      releases += 1;
    },
  };
  const { refuseWithSeconds } = options;
  return {
    attempts,
    releases: () => releases,
    throttle: {
      tryAcquire(action: "mailboxCredentialVerification", user: string) {
        attempts.push([action, user]);
        options.onAttempt?.();
        return refuseWithSeconds === undefined
          ? { granted: true as const, reservation }
          : { granted: false as const, retryAfterSeconds: refuseWithSeconds };
      },
    },
  };
}

interface ConnectOptions {
  dependencies?: MailboxPasswordRouteDependencies;
  throttle?: Throttle | null;
  tenantId?: string;
}

function connect(body: unknown, options: ConnectOptions = {}): Promise<{ status: number; item: ItemRow }> {
  const dependencies = options.dependencies ?? acceptingVerifier().dependencies;
  const handler = createMailboxPasswordConnectRouteHandler(runtime, {
    ...dependencies,
    throttle: options.throttle === undefined ? recordingThrottle().throttle : (options.throttle ?? undefined),
  });
  return runInTenant(options.tenantId ?? tenant, () => handler({ identity: { user: { id: userId } }, body }));
}

async function rejectionOf(work: Promise<unknown>): Promise<unknown> {
  const settled = await work.then(
    () => ({ rejected: false as const }),
    (error: unknown) => ({ rejected: true as const, error }),
  );
  if (!settled.rejected) throw new Error("expected the request to be refused");
  return settled.error;
}

const syncJobEnvelope = z.object({ tenantId: z.string(), payload: z.object({ mailboxItemId: z.string() }) });

async function queuedSyncJobs(tenantId = tenant): Promise<string[]> {
  const payloads = await readJobPayloadsByIdentifier(admin, CORE_TASK_NAMES.MAIL_ACCOUNT_SYNC);
  return payloads
    .map((payload) => syncJobEnvelope.parse(payload))
    .filter((job) => job.tenantId === tenantId)
    .map((job) => job.payload.mailboxItemId)
    .sort();
}

interface MailboxRows {
  items: string[];
  credentials: string[];
  settings: string[];
  syncStates: string[];
  jobs: string[];
}

const NOTHING: MailboxRows = { items: [], credentials: [], settings: [], syncStates: [], jobs: [] };

function oneWholeMailbox(id: string | undefined): Record<keyof MailboxRows, Array<string | undefined>> {
  return { items: [id], credentials: [id], settings: [id], syncStates: [id], jobs: [id] };
}

async function mailboxRows(tenantId = tenant): Promise<MailboxRows> {
  const rows = await inTenant(async (client) => {
    const { mailboxesDatabaseId } = await resolveMailModuleIds(client);
    const ids = async (sql: string, values: unknown[] = []): Promise<string[]> =>
      (await client.query<{ id: string }>(sql, values)).rows.map((row) => row.id);
    return {
      items: await ids("SELECT id FROM items WHERE database_id = $1 ORDER BY id", [mailboxesDatabaseId]),
      credentials: await ids("SELECT item_id AS id FROM external_credentials ORDER BY item_id"),
      settings: await ids("SELECT mailbox_item_id AS id FROM mail_account_server_settings ORDER BY mailbox_item_id"),
      syncStates: await ids("SELECT item_id AS id FROM mail_account_sync_state ORDER BY item_id"),
    };
  }, tenantId);
  return { ...rows, jobs: await queuedSyncJobs(tenantId) };
}

async function storedMailbox(mailboxId: string, tenantId = tenant) {
  return inTenant(async (client) => {
    const credentialTypes = await client.query<{ credential_type: string }>(
      "SELECT credential_type FROM external_credentials WHERE item_id = $1",
      [mailboxId],
    );
    return {
      settings: await getMailServerSettings(client, mailboxId),
      syncMode: (await getMailAccountSyncState(client, mailboxId))?.syncMode,
      providerAccountAddress: await getProviderAccountAddress(client, mailboxId),
      credentialTypes: credentialTypes.rows.map((row) => row.credential_type),
      password: await getDecryptedCredential(client, { itemId: mailboxId, actorType: "user", purpose: "test_read" }),
    };
  }, tenantId);
}

async function existingMailbox(
  fill: (client: PoolClient, mailbox: { databaseId: string; id: string }) => Promise<void>,
  tenantId = tenant,
): Promise<string> {
  return inTenant(async (client) => {
    const { mailboxesDatabaseId } = await resolveMailModuleIds(client);
    const item = await createItemWithClient(client, {
      databaseId: mailboxesDatabaseId,
      properties: { name: "Existing", provider: "gmail" },
    });
    await fill(client, { databaseId: mailboxesDatabaseId, id: item.id });
    return item.id;
  }, tenantId);
}

async function removeConnectedMailbox(mailboxId: string, tenantId = tenant): Promise<void> {
  const removed = await runInTenant(tenantId, () =>
    removeMailbox(runtime, mailboxId, { queueAffinity: createActionQueueAffinity() }),
  );
  if (!removed) throw new Error(`mailbox ${mailboxId} was not removed`);
}

function recordingProviderAddress(address: string) {
  return async (client: PoolClient, mailbox: { id: string }): Promise<void> => {
    await ensureMailAccountSyncState(client, { itemId: mailbox.id, syncMode: "gmail_api" });
    await recordProviderAccountAddress(client, mailbox.id, address);
  };
}

function listingAlias(alias: string) {
  return (client: PoolClient, mailbox: { databaseId: string; id: string }): Promise<void> =>
    writeMailboxAddresses(client, {
      mailboxesDatabaseId: mailbox.databaseId,
      mailboxItemId: mailbox.id,
      address: "primary@example.test",
      aliases: [alias],
    });
}

async function seedTenantZero(): Promise<void> {
  await resetDatabase(admin);
  tenant = getTenantZeroId();
  await runInTenant(tenant, () => seedSystem(admin));
  const user = await createUser(admin, {
    email: `${randomUUID()}@example.test`,
    passwordHash: `hash-${randomUUID()}`,
    tenantId: tenant,
  });
  userId = user.id;
}

async function secondTenant(): Promise<string> {
  const other = await createTestTenant(admin, { status: "provisioning" });
  await provisionTenant(runtime, other);
  return other;
}

const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;

/**
 * Records every call to the mail and database loggers, whatever the level, and silences them. Returns
 * the calls' arguments, serialized with every logged error's message and stack.
 */
function recordLogCalls(): () => string {
  const calls: unknown[][] = [];
  for (const logger of [mailLogger, dbLogger]) {
    for (const level of LOG_LEVELS) {
      vi.spyOn(logger, level).mockImplementation((...args: unknown[]) => {
        calls.push(args);
      });
    }
  }
  return () =>
    JSON.stringify(calls, (_key, value: unknown) =>
      value instanceof Error ? { ...value, name: value.name, message: value.message, stack: value.stack } : value,
    );
}

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return JSON.stringify(error);
  return `${error.name} ${error.message} ${error.stack ?? ""} ${JSON.stringify(error)} ${JSON.stringify(Object.getOwnPropertyDescriptors(error))}`;
}

function gate(): { opened: Promise<void>; open: () => void } {
  let release: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { opened, open: () => release() };
}

function withinTenSeconds<T>(work: Promise<T>, what: string): Promise<T> {
  const timeout = new Promise<never>((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} did not happen within 10 s`)), 10_000);
    void work.then(
      () => clearTimeout(timer),
      () => clearTimeout(timer),
    );
  });
  return Promise.race([work, timeout]);
}

async function waitForLockWaiter(): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const { rows } = await admin.query<{ waiting: number }>(
      "SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
    );
    if ((rows[0]?.waiting ?? 0) > 0) return;
    await sleep(25);
  }
  throw new Error("no backend waited for a lock within 10 s");
}

/**
 * Reads every ZIP entry through the central directory, which carries each entry's sizes even when the
 * local header defers them to a data descriptor (as yazl writes them).
 */
function readZip(archive: Buffer): Map<string, Buffer> {
  const eocd = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("no end-of-central-directory record");
  const entryCount = archive.readUInt16LE(eocd + 10);
  let offset = archive.readUInt32LE(eocd + 16);
  const entries = new Map<string, Buffer>();
  for (let i = 0; i < entryCount; i += 1) {
    if (archive.readUInt32LE(offset) !== 0x02014b50) throw new Error("bad central directory entry");
    const method = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    const name = archive.toString("utf8", offset + 46, offset + 46 + nameLength);
    const dataStart =
      localOffset + 30 + archive.readUInt16LE(localOffset + 26) + archive.readUInt16LE(localOffset + 28);
    const raw = archive.subarray(dataStart, dataStart + compressedSize);
    entries.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function capturingStorage(): { storage: BlobStorageWriter; written: Buffer[] } {
  const written: Buffer[] = [];
  return {
    written,
    storage: {
      async writeStream(_storageKey: string, source: Readable) {
        const chunks: Buffer[] = [];
        for await (const chunk of source) {
          const value: unknown = chunk;
          if (!Buffer.isBuffer(value)) throw new Error("the export stream yielded a chunk that is not a Buffer");
          chunks.push(value);
        }
        const bytes = Buffer.concat(chunks);
        written.push(bytes);
        return { byteSize: bytes.byteLength, contentHash: randomUUID() };
      },
      async delete() {},
      readStream() {
        throw new Error("readStream is not used by this test");
      },
    },
  };
}

describe("POST /api/mail/mailboxes: connect a mailbox with a password (issue gh-1736)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "alldots_data");
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("request validation", () => {
    // No case of this block writes a row, so the cases share one seeded tenant.
    beforeAll(seedTenantZero);

    const LONG_LOCAL_PART = "a".repeat(310);

    it.each<[string, unknown, string | undefined]>([
      ["null", null, undefined],
      ["an array", [GENERIC_BODY], undefined],
      ["a string", "generic", undefined],
      ["a key the route does not know", { ...GENERIC_BODY, imapPort: 143 }, undefined],
      ["an unknown provider", { ...GENERIC_BODY, provider: "gmail" }, "provider"],
      ["no provider", { address: ADDRESS, password: PASSWORD }, "provider"],
      ["no address", { provider: "icloud", password: PASSWORD }, "address"],
      ["an address that is not a string", { ...ICLOUD_BODY, address: 5 }, "address"],
      ["an address without a domain", { ...ICLOUD_BODY, address: "owner" }, "address"],
      ["an address with whitespace inside", { ...ICLOUD_BODY, address: "ow ner@example.test" }, "address"],
      ["an address with a comma inside", { ...ICLOUD_BODY, address: "ow,ner@example.test" }, "address"],
      ["two addresses", { ...ICLOUD_BODY, address: "owner@example.test,second@example.test" }, "address"],
      ["an address above 320 characters", { ...ICLOUD_BODY, address: `${LONG_LOCAL_PART}@example.test` }, "address"],
      // Postgres stores no NUL in `text` or `jsonb` and no unpaired surrogate in `jsonb`: neither may reach a statement.
      ["an address with a NUL character", { ...ICLOUD_BODY, address: "ow\u0000ner@example.test" }, "address"],
      ["an address with a control character", { ...ICLOUD_BODY, address: "ow\u007fner@example.test" }, "address"],
      ["an address with an unpaired surrogate", { ...ICLOUD_BODY, address: "ow\ud800ner@example.test" }, "address"],
      ["no password", { provider: "icloud", address: ADDRESS }, "password"],
      ["an empty password", { ...ICLOUD_BODY, password: "" }, "password"],
      ["a password above 1024 characters", { ...ICLOUD_BODY, password: `${PASSWORD}${"x".repeat(1024)}` }, "password"],
      ["a blank user name", { ...ICLOUD_BODY, username: "   " }, "username"],
      ["a user name above 320 characters", { ...ICLOUD_BODY, username: "u".repeat(321) }, "username"],
      ["a user name that is not a string", { ...ICLOUD_BODY, username: 5 }, "username"],
      ["a user name with a NUL character", { ...GENERIC_BODY, username: "login\u0000name" }, "username"],
      ["a user name with a line break", { ...GENERIC_BODY, username: "login\r\nname" }, "username"],
      ["a user name with an unpaired surrogate", { ...GENERIC_BODY, username: "login\udc00name" }, "username"],
      ["an IMAP host for iCloud", { ...ICLOUD_BODY, imapHost: IMAP_HOST }, "imapHost"],
      ["an SMTP host for iCloud", { ...ICLOUD_BODY, smtpHost: SMTP_HOST }, "smtpHost"],
      ["no IMAP host for a generic mailbox", { ...GENERIC_BODY, imapHost: undefined }, "imapHost"],
      ["no SMTP host for a generic mailbox", { ...GENERIC_BODY, smtpHost: undefined }, "smtpHost"],
      ["an IMAP host that is not a string", { ...GENERIC_BODY, imapHost: 5 }, "imapHost"],
      ["an IP address as IMAP host", { ...GENERIC_BODY, imapHost: "10.0.0.1" }, "imapHost"],
      ["a local name as SMTP host", { ...GENERIC_BODY, smtpHost: "localhost" }, "smtpHost"],
      ["an IMAP host with a NUL character", { ...GENERIC_BODY, imapHost: "imap\u0000.example.test" }, "imapHost"],
      ["an SMTP host with an unpaired surrogate", { ...GENERIC_BODY, smtpHost: "smtp\ud800.example.test" }, "smtpHost"],
      ["a CalDAV address for iCloud", { ...ICLOUD_BODY, caldavUrl: CALDAV_URL }, "caldavUrl"],
      ["a CalDAV address that is not a string", { ...GENERIC_BODY, caldavUrl: 5 }, "caldavUrl"],
      ["a plain http CalDAV address", { ...GENERIC_BODY, caldavUrl: "http://caldav.example.test/" }, "caldavUrl"],
      ["a CalDAV address on an IP address", { ...GENERIC_BODY, caldavUrl: "https://10.0.0.1/dav/" }, "caldavUrl"],
      ["a CalDAV address on a local name", { ...GENERIC_BODY, caldavUrl: "https://cal.local/dav/" }, "caldavUrl"],
    ])("refuses %s with validation_failed before any server is contacted", async (_name, body, field) => {
      const verifier = acceptingVerifier();

      const error = await rejectionOf(connect(body, { dependencies: verifier.dependencies }));

      expect(error).toBeInstanceOf(ValidationError);
      if (!(error instanceof ValidationError)) throw new Error("expected a ValidationError");
      expect(error.details).toEqual(field === undefined ? undefined : { field });
      expect(errorText(error)).not.toContain(PASSWORD);
      expect(verifier.calls).toEqual([]);
      expect(verifier.calDavCalls).toEqual([]);
      expect(await mailboxRows()).toEqual(NOTHING);
    });
  });

  describe("verification and writes", () => {
    beforeEach(seedTenantZero);

    it("names a second iCloud mailbox after its address, so the two are told apart", async () => {
      const verifier = acceptingVerifier();
      await connect(ICLOUD_BODY, { dependencies: verifier.dependencies });

      const second = await connect(
        { ...ICLOUD_BODY, address: "second@example.test" },
        { dependencies: verifier.dependencies },
      );

      expect(second.status).toBe(201);
      expect(second.item.properties).toMatchObject({ name: "second@example.test", provider: "icloud" });
    });

    it("creates an iCloud mailbox with its app password, the fixed iCloud settings, an IMAP sync state and a queued sync", async () => {
      const verifier = acceptingVerifier();

      const answer = await connect(
        { ...ICLOUD_BODY, address: "  Owner@Example.test " },
        { dependencies: verifier.dependencies },
      );

      expect(answer.status).toBe(201);
      expect(answer.item.deletedAt).toBeNull();
      expect(answer.item.properties).toMatchObject({ name: "iCloud", provider: "icloud", addresses: ADDRESS });
      expect(JSON.stringify(answer)).not.toContain(PASSWORD);
      // The user name defaults to the address as it was typed, and iCloud gets no host from the request.
      expect(verifier.calls).toEqual([
        {
          provider: "icloud",
          address: "Owner@Example.test",
          username: "Owner@Example.test",
          password: PASSWORD,
          listFolders: true,
        },
      ]);
      const id = answer.item.id;
      expect(await mailboxRows()).toEqual(oneWholeMailbox(id));
      expect(await storedMailbox(id)).toEqual({
        settings: { mailboxItemId: id, ...ICLOUD_ENDPOINTS, username: "Owner@Example.test", caldavUrl: null },
        syncMode: "imap",
        providerAccountAddress: ADDRESS,
        credentialTypes: ["app_password"],
        password: PASSWORD,
      });
    });

    it("creates a generic mailbox with a plain password, the verified endpoints and the user name of the request", async () => {
      const verifier = acceptingVerifier();

      const answer = await connect(
        { ...GENERIC_BODY, imapHost: " IMAP.Example.test. ", username: "login-name" },
        { dependencies: verifier.dependencies },
      );

      expect(answer.status).toBe(201);
      expect(answer.item.properties).toMatchObject({ name: "example.test", provider: "generic", addresses: ADDRESS });
      expect(verifier.calls).toEqual([
        {
          provider: "generic",
          address: ADDRESS,
          username: "login-name",
          password: PASSWORD,
          imapHost: IMAP_HOST,
          smtpHost: SMTP_HOST,
          listFolders: true,
        },
      ]);
      expect(await storedMailbox(answer.item.id)).toEqual({
        settings: {
          mailboxItemId: answer.item.id,
          imap: { host: IMAP_HOST, port: 993, security: "tls" },
          smtp: { host: SMTP_HOST, port: 465, security: "tls" },
          username: "login-name",
          caldavUrl: null,
        },
        syncMode: "imap",
        providerAccountAddress: ADDRESS,
        credentialTypes: ["plain_password"],
        password: PASSWORD,
      });
    });

    it("verifies a generic account's CalDAV address with its login and stores the address", async () => {
      const verifier = acceptingVerifier();

      const answer = await connect(
        { ...GENERIC_BODY, username: "login-name", caldavUrl: " https://CalDAV.Example.test/dav/ " },
        { dependencies: verifier.dependencies },
      );

      expect(answer.status).toBe(201);
      expect(verifier.calls).toHaveLength(1);
      expect(verifier.calDavCalls).toEqual([
        { caldavUrl: CALDAV_URL, username: "login-name", password: PASSWORD, resolveServer: true },
      ]);
      expect((await storedMailbox(answer.item.id)).settings?.caldavUrl).toBe(CALDAV_URL);
    });

    it("stores the server a well-known CalDAV address delegated the account to as its CalDAV address", async () => {
      const delegated = "https://caldav.provider.test/dav/";
      const verifier = acceptingVerifier(delegated);

      const answer = await connect(
        { ...GENERIC_BODY, caldavUrl: "https://example.test/.well-known/caldav" },
        { dependencies: verifier.dependencies },
      );

      expect(answer.status).toBe(201);
      expect(verifier.calDavCalls).toMatchObject([
        { caldavUrl: "https://example.test/.well-known/caldav", resolveServer: true },
      ]);
      expect((await storedMailbox(answer.item.id)).settings?.caldavUrl).toBe(delegated);
    });

    it("does not contact a CalDAV server for a body without a CalDAV address", async () => {
      const verifier = acceptingVerifier();

      const answer = await connect(GENERIC_BODY, { dependencies: verifier.dependencies });

      expect(verifier.calDavCalls).toEqual([]);
      expect((await storedMailbox(answer.item.id)).settings?.caldavUrl).toBeNull();
    });

    it.each([
      ["caldav_auth_failed", new CalDavAuthFailedError()],
      ["caldav_server_unreachable", new CalDavServerUnreachableError()],
      ["caldav_server_invalid", new CalDavServerInvalidError()],
    ])("answers a CalDAV verification's %s refusal with 400 and stores nothing", async (code, refusal) => {
      const verifier = acceptingVerifier();
      const logged = recordLogCalls();

      const error = await rejectionOf(
        connect(
          { ...GENERIC_BODY, caldavUrl: CALDAV_URL },
          {
            dependencies: {
              mailServerClients: {
                ...verifier.dependencies.mailServerClients,
                verifyCalDav: () => Promise.reject(refusal),
              },
            },
          },
        ),
      );

      expect(error).toBeInstanceOf(ChokePointError);
      if (!(error instanceof ChokePointError)) throw new Error("expected a ChokePointError");
      expect({ status: error.status, code: error.code, message: error.message }).toEqual({
        status: 400,
        code,
        message: refusal.message,
      });
      expect(errorText(error)).not.toContain(PASSWORD);
      expect(logged()).not.toContain(PASSWORD);
      expect(await mailboxRows()).toEqual(NOTHING);
    });

    it("verifies the mail login and the CalDAV address concurrently", async () => {
      const verifier = overlappingVerifier();

      const answer = await connect({ ...GENERIC_BODY, caldavUrl: CALDAV_URL }, { dependencies: verifier.dependencies });

      expect(answer.status).toBe(201);
      expect(verifier.settled).toEqual(["mail", "calDav"]);
    });

    it("answers the mail refusal before a CalDAV refusal once both settled, and logs the other without the password", async () => {
      const verifier = overlappingVerifier({ mail: new MailAuthFailedError(), calDav: new CalDavAuthFailedError() });
      const logged = recordLogCalls();

      const error = await rejectionOf(
        connect({ ...GENERIC_BODY, caldavUrl: CALDAV_URL }, { dependencies: verifier.dependencies }),
      );

      expect(error).toBeInstanceOf(ChokePointError);
      expect(error).toMatchObject({ status: 400, code: "mail_auth_failed" });
      // The CalDAV verification settled after the mail refusal, and the route still waited for it.
      expect(verifier.settled).toEqual(["mail", "calDav"]);
      expect(logged()).toContain("A login verification failed behind the failure the request reports");
      expect(logged()).toContain("CalDavAuthFailedError");
      expect(logged()).not.toContain(PASSWORD);
      expect(await mailboxRows()).toEqual(NOTHING);
    });

    it("stores an address and a user name with a character outside the Basic Multilingual Plane as they were sent", async () => {
      // U+1F4EC is a surrogate pair in UTF-16; only an unpaired surrogate is refused.
      const address = "owner-\u{1f4ec}@example.test";
      const username = "login-\u{1f4ec}";

      const answer = await connect({ ...GENERIC_BODY, address, username });

      expect(answer.status).toBe(201);
      expect(answer.item.properties).toMatchObject({ addresses: address });
      expect(await storedMailbox(answer.item.id)).toMatchObject({
        settings: { username },
        providerAccountAddress: address,
      });
    });

    it("names a generic mailbox after the domain of its address, in no language", async () => {
      const answer = await connect({ ...GENERIC_BODY, address: "Person@Mail.Example.TEST" });

      expect(answer.item.properties.name).toBe("mail.example.test");
    });

    it("stores port 143 with starttls when the generic server accepts IMAP only there", async () => {
      const imap = vi
        .spyOn(connections, "verifyImapServerConnectionAndListFolders")
        .mockResolvedValueOnce({ attempt: "unreachable", folders: null })
        .mockResolvedValueOnce({ attempt: "success", folders: [] });
      const smtp = vi.spyOn(connections, "verifySmtpServerConnection").mockResolvedValue("success");

      const answer = await connect(GENERIC_BODY, { dependencies: PRODUCTION_VERIFICATION });

      expect(answer.status).toBe(201);
      expect((await storedMailbox(answer.item.id)).settings).toEqual({
        mailboxItemId: answer.item.id,
        imap: { host: IMAP_HOST, port: 143, security: "starttls" },
        smtp: { host: SMTP_HOST, port: 465, security: "tls" },
        username: ADDRESS,
        caldavUrl: null,
      });
      // Both protocols log in with the address, because the request names no user name.
      expect(imap.mock.calls.map(([settings, credential]) => [settings.username, credential.password])).toEqual([
        [ADDRESS, PASSWORD],
        [ADDRESS, PASSWORD],
      ]);
      expect(smtp.mock.calls.map(([settings, credential]) => [settings.username, credential.password])).toEqual([
        [ADDRESS, PASSWORD],
      ]);
    });

    it.each<[string, unknown, "authentication" | "tls" | "unreachable", string]>([
      ["a generic login the server rejects", GENERIC_BODY, "authentication", "mail_auth_failed"],
      ["an iCloud login the server rejects", ICLOUD_BODY, "authentication", "mail_app_password_required"],
      ["a generic server without TLS", GENERIC_BODY, "tls", "mail_tls_failed"],
      ["a generic server that cannot be reached", GENERIC_BODY, "unreachable", "mail_server_unreachable"],
    ])("answers %s with 400 and its verification code, and stores nothing", async (_name, body, attempt, code) => {
      vi.spyOn(connections, "verifyImapServerConnectionAndListFolders").mockResolvedValue({ attempt, folders: null });
      // SMTP is verified concurrently and accepts; the IMAP refusal is the one answered.
      const smtp = vi.spyOn(connections, "verifySmtpServerConnection").mockResolvedValue("success");
      const logged = recordLogCalls();

      const error = await rejectionOf(connect(body, { dependencies: PRODUCTION_VERIFICATION }));

      expect(error).toBeInstanceOf(ChokePointError);
      if (!(error instanceof ChokePointError)) throw new Error("expected a ChokePointError");
      expect({ status: error.status, code: error.code }).toEqual({ status: 400, code });
      expect(errorText(error)).not.toContain(PASSWORD);
      expect(logged()).not.toContain(PASSWORD);
      expect(smtp).toHaveBeenCalled();
      expect(await mailboxRows()).toEqual(NOTHING);
    });

    it.each([
      ["mail_auth_failed", new MailAuthFailedError()],
      ["mail_app_password_required", new MailAppPasswordRequiredError()],
      ["mail_server_unreachable", new MailServerUnreachableError()],
      ["mail_tls_failed", new MailTlsFailedError()],
    ])("answers an injected verification's %s refusal with the same 400", async (code, refusal) => {
      const error = await rejectionOf(
        connect(GENERIC_BODY, {
          dependencies: { mailServerClients: { verifyPassword: () => Promise.reject(refusal) } },
        }),
      );

      expect(error).toBeInstanceOf(ChokePointError);
      if (!(error instanceof ChokePointError)) throw new Error("expected a ChokePointError");
      expect({ status: error.status, code: error.code, message: error.message }).toEqual({
        status: 400,
        code,
        message: refusal.message,
      });
      expect(await mailboxRows()).toEqual(NOTHING);
    });

    it("lets an unknown verification failure propagate as the verification's fixed error, without the password", async () => {
      vi.spyOn(connections, "verifyImapServerConnectionAndListFolders").mockRejectedValue(
        new Error(`login ${PASSWORD} exploded`),
      );
      vi.spyOn(connections, "verifySmtpServerConnection").mockResolvedValue("success");
      const logged = recordLogCalls();

      const error = await rejectionOf(connect(GENERIC_BODY, { dependencies: PRODUCTION_VERIFICATION }));

      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(ChokePointError);
      if (!(error instanceof Error)) throw new Error("expected an Error");
      expect(error.message).toBe("Mail credential verification failed unexpectedly");
      expect(errorText(error)).not.toContain(PASSWORD);
      expect(logged()).not.toContain(PASSWORD);
      expect(await mailboxRows()).toEqual(NOTHING);
    });

    it("hands an injected verification's own failure on unchanged and stores nothing", async () => {
      const failure = new Error("the injected verification failed");

      const error = await rejectionOf(
        connect(GENERIC_BODY, {
          dependencies: { mailServerClients: { verifyPassword: () => Promise.reject(failure) } },
        }),
      );

      expect(error).toBe(failure);
      expect(await mailboxRows()).toEqual(NOTHING);
    });

    it("keeps the password out of the mail and database log calls of a successful connect", async () => {
      vi.spyOn(connections, "verifyImapServerConnectionAndListFolders").mockResolvedValue({
        attempt: "success",
        folders: [],
      });
      vi.spyOn(connections, "verifySmtpServerConnection").mockResolvedValue("success");
      const logged = recordLogCalls();

      const answer = await connect(GENERIC_BODY, { dependencies: PRODUCTION_VERIFICATION });

      expect(answer.status).toBe(201);
      expect(logged()).not.toContain(PASSWORD);
    });

    it("queues the first sync inside the transaction that creates the mailbox", async () => {
      const enqueue = mailSyncEnqueue.enqueueMailAccountSync;
      const seenWhileEnqueuing: Array<{ inTransaction: number; committed: number }> = [];
      vi.spyOn(mailSyncEnqueue, "enqueueMailAccountSync").mockImplementation(async (client, mailboxItemId) => {
        const count = async (reader: PoolClient | Pool): Promise<number> => {
          const { rows } = await reader.query<{ n: number }>("SELECT count(*)::int AS n FROM items WHERE id = $1", [
            mailboxItemId,
          ]);
          return rows[0]?.n ?? -1;
        };
        seenWhileEnqueuing.push({
          // The client the job is queued on is the one that created the item ...
          inTransaction: await count(client),
          // ... and another connection of the same tenant does not see that item yet.
          committed: await inTenant((other) => count(other)),
        });
        await enqueue(client, mailboxItemId);
      });

      const answer = await connect(GENERIC_BODY);

      expect(seenWhileEnqueuing).toEqual([{ inTransaction: 1, committed: 0 }]);
      expect(await queuedSyncJobs()).toEqual([answer.item.id]);
    });

    it("rolls the whole mailbox back when its first sync cannot be queued", async () => {
      const failure = new Error("the queue refused the job");
      vi.spyOn(mailSyncEnqueue, "enqueueMailAccountSync").mockRejectedValue(failure);

      const error = await rejectionOf(connect(GENERIC_BODY));

      expect(error).toBe(failure);
      expect(await mailboxRows()).toEqual(NOTHING);
    });

    it("fails with the seed error and contacts no server in a tenant without the mail databases", async () => {
      const unprovisioned = await createTestTenant(admin);
      const verifier = acceptingVerifier();

      const error = await rejectionOf(
        connect(GENERIC_BODY, { dependencies: verifier.dependencies, tenantId: unprovisioned }),
      );

      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(ChokePointError);
      if (!(error instanceof Error)) throw new Error("expected an Error");
      expect(error.message).toContain("Mail module databases are not seeded");
      expect(verifier.calls).toEqual([]);
    });
  });

  describe("a composition root that configured no verification", () => {
    beforeEach(seedTenantZero);

    it.each<[string, MailboxPasswordRouteDependencies]>([
      ["an empty container", {}],
      ["mail server clients without the verification", { mailServerClients: {} }],
    ])(
      "fails a request on %s with a configuration error, contacts no server and stores nothing",
      async (_name, dependencies) => {
        // The mail module's own verification would accept this login, so a mailbox here means the route ran it.
        const imap = vi
          .spyOn(connections, "verifyImapServerConnectionAndListFolders")
          .mockResolvedValue({ attempt: "success", folders: [] });
        const smtp = vi.spyOn(connections, "verifySmtpServerConnection").mockResolvedValue("success");

        // Mounted without a limiter too, so the first container is the empty one its name says.
        const error = await rejectionOf(connect(GENERIC_BODY, { dependencies, throttle: null }));

        // A plain error, which the adapter answers with a generic 500, and no domain status.
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(ChokePointError);
        if (!(error instanceof Error)) throw new Error("expected an Error");
        expect(error.message).toBe(
          'custom route dependency "mailServerClients.verifyPassword" is not configured by the composition root',
        );
        expect(errorText(error)).not.toContain(PASSWORD);
        expect(imap).not.toHaveBeenCalled();
        expect(smtp).not.toHaveBeenCalled();
        expect(await mailboxRows()).toEqual(NOTHING);
      },
    );

    it("fails a body with a CalDAV address without the CalDAV verification before any login is verified", async () => {
      const verifier = acceptingVerifier();
      const attempts = recordingThrottle();

      const error = await rejectionOf(
        connect(
          { ...GENERIC_BODY, caldavUrl: CALDAV_URL },
          {
            dependencies: {
              mailServerClients: { verifyPassword: verifier.dependencies.mailServerClients?.verifyPassword },
            },
            throttle: attempts.throttle,
          },
        ),
      );

      expect(error).not.toBeInstanceOf(ChokePointError);
      if (!(error instanceof Error)) throw new Error("expected an Error");
      expect(error.message).toBe(
        'custom route dependency "mailServerClients.verifyCalDav" is not configured by the composition root',
      );
      expect(verifier.calls).toEqual([]);
      expect(attempts.attempts).toEqual([]);
      expect(await mailboxRows()).toEqual(NOTHING);
    });

    it("still answers a body it refuses with validation_failed", async () => {
      const error = await rejectionOf(
        connect({ ...GENERIC_BODY, address: "owner" }, { dependencies: {}, throttle: null }),
      );

      expect(error).toBeInstanceOf(ValidationError);
      if (!(error instanceof ValidationError)) throw new Error("expected a ValidationError");
      expect(error.details).toEqual({ field: "address" });
    });
  });

  describe("the per-user limit of login verifications (issue gh-1750)", () => {
    beforeEach(seedTenantZero);

    it("counts one attempt for the session's user directly before the verification, and creates the mailbox", async () => {
      const order: string[] = [];
      const limiter = recordingThrottle({ onAttempt: () => order.push("attempt") });
      const dependencies: MailboxPasswordRouteDependencies = {
        mailServerClients: {
          verifyPassword: async () => {
            order.push("verification");
            return ICLOUD_SETTINGS;
          },
        },
      };

      const answer = await connect(ICLOUD_BODY, { dependencies, throttle: limiter.throttle });

      expect(answer.status).toBe(201);
      expect(limiter.attempts).toEqual([["mailboxCredentialVerification", userId]]);
      expect(order).toEqual(["attempt", "verification"]);
      expect(await mailboxRows()).toEqual(oneWholeMailbox(answer.item.id));
    });

    it("answers a user at the limit with 429 rate_limited and the seconds to wait, verifies no login and stores nothing", async () => {
      const verifier = acceptingVerifier();
      const limiter = recordingThrottle({ refuseWithSeconds: 123 });

      const error = await rejectionOf(
        connect(GENERIC_BODY, { dependencies: verifier.dependencies, throttle: limiter.throttle }),
      );

      expect(error).toBeInstanceOf(RateLimitedError);
      if (!(error instanceof RateLimitedError)) throw new Error("expected a RateLimitedError");
      expect({ status: error.status, code: error.code, details: error.details }).toEqual({
        status: 429,
        code: "rate_limited",
        details: undefined,
      });
      expect(error.retryAfterSeconds).toBe(123);
      expect(errorText(error)).not.toContain(PASSWORD);
      expect(limiter.attempts).toEqual([["mailboxCredentialVerification", userId]]);
      expect(verifier.calls).toEqual([]);
      expect(await mailboxRows()).toEqual(NOTHING);
    });

    it.each<[string, unknown]>([
      ["a body the schema refuses", { ...GENERIC_BODY, address: "owner" }],
      ["a generic body without its hosts", { provider: "generic", address: ADDRESS, password: PASSWORD }],
    ])("counts no attempt for %s", async (_name, body) => {
      const limiter = recordingThrottle();

      const error = await rejectionOf(connect(body, { throttle: limiter.throttle }));

      expect(error).toBeInstanceOf(ValidationError);
      expect(limiter.attempts).toEqual([]);
    });

    it("counts no attempt for an address the duplicate rule refuses before any server is contacted", async () => {
      await existingMailbox(recordingProviderAddress(ADDRESS));
      const verifier = acceptingVerifier();
      const limiter = recordingThrottle();

      const error = await rejectionOf(
        connect(GENERIC_BODY, { dependencies: verifier.dependencies, throttle: limiter.throttle }),
      );

      expect(error).toBeInstanceOf(ProviderAccountAlreadyConnectedError);
      expect(limiter.attempts).toEqual([]);
      expect(verifier.calls).toEqual([]);
    });

    it.each<[string, () => Promise<VerifiedMailServerSettings>, (outcome: unknown) => void]>([
      ["a created mailbox", async () => ICLOUD_SETTINGS, (outcome) => expect(outcome).toMatchObject({ status: 201 })],
      [
        "a login the mail server refused",
        () => Promise.reject(new MailAuthFailedError()),
        (outcome) => expect(outcome).toMatchObject({ status: 400, code: "mail_auth_failed" }),
      ],
      [
        "a verification that failed unexpectedly",
        () => Promise.reject(new Error("the injected verification failed")),
        (outcome) => expect(outcome).toMatchObject({ message: "the injected verification failed" }),
      ],
      [
        "a mailbox that came to hold the address while the login was verified",
        async () => {
          await existingMailbox(listingAlias(ADDRESS));
          return ICLOUD_SETTINGS;
        },
        (outcome) => expect(outcome).toBeInstanceOf(ProviderAccountAlreadyConnectedError),
      ],
    ])("keeps the attempt counted after %s", async (_name, verifyPassword, expectOutcome) => {
      const limiter = recordingThrottle();

      const outcome = await connect(ICLOUD_BODY, {
        dependencies: { mailServerClients: { verifyPassword } },
        throttle: limiter.throttle,
      }).catch((error: unknown) => error);

      expectOutcome(outcome);
      expect(limiter.attempts).toEqual([["mailboxCredentialVerification", userId]]);
      expect(limiter.releases()).toBe(0);
    });
  });

  describe("a composition root that configured no limiter (issue gh-1750)", () => {
    beforeEach(seedTenantZero);

    it("fails a request with a configuration error, contacts no server and stores nothing", async () => {
      const verifier = acceptingVerifier();

      const error = await rejectionOf(connect(GENERIC_BODY, { dependencies: verifier.dependencies, throttle: null }));

      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(ChokePointError);
      if (!(error instanceof Error)) throw new Error("expected an Error");
      expect(error.message).toBe('custom route dependency "throttle" is not configured by the composition root');
      expect(errorText(error)).not.toContain(PASSWORD);
      expect(verifier.calls).toEqual([]);
      expect(await mailboxRows()).toEqual(NOTHING);
    });

    it("still answers a body it refuses with validation_failed", async () => {
      const error = await rejectionOf(connect({ ...GENERIC_BODY, address: "owner" }, { throttle: null }));

      expect(error).toBeInstanceOf(ValidationError);
      if (!(error instanceof ValidationError)) throw new Error("expected a ValidationError");
      expect(error.details).toEqual({ field: "address" });
    });
  });

  describe("the duplicate rule", () => {
    beforeEach(seedTenantZero);

    function expectAlreadyConnected(error: unknown): void {
      expect(error).toBeInstanceOf(ProviderAccountAlreadyConnectedError);
      if (!(error instanceof ProviderAccountAlreadyConnectedError)) throw new Error("expected the duplicate refusal");
      expect({ status: error.status, code: error.code }).toEqual({
        status: 409,
        code: "provider_account_already_connected",
      });
    }

    it("answers 409 before any server is contacted when a mailbox records the address, in any letter case", async () => {
      const existing = await existingMailbox(recordingProviderAddress(ADDRESS));
      const before = await mailboxRows();
      const verifier = acceptingVerifier();

      const error = await rejectionOf(
        connect({ ...GENERIC_BODY, address: "OWNER@Example.TEST" }, { dependencies: verifier.dependencies }),
      );

      expectAlreadyConnected(error);
      expect(verifier.calls).toEqual([]);
      expect(before.items).toEqual([existing]);
      expect(await mailboxRows()).toEqual(before);
    });

    it("answers 409 before any server is contacted when a mailbox lists the address as an alias", async () => {
      await existingMailbox(listingAlias(ADDRESS));
      const before = await mailboxRows();
      const verifier = acceptingVerifier();

      const error = await rejectionOf(connect(GENERIC_BODY, { dependencies: verifier.dependencies }));

      expectAlreadyConnected(error);
      expect(verifier.calls).toEqual([]);
      expect(await mailboxRows()).toEqual(before);
    });

    it("matches an address list written with commas and capitals, as the list's other readers parse it", async () => {
      // A list from when the generic write accepted any text for `addresses`.
      await existingMailbox((client, mailbox) =>
        updateItemWithClient(
          client,
          {
            databaseId: mailbox.databaseId,
            itemId: mailbox.id,
            propertiesPatch: { addresses: "First@Example.test, Owner@Example.TEST ,third@example.test" },
          },
          { allowedSystemKeys: ["addresses"] },
        ).then(() => undefined),
      );

      expectAlreadyConnected(await rejectionOf(connect(GENERIC_BODY)));
      // An address the list does not hold is connected next to it.
      expect((await connect({ ...GENERIC_BODY, address: "fourth@example.test" })).status).toBe(201);
    });

    it("connects the address of a removed mailbox again, and then refuses to restore the removed one", async () => {
      const removed = (await connect(GENERIC_BODY)).item.id;
      await removeConnectedMailbox(removed);

      const again = await connect(GENERIC_BODY);

      expect(again.status).toBe(201);
      expect(again.item.id).not.toBe(removed);
      expect(await storedMailbox(again.item.id)).toMatchObject({ providerAccountAddress: ADDRESS, password: PASSWORD });
      const databaseId = await inTenant(async (client) => (await resolveMailModuleIds(client)).mailboxesDatabaseId);
      expectAlreadyConnected(
        await rejectionOf(runInTenant(tenant, () => createChokePoint(runtime).restoreItem(databaseId, removed))),
      );
      const trashed = await inTenant((client) =>
        client.query<{ deleted: boolean }>("SELECT deleted_at IS NOT NULL AS deleted FROM items WHERE id = $1", [
          removed,
        ]),
      );
      expect(trashed.rows).toEqual([{ deleted: true }]);
      // A live duplicate is still refused.
      expectAlreadyConnected(await rejectionOf(connect(GENERIC_BODY)));
    });

    it("restores a removed mailbox whose address no live mailbox holds", async () => {
      const removed = (await connect(GENERIC_BODY)).item.id;
      await removeConnectedMailbox(removed);
      const databaseId = await inTenant(async (client) => (await resolveMailModuleIds(client)).mailboxesDatabaseId);

      const restored = await runInTenant(tenant, () => createChokePoint(runtime).restoreItem(databaseId, removed));

      expect(restored?.deletedAt).toBeNull();
    });

    it("answers 409 and stores nothing when a mailbox comes to list the address while the login is verified", async () => {
      let competitor: string | undefined;
      const dependencies: MailboxPasswordRouteDependencies = {
        mailServerClients: {
          // The duplicate rule has passed once by now. No index holds an alias, so the read inside the write
          // transaction is what refuses this request.
          verifyPassword: async () => {
            competitor = await existingMailbox(listingAlias(ADDRESS));
            return ICLOUD_SETTINGS;
          },
        },
      };

      const error = await rejectionOf(connect(ICLOUD_BODY, { dependencies }));

      expectAlreadyConnected(error);
      expect(competitor).toBeDefined();
      expect(await mailboxRows()).toEqual({ ...NOTHING, items: [competitor] });
    });

    it("creates exactly one mailbox for two identical requests that verify at the same time", async () => {
      const bothVerifying = gate();
      let verifying = 0;
      const dependencies: MailboxPasswordRouteDependencies = {
        mailServerClients: {
          // Neither request leaves the verification before both have passed the first read of the rule.
          verifyPassword: async () => {
            verifying += 1;
            if (verifying === 2) bothVerifying.open();
            await withinTenSeconds(bothVerifying.opened, "the second verification");
            return ICLOUD_SETTINGS;
          },
        },
      };

      const outcomes = await Promise.allSettled([
        connect(ICLOUD_BODY, { dependencies }),
        connect(ICLOUD_BODY, { dependencies }),
      ]);

      const created = outcomes.flatMap((outcome) => (outcome.status === "fulfilled" ? [outcome.value] : []));
      const refused = outcomes.flatMap((outcome) => (outcome.status === "rejected" ? [outcome.reason as unknown] : []));
      expect(created.map((answer) => answer.status)).toEqual([201]);
      expect(refused).toHaveLength(1);
      expectAlreadyConnected(refused[0]);
      const id = created[0]?.item.id;
      expect(await mailboxRows()).toEqual(oneWholeMailbox(id));
    });

    it("refuses through the address index a request whose own read of the rule passed before the other one committed", async () => {
      const enqueue = mailSyncEnqueue.enqueueMailAccountSync;
      const firstIsWriting = gate();
      const firstMayCommit = gate();
      let enqueues = 0;
      vi.spyOn(mailSyncEnqueue, "enqueueMailAccountSync").mockImplementation(async (client, mailboxItemId) => {
        enqueues += 1;
        if (enqueues === 1) {
          // The first request has written everything and holds its transaction open here.
          firstIsWriting.open();
          await withinTenSeconds(firstMayCommit.opened, "the release of the first request");
        }
        await enqueue(client, mailboxItemId);
      });

      const first = connect(ICLOUD_BODY);
      await withinTenSeconds(firstIsWriting.opened, "the first request's write");
      const second = connect(ICLOUD_BODY);
      // The second request reads the rule without a lock, so a lock wait means it is past both reads and
      // writing, while the first request has not committed.
      const secondOutcome = rejectionOf(second);
      await waitForLockWaiter();
      firstMayCommit.open();

      const created = await first;
      expectAlreadyConnected(await secondOutcome);
      expect(enqueues).toBe(1);
      const id = created.item.id;
      expect(await mailboxRows()).toEqual(oneWholeMailbox(id));
    });

    it("connects an address another tenant holds, and keeps each tenant's rows out of the other's sight", async () => {
      const other = await secondTenant();
      const theirs = await connect(GENERIC_BODY, { tenantId: other });

      const ours = await connect(GENERIC_BODY);

      expect(ours.status).toBe(201);
      expect(await mailboxRows()).toEqual(oneWholeMailbox(ours.item.id));
      expect(await mailboxRows(other)).toEqual(oneWholeMailbox(theirs.item.id));
      // The same address a second time is refused inside each tenant, so the 201 above is not what every request gets.
      expectAlreadyConnected(await rejectionOf(connect(GENERIC_BODY)));
      expectAlreadyConnected(await rejectionOf(connect(GENERIC_BODY, { tenantId: other })));
    });
  });

  describe("PUT /api/mail/mailboxes/:id/password: sign a password mailbox in again", () => {
    beforeEach(seedTenantZero);

    const NEW_PASSWORD = `new-pw-sentinel-${randomUUID()}`;
    const STORED_LOGIN = "stored-login";

    interface PasswordMailboxFixture {
      provider: "icloud" | "generic";
      credential: string | null;
      calendarsEnabled: boolean;
      caldavUrl: string | null;
    }

    /** Written through the stores the connect uses, with no sync queued, so a test sees only what the route queues. */
    async function passwordMailbox(fixture: Partial<PasswordMailboxFixture> = {}, tenantId = tenant): Promise<string> {
      const { provider = "generic", credential = PASSWORD, calendarsEnabled = false, caldavUrl = null } = fixture;
      return inTenant(async (client) => {
        const { mailboxesDatabaseId } = await resolveMailModuleIds(client);
        const item = await createItemWithClient(client, {
          databaseId: mailboxesDatabaseId,
          properties: { name: "Password", provider, mailEnabled: true, calendarsEnabled },
        });
        await writeMailboxAddresses(client, { mailboxesDatabaseId, mailboxItemId: item.id, address: ADDRESS });
        if (credential !== null) {
          await storeCredential(client, {
            itemId: item.id,
            credentialType: provider === "icloud" ? "app_password" : "plain_password",
            plaintext: credential,
          });
        }
        await upsertMailServerSettings(client, item.id, {
          ...(provider === "icloud"
            ? ICLOUD_SETTINGS
            : {
                imap: { host: IMAP_HOST, port: 143, security: "starttls" as const },
                smtp: { host: SMTP_HOST, port: 587, security: "starttls" as const },
              }),
          username: STORED_LOGIN,
          caldavUrl,
        });
        await ensureMailAccountSyncState(client, { itemId: item.id, syncMode: "imap" });
        await recordProviderAccountAddress(client, item.id, ADDRESS);
        // The state a pass leaves behind for a refused or missing credential, on both services.
        await recordSyncError(client, item.id, "no stored credential", "reauthorization");
        await recordCalendarSyncFailure(client, item.id, "needsReauthorization", "reauthorizationRequired");
        return item.id;
      }, tenantId);
    }

    interface ReplaceOptions {
      dependencies?: MailboxPasswordRouteDependencies;
      tenantId?: string;
      restarted?: string[];
      /** Replaces the recording restart, e.g. with one that fails. */
      restartAccount?: (mailboxItemId: string) => Promise<void>;
    }

    function replace(
      mailboxId: string,
      body: unknown,
      options: ReplaceOptions = {},
    ): Promise<{ status: number; item: ItemRow }> {
      const restarted = options.restarted ?? [];
      const handler = createMailboxPasswordReplaceRouteHandler(runtime, {
        ...(options.dependencies ?? acceptingVerifier().dependencies),
        throttle: recordingThrottle().throttle,
        mailLiveSync: {
          restartAccount:
            options.restartAccount ??
            (async (id) => {
              restarted.push(id);
            }),
        },
      });
      return runInTenant(options.tenantId ?? tenant, () =>
        handler({ identity: { user: { id: userId } }, params: { id: mailboxId }, body }),
      );
    }

    const calendarJobEnvelope = z.object({ tenantId: z.string(), payload: z.object({ accountItemId: z.string() }) });

    async function queuedCalendarSyncJobs(tenantId = tenant): Promise<string[]> {
      const payloads = await readJobPayloadsByIdentifier(admin, CORE_TASK_NAMES.CALENDAR_ACCOUNT_SYNC);
      return payloads
        .map((payload) => calendarJobEnvelope.parse(payload))
        .filter((job) => job.tenantId === tenantId)
        .map((job) => job.payload.accountItemId)
        .sort();
    }

    async function accountState(mailboxId: string, tenantId = tenant) {
      const stored = await storedMailbox(mailboxId, tenantId);
      return inTenant(async (client) => {
        const mail = await getMailAccountSyncState(client, mailboxId);
        const calendar = await getCalendarAccountSyncState(client, mailboxId);
        return {
          password: stored.password,
          credentialTypes: stored.credentialTypes,
          settings: stored.settings,
          mail: mail && {
            lastError: mail.lastError,
            lastFailureKind: mail.lastFailureKind,
            failingSince: mail.failingSince,
            nextExpectedActivityAt: mail.nextExpectedActivityAt,
          },
          calendar: calendar && {
            status: calendar.status,
            failingSince: calendar.failingSince,
            lastErrorCode: calendar.lastErrorCode,
          },
          mailJobs: await queuedSyncJobs(tenantId),
          calendarJobs: await queuedCalendarSyncJobs(tenantId),
        };
      }, tenantId);
    }

    it.each<[string, Partial<PasswordMailboxFixture>]>([
      ["a generic mailbox without a stored credential", { credential: null }],
      ["a generic mailbox whose stored password the server refuses", { credential: PASSWORD }],
    ])(
      "replaces the password of %s, clears both reauthorizations, queues both syncs and restarts the live sync",
      async (_name, fixture) => {
        const mailboxId = await passwordMailbox({ ...fixture, calendarsEnabled: true, caldavUrl: CALDAV_URL });
        const verifier = acceptingVerifier();
        const restarted: string[] = [];
        const logs = recordLogCalls();

        const answer = await replace(
          mailboxId,
          { password: NEW_PASSWORD, username: "new-login" },
          { dependencies: verifier.dependencies, restarted },
        );

        expect(answer.status).toBe(200);
        expect(answer.item.id).toBe(mailboxId);
        expect(answer.item.properties).toMatchObject({ provider: "generic", addresses: ADDRESS });
        expect(JSON.stringify(answer)).not.toContain(NEW_PASSWORD);
        expect(logs()).not.toContain(NEW_PASSWORD);
        // The stored hosts, the new login, and the stored CalDAV address with the same login.
        expect(verifier.calls).toEqual([
          {
            provider: "generic",
            address: ADDRESS,
            username: "new-login",
            password: NEW_PASSWORD,
            imapHost: IMAP_HOST,
            smtpHost: SMTP_HOST,
          },
        ]);
        expect(verifier.calDavCalls).toEqual([
          { caldavUrl: CALDAV_URL, username: "new-login", password: NEW_PASSWORD, resolveServer: false },
        ]);
        expect(await accountState(mailboxId)).toEqual({
          password: NEW_PASSWORD,
          credentialTypes: ["plain_password"],
          // The endpoints that verified replace the stored ones.
          settings: {
            mailboxItemId: mailboxId,
            imap: { host: IMAP_HOST, port: 993, security: "tls" },
            smtp: { host: SMTP_HOST, port: 465, security: "tls" },
            username: "new-login",
            caldavUrl: CALDAV_URL,
          },
          mail: { lastError: null, lastFailureKind: null, failingSince: null, nextExpectedActivityAt: null },
          calendar: { status: "never", failingSince: null, lastErrorCode: null },
          mailJobs: [mailboxId],
          calendarJobs: [mailboxId],
        });
        expect(restarted).toEqual([mailboxId]);
      },
    );

    it("answers 200 with the password replaced when the live sync restart after the commit fails, and logs it without the password", async () => {
      const mailboxId = await passwordMailbox({ credential: PASSWORD });
      const logs = recordLogCalls();

      const answer = await replace(
        mailboxId,
        { password: NEW_PASSWORD },
        {
          restartAccount: async () => {
            throw new Error(`the live sync refused ${NEW_PASSWORD}`);
          },
        },
      );

      expect(answer.status).toBe(200);
      expect(answer.item.id).toBe(mailboxId);
      expect(await accountState(mailboxId)).toMatchObject({ password: NEW_PASSWORD, mailJobs: [mailboxId] });
      expect(logs()).toContain("Restarting the mail live sync after a password replacement failed");
      expect(logs()).not.toContain(NEW_PASSWORD);
    });

    it("keeps the stored user name, verifies iCloud's CalDAV address with Calendars on, and seals an app password", async () => {
      const mailboxId = await passwordMailbox({ provider: "icloud", credential: null, calendarsEnabled: true });
      const verifier = acceptingVerifier();

      expect(
        (await replace(mailboxId, { password: NEW_PASSWORD }, { dependencies: verifier.dependencies })).status,
      ).toBe(200);

      expect(verifier.calls).toEqual([
        { provider: "icloud", address: ADDRESS, username: STORED_LOGIN, password: NEW_PASSWORD },
      ]);
      expect(verifier.calDavCalls).toEqual([
        {
          caldavUrl: "https://caldav.icloud.com/",
          username: STORED_LOGIN,
          password: NEW_PASSWORD,
          resolveServer: false,
        },
      ]);
      expect(await accountState(mailboxId)).toMatchObject({
        password: NEW_PASSWORD,
        credentialTypes: ["app_password"],
        settings: { ...ICLOUD_ENDPOINTS, username: STORED_LOGIN, caldavUrl: null },
      });
    });

    it("verifies the new password on the mail servers and iCloud's CalDAV address concurrently", async () => {
      const mailboxId = await passwordMailbox({ provider: "icloud", credential: null, calendarsEnabled: true });
      const verifier = overlappingVerifier();

      const answer = await replace(mailboxId, { password: NEW_PASSWORD }, { dependencies: verifier.dependencies });

      expect(answer.status).toBe(200);
      expect(verifier.settled).toEqual(["mail", "calDav"]);
    });

    it("contacts no CalDAV server and queues no calendar sync while Calendars is off", async () => {
      const mailboxId = await passwordMailbox({ caldavUrl: CALDAV_URL });
      const verifier = acceptingVerifier();

      await replace(mailboxId, { password: NEW_PASSWORD }, { dependencies: verifier.dependencies });

      expect(verifier.calls).toHaveLength(1);
      expect(verifier.calDavCalls).toEqual([]);
      expect(await accountState(mailboxId)).toMatchObject({ mailJobs: [mailboxId], calendarJobs: [] });
    });

    it.each<[string, Error, "mail" | "caldav"]>([
      ["mail_auth_failed", new MailAuthFailedError(), "mail"],
      ["mail_app_password_required", new MailAppPasswordRequiredError(), "mail"],
      ["mail_server_unreachable", new MailServerUnreachableError(), "mail"],
      ["mail_tls_failed", new MailTlsFailedError(), "mail"],
      ["caldav_auth_failed", new CalDavAuthFailedError(), "caldav"],
      ["caldav_server_unreachable", new CalDavServerUnreachableError(), "caldav"],
      ["caldav_server_invalid", new CalDavServerInvalidError(), "caldav"],
    ])("answers 400 %s for a refused login and changes nothing", async (code, refusal, protocol) => {
      const mailboxId = await passwordMailbox({ calendarsEnabled: true, caldavUrl: CALDAV_URL });
      const before = await accountState(mailboxId);
      const accepting = acceptingVerifier().dependencies.mailServerClients;
      const restarted: string[] = [];
      const dependencies: MailboxPasswordRouteDependencies = {
        mailServerClients: {
          ...accepting,
          ...(protocol === "mail"
            ? {
                verifyPassword: async () => {
                  throw refusal;
                },
              }
            : {
                verifyCalDav: async () => {
                  throw refusal;
                },
              }),
        },
      };

      const error = await rejectionOf(replace(mailboxId, { password: NEW_PASSWORD }, { dependencies, restarted }));

      expect(error).toBeInstanceOf(ChokePointError);
      if (!(error instanceof ChokePointError)) throw new Error("expected a ChokePointError");
      expect({ status: error.status, code: error.code }).toEqual({ status: 400, code });
      expect(errorText(error)).not.toContain(NEW_PASSWORD);
      expect(await accountState(mailboxId)).toEqual(before);
      expect(before.password).toBe(PASSWORD);
      expect(restarted).toEqual([]);
    });

    it("answers 409 mailbox_not_password for a mailbox that signs in through its provider, and verifies nothing", async () => {
      const oauth = await existingMailbox(recordingProviderAddress("oauth@example.test"));
      const verifier = acceptingVerifier();

      const error = await rejectionOf(
        replace(oauth, { password: NEW_PASSWORD }, { dependencies: verifier.dependencies }),
      );

      expect(error).toBeInstanceOf(ChokePointError);
      if (!(error instanceof ChokePointError)) throw new Error("expected a ChokePointError");
      expect({ status: error.status, code: error.code }).toEqual({ status: 409, code: "mailbox_not_password" });
      expect(verifier.calls).toEqual([]);
      expect(await storedMailbox(oauth)).toMatchObject({ password: null, settings: null, syncMode: "gmail_api" });
    });

    it.each<[string, (ownId: string) => Promise<{ id: string; tenantId: string }>]>([
      ["an unknown id", async () => ({ id: randomUUID(), tenantId: tenant })],
      ["a malformed id", async () => ({ id: "not-a-uuid", tenantId: tenant })],
      [
        "a removed mailbox",
        async (ownId) => {
          await removeConnectedMailbox(ownId);
          return { id: ownId, tenantId: tenant };
        },
      ],
      ["another tenant's mailbox", async (ownId) => ({ id: ownId, tenantId: await secondTenant() })],
    ])("answers 404 for %s like for an unknown one, and verifies and changes nothing", async (_name, target) => {
      const ownId = await passwordMailbox();
      const { id, tenantId } = await target(ownId);
      const before = await mailboxRows();
      const verifier = acceptingVerifier();

      const error = await rejectionOf(
        replace(id, { password: NEW_PASSWORD }, { dependencies: verifier.dependencies, tenantId }),
      );

      expect(error).toBeInstanceOf(ChokePointError);
      if (!(error instanceof ChokePointError)) throw new Error("expected a ChokePointError");
      expect({ status: error.status, code: error.code }).toEqual({ status: 404, code: "not_found" });
      expect(verifier.calls).toEqual([]);
      expect(await mailboxRows()).toEqual(before);
    });

    it("replaces the password of the caller's own mailbox when another tenant holds one with the same address", async () => {
      const other = await secondTenant();
      const theirs = await passwordMailbox({}, other);
      const ours = await passwordMailbox();

      expect((await replace(ours, { password: NEW_PASSWORD })).status).toBe(200);

      expect((await accountState(ours)).password).toBe(NEW_PASSWORD);
      expect((await accountState(theirs, other)).password).toBe(PASSWORD);
    });

    it.each<[string, unknown, string | undefined]>([
      ["null", null, undefined],
      ["no password", { username: "login" }, "password"],
      ["an empty password", { password: "" }, "password"],
      ["a password above 1024 characters", { password: "x".repeat(1025) }, "password"],
      ["a blank user name", { password: NEW_PASSWORD, username: "  " }, "username"],
      ["a user name with a NUL character", { password: NEW_PASSWORD, username: "lo\u0000gin" }, "username"],
      ["a key the route does not know", { password: NEW_PASSWORD, imapHost: IMAP_HOST }, undefined],
    ])("refuses %s with validation_failed before any server is contacted", async (_name, body, field) => {
      const mailboxId = await passwordMailbox();
      const before = await accountState(mailboxId);
      const verifier = acceptingVerifier();

      const error = await rejectionOf(replace(mailboxId, body, { dependencies: verifier.dependencies }));

      expect(error).toBeInstanceOf(ValidationError);
      if (!(error instanceof ValidationError)) throw new Error("expected a ValidationError");
      expect(error.details).toEqual(field === undefined ? undefined : { field });
      expect(errorText(error)).not.toContain(NEW_PASSWORD);
      expect(verifier.calls).toEqual([]);
      expect(await accountState(mailboxId)).toEqual(before);
    });
  });

  describe("the tenant export", () => {
    beforeEach(seedTenantZero);

    it("holds the mailbox and its server settings, and the password in no entry", async () => {
      const answer = await connect({ ...GENERIC_BODY, username: "export-login" });
      const { storage, written } = capturingStorage();
      const exportId = await inTenant(async (client) => (await requestTenantExport(client, userId)).export.id);

      await runInTenant(tenant, () =>
        handleTenantExportTask(runtime, { files: storage, mailAttachments: storage }, { exportId }, {}),
      );

      expect(written).toHaveLength(1);
      const entries = readZip(written[0] ?? Buffer.alloc(0));
      const settings = entries.get("tables/mail_account_server_settings.jsonl")?.toString("utf8") ?? "";
      expect(settings).toContain(answer.item.id);
      expect(settings).toContain("export-login");
      expect(entries.get("tables/items.jsonl")?.toString("utf8") ?? "").toContain(answer.item.id);
      expect([...entries.keys()].filter((name) => name.includes("external_credentials"))).toEqual([]);
      const holdingPassword = [...entries].filter(([, bytes]) => bytes.includes(PASSWORD)).map(([name]) => name);
      expect(holdingPassword).toEqual([]);
    });
  });
});
