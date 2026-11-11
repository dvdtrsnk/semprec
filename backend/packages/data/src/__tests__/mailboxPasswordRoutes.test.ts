import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { inflateRawSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { runInTenant } from "@semprec/shared";
import { CORE_TASK_NAMES } from "@semprec/queue";
import { readJobPayloadsByIdentifier } from "@semprec/queue/testSupport";
import "../domainWriteHooks.js";
import { createUser } from "../auth/usersStore.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { createItemWithClient, updateItemWithClient } from "../chokePoint/itemWrites.js";
import { getDecryptedCredential } from "../credentials/externalCredentialsStore.js";
import { logger as dbLogger } from "../db/logger.js";
import { withTransaction } from "../db/pool.js";
import { ChokePointError, ValidationError } from "../errors.js";
import type { BlobStorageWriter } from "../mail/blobStorage.js";
import { logger as mailLogger } from "../mail/logger.js";
import {
  ensureMailAccountSyncState,
  getMailAccountSyncState,
  getProviderAccountAddress,
  ProviderAccountAlreadyConnectedError,
  recordProviderAccountAddress,
} from "../mail/mailAccountSyncStateStore.js";
import { writeMailboxAddresses } from "../mail/mailboxAddresses.js";
import {
  createMailboxPasswordConnectRouteHandler,
  type MailboxPasswordRouteDependencies,
} from "../mail/mailboxPasswordRouteHandlers.js";
import {
  verifyMailCredentials,
  type VerifiedMailServerSettings,
  type VerifyMailCredentialsInput,
} from "../mail/mailCredentialVerification.js";
import { resolveMailModuleIds } from "../mail/mailModuleIds.js";
import * as connections from "../mail/mailServerConnections.js";
import { getMailServerSettings } from "../mail/mailServerSettingsStore.js";
import * as mailSyncEnqueue from "../mail/mailSyncEnqueue.js";
import {
  MailAppPasswordRequiredError,
  MailAuthFailedError,
  MailServerUnreachableError,
  MailTlsFailedError,
} from "../mail/providerTypes.js";
import { seedSystem } from "../seed/seedSystem.js";
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

const ICLOUD_BODY = { provider: "icloud", address: ADDRESS, password: PASSWORD };
const GENERIC_BODY = {
  provider: "generic",
  address: ADDRESS,
  password: PASSWORD,
  imapHost: IMAP_HOST,
  smtpHost: SMTP_HOST,
};

const ICLOUD_SETTINGS: VerifiedMailServerSettings = {
  imap: { host: "imap.mail.me.com", port: 993, security: "tls" },
  smtp: { host: "smtp.mail.me.com", port: 587, security: "starttls" },
};

let admin: Pool;
/** The runtime role row-level security applies to; every production call and every assertion on rows goes through it. */
let runtime: Pool;
let tenant: string;
let userId: string;

/** Runs `fn` in one transaction of `tenantId` on the runtime role. */
function inTenant<T>(fn: (client: PoolClient) => Promise<T>, tenantId = tenant): Promise<T> {
  return runInTenant(tenantId, () => withTransaction(runtime, fn));
}

/**
 * The member as `serve.ts` sets it: the real `verifyMailCredentials`. A case that mounts it stubs the
 * per-endpoint connection attempts, so no mail server is contacted.
 */
const PRODUCTION_VERIFICATION: MailboxPasswordRouteDependencies = {
  mailServerClients: { verifyPassword: verifyMailCredentials },
};

interface AcceptingVerifier {
  dependencies: MailboxPasswordRouteDependencies;
  /** What the route handed the verification, one entry per call. */
  calls: VerifyMailCredentialsInput[];
}

/** A verification that accepts every login: the fixed iCloud endpoints, or 993 and 465 with TLS on the hosts it was given. */
function acceptingVerifier(): AcceptingVerifier {
  const calls: VerifyMailCredentialsInput[] = [];
  return {
    calls,
    dependencies: {
      mailServerClients: {
        verifyPassword: async (input) => {
          calls.push(input);
          if (input.imapHost === undefined || input.smtpHost === undefined) return ICLOUD_SETTINGS;
          return {
            imap: { host: input.imapHost, port: 993, security: "tls" },
            smtp: { host: input.smtpHost, port: 465, security: "tls" },
          };
        },
      },
    },
  };
}

interface ConnectOptions {
  dependencies?: MailboxPasswordRouteDependencies;
  tenantId?: string;
  locale?: string;
}

/** Calls the route handler the way the adapter does: inside the caller's tenant, with the session's user. */
function connect(body: unknown, options: ConnectOptions = {}): Promise<{ status: number; item: ItemRow }> {
  const handler = createMailboxPasswordConnectRouteHandler(
    runtime,
    options.dependencies ?? acceptingVerifier().dependencies,
  );
  return runInTenant(options.tenantId ?? tenant, () =>
    handler({ identity: { user: { id: userId, locale: options.locale ?? "en" } }, body }),
  );
}

/** The rejection of `work`, or a failure when it resolved. */
async function rejectionOf(work: Promise<unknown>): Promise<unknown> {
  const settled = await work.then(
    () => ({ rejected: false as const }),
    (error: unknown) => ({ rejected: true as const, error }),
  );
  if (!settled.rejected) throw new Error("expected the request to be refused");
  return settled.error;
}

const syncJobEnvelope = z.object({ tenantId: z.string(), payload: z.object({ mailboxItemId: z.string() }) });

/** The queued first-sync jobs of `tenantId`, by mailbox id. */
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

/** What `mailboxRows` reads of a tenant that holds exactly one mailbox, `id`, with every part of it. */
function oneWholeMailbox(id: string | undefined): Record<keyof MailboxRows, Array<string | undefined>> {
  return { items: [id], credentials: [id], settings: [id], syncStates: [id], jobs: [id] };
}

/** The ids of everything a mailbox consists of, as `tenantId` sees them. */
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

/** What the route stored for one mailbox, read back through the stores the sync and send paths read. */
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

/** A mailbox of another connect flow, written through the production writers: an item, and what `fill` adds to it. */
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

/** Records `address` as the mailbox's provider account address, as a connect flow does. */
function recordingProviderAddress(address: string) {
  return async (client: PoolClient, mailbox: { id: string }): Promise<void> => {
    await ensureMailAccountSyncState(client, { itemId: mailbox.id, syncMode: "gmail_api" });
    await recordProviderAccountAddress(client, mailbox.id, address);
  };
}

/** Lists `alias` among the mailbox's addresses without recording it as a provider account address. */
function listingAlias(alias: string) {
  return (client: PoolClient, mailbox: { databaseId: string; id: string }): Promise<void> =>
    writeMailboxAddresses(client, {
      mailboxesDatabaseId: mailbox.databaseId,
      mailboxItemId: mailbox.id,
      address: "primary@example.test",
      aliases: [alias],
    });
}

/** Seeds the system databases of tenant zero and one user, on a database emptied of every earlier test's rows. */
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

/** A second tenant with its own system databases. */
async function secondTenant(): Promise<string> {
  const other = await createTestTenant(admin, { status: "provisioning" });
  await provisionTenant(runtime, other);
  return other;
}

const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;

/**
 * Records every call to the mail and database loggers, whatever the configured level, and silences them.
 * Returns the arguments of the calls so far, serialized with the message and stack of every logged error.
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

/** Everything of a thrown value that an error log or an error response could carry. */
function errorText(error: unknown): string {
  if (!(error instanceof Error)) return JSON.stringify(error);
  return `${error.name} ${error.message} ${error.stack ?? ""} ${JSON.stringify(error)} ${JSON.stringify(Object.getOwnPropertyDescriptors(error))}`;
}

/** A gate a test opens once: `opened` settles after `open()`. */
function gate(): { opened: Promise<void>; open: () => void } {
  let release: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { opened, open: () => release() };
}

/** Rejects when `work` has not settled after ten seconds, so an orchestration that went wrong fails with its name. */
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

/** Resolves once a backend of the test database waits for a lock another transaction holds. */
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
 * Reads every entry of a ZIP archive into memory through the central directory, which carries each entry's
 * sizes even when the local header defers them to a data descriptor (as yazl writes them).
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

/** A blob storage that keeps what the export writes in memory. */
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
    runtime = await createRuntimeRolePool(admin, "semprec_data");
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
    ])("refuses %s with validation_failed before any server is contacted", async (_name, body, field) => {
      const verifier = acceptingVerifier();

      const error = await rejectionOf(connect(body, { dependencies: verifier.dependencies }));

      expect(error).toBeInstanceOf(ValidationError);
      if (!(error instanceof ValidationError)) throw new Error("expected a ValidationError");
      expect(error.details).toEqual(field === undefined ? undefined : { field });
      expect(errorText(error)).not.toContain(PASSWORD);
      expect(verifier.calls).toEqual([]);
      expect(await mailboxRows()).toEqual(NOTHING);
    });
  });

  describe("verification and writes", () => {
    beforeEach(seedTenantZero);

    it("creates an iCloud mailbox with its app password, the fixed iCloud settings, an IMAP sync state and a queued sync", async () => {
      const verifier = acceptingVerifier();

      const answer = await connect(
        { ...ICLOUD_BODY, address: "  Owner@Example.test " },
        { dependencies: verifier.dependencies, locale: "cs" },
      );

      expect(answer.status).toBe(201);
      expect(answer.item.deletedAt).toBeNull();
      expect(answer.item.properties).toMatchObject({ name: "iCloud", provider: "icloud", addresses: ADDRESS });
      expect(JSON.stringify(answer)).not.toContain(PASSWORD);
      // The user name defaults to the address as it was typed, and iCloud gets no host from the request.
      expect(verifier.calls).toEqual([
        { provider: "icloud", address: "Owner@Example.test", username: "Owner@Example.test", password: PASSWORD },
      ]);
      const id = answer.item.id;
      expect(await mailboxRows()).toEqual(oneWholeMailbox(id));
      expect(await storedMailbox(id)).toEqual({
        settings: { mailboxItemId: id, ...ICLOUD_SETTINGS, username: "Owner@Example.test" },
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
      expect(answer.item.properties).toMatchObject({ name: "Other account", provider: "generic", addresses: ADDRESS });
      expect(verifier.calls).toEqual([
        {
          provider: "generic",
          address: ADDRESS,
          username: "login-name",
          password: PASSWORD,
          imapHost: IMAP_HOST,
          smtpHost: SMTP_HOST,
        },
      ]);
      expect(await storedMailbox(answer.item.id)).toEqual({
        settings: {
          mailboxItemId: answer.item.id,
          imap: { host: IMAP_HOST, port: 993, security: "tls" },
          smtp: { host: SMTP_HOST, port: 465, security: "tls" },
          username: "login-name",
        },
        syncMode: "imap",
        providerAccountAddress: ADDRESS,
        credentialTypes: ["plain_password"],
        password: PASSWORD,
      });
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

    it.each([
      ["cs", "Jiný účet"],
      ["en", "Other account"],
      ["de", "Other account"],
    ])("names a generic mailbox from the mail catalog in the caller's locale (%s)", async (locale, name) => {
      const answer = await connect(GENERIC_BODY, { locale });

      expect(answer.item.properties.name).toBe(name);
    });

    it("stores port 143 with starttls when the generic server accepts IMAP only there", async () => {
      // The route runs the real verifyMailCredentials, as serve.ts sets it, over the stubbed attempts.
      const imap = vi
        .spyOn(connections, "verifyImapServerConnection")
        .mockResolvedValueOnce("unreachable")
        .mockResolvedValueOnce("success");
      const smtp = vi.spyOn(connections, "verifySmtpServerConnection").mockResolvedValue("success");

      const answer = await connect(GENERIC_BODY, { dependencies: PRODUCTION_VERIFICATION });

      expect(answer.status).toBe(201);
      expect((await storedMailbox(answer.item.id)).settings).toEqual({
        mailboxItemId: answer.item.id,
        imap: { host: IMAP_HOST, port: 143, security: "starttls" },
        smtp: { host: SMTP_HOST, port: 465, security: "tls" },
        username: ADDRESS,
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
      vi.spyOn(connections, "verifyImapServerConnection").mockResolvedValue(attempt);
      const smtp = vi.spyOn(connections, "verifySmtpServerConnection");
      const logged = recordLogCalls();

      const error = await rejectionOf(connect(body, { dependencies: PRODUCTION_VERIFICATION }));

      expect(error).toBeInstanceOf(ChokePointError);
      if (!(error instanceof ChokePointError)) throw new Error("expected a ChokePointError");
      expect({ status: error.status, code: error.code }).toEqual({ status: 400, code });
      expect(errorText(error)).not.toContain(PASSWORD);
      expect(logged()).not.toContain(PASSWORD);
      expect(smtp).not.toHaveBeenCalled();
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
      vi.spyOn(connections, "verifyImapServerConnection").mockRejectedValue(new Error(`login ${PASSWORD} exploded`));
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
      vi.spyOn(connections, "verifyImapServerConnection").mockResolvedValue("success");
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
        const imap = vi.spyOn(connections, "verifyImapServerConnection").mockResolvedValue("success");
        const smtp = vi.spyOn(connections, "verifySmtpServerConnection").mockResolvedValue("success");

        const error = await rejectionOf(connect(GENERIC_BODY, { dependencies }));

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

    it("still answers a body it refuses with validation_failed", async () => {
      const error = await rejectionOf(connect({ ...GENERIC_BODY, address: "owner" }, { dependencies: {} }));

      expect(error).toBeInstanceOf(ValidationError);
      if (!(error instanceof ValidationError)) throw new Error("expected a ValidationError");
      expect(error.details).toEqual({ field: "address" });
    });
  });

  describe("the duplicate rule", () => {
    beforeEach(seedTenantZero);

    /** Expects the 409 of the duplicate rule. */
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
      // A list from before issue #1454, when the generic write accepted any text for `addresses`.
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

    it("counts a trashed mailbox's address list, as the address index counts its sync state", async () => {
      const trashed = await existingMailbox(listingAlias(ADDRESS));
      const databaseId = await inTenant(async (client) => (await resolveMailModuleIds(client)).mailboxesDatabaseId);
      const deleted = await runInTenant(tenant, () => createChokePoint(runtime).softDeleteItem(databaseId, trashed));
      expect(deleted?.deletedAt).not.toBeNull();

      expectAlreadyConnected(await rejectionOf(connect(GENERIC_BODY)));
    });

    it("answers 409 and stores nothing when a mailbox comes to list the address while the login is verified", async () => {
      let competitor: string | undefined;
      const dependencies: MailboxPasswordRouteDependencies = {
        mailServerClients: {
          // The duplicate rule has passed once by now. No index holds an alias, so the read inside the
          // write transaction is what refuses this request.
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
