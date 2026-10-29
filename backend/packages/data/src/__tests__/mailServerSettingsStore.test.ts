import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { ValidationError } from "../errors.js";
import {
  deleteMailServerSettings,
  getMailServerSettings,
  upsertMailServerSettings,
  type MailServerSettingsInput,
} from "../mail/mailServerSettingsStore.js";

let pool: Pool;

const VALID: MailServerSettingsInput = {
  imap: { host: "imap.example.com", port: 993, security: "tls" },
  smtp: { host: "smtp.example.com", port: 587, security: "starttls" },
  username: "alice@example.com",
};

/** Runs `fn` in a transaction on the owner role that is always rolled back. */
async function inRolledBackTransaction(fn: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await fn(client);
  } finally {
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  }
}

async function expectField(input: MailServerSettingsInput, field: string): Promise<void> {
  await inRolledBackTransaction(async (client) => {
    const error = await upsertMailServerSettings(client, randomUUID(), input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).details).toEqual({ field });
  });
}

beforeAll(async () => {
  pool = getTestPool();
  await resetDatabase(pool);
});

afterAll(async () => {
  await pool.end();
});

describe("mail server settings store (issue #1473)", () => {
  it("round-trips settings and the row holds no password", async () => {
    await inRolledBackTransaction(async (client) => {
      const id = randomUUID();
      const stored = await upsertMailServerSettings(client, id, VALID);
      expect(stored).toEqual({ mailboxItemId: id, ...VALID });
      expect(await getMailServerSettings(client, id)).toEqual(stored);
      const { rows } = await client.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'mail_account_server_settings'",
      );
      expect(rows.map((r: { column_name: string }) => r.column_name).filter((c) => /pass|secret/i.test(c))).toEqual([]);
    });
  });

  it("replaces on a second upsert, allows an SMTP-only mailbox and deletes", async () => {
    await inRolledBackTransaction(async (client) => {
      const id = randomUUID();
      await upsertMailServerSettings(client, id, VALID);
      const smtpOnly = { imap: null, smtp: VALID.smtp, username: "bob" };
      expect(await upsertMailServerSettings(client, id, smtpOnly)).toEqual({ mailboxItemId: id, ...smtpOnly });
      expect(await deleteMailServerSettings(client, id)).toBe(true);
      expect(await deleteMailServerSettings(client, id)).toBe(false);
      expect(await getMailServerSettings(client, id)).toBeNull();
    });
  });

  it("normalizes an upper-case host", async () => {
    await inRolledBackTransaction(async (client) => {
      const stored = await upsertMailServerSettings(client, randomUUID(), {
        ...VALID,
        imap: { host: "IMAP.Example.COM", port: 993, security: "tls" },
      });
      expect(stored.imap?.host).toBe("imap.example.com");
    });
  });

  it.each([
    "127.0.0.1",
    "[::1]",
    "::1",
    "localhost",
    "a.localhost",
    "printer.local",
    "db.internal",
    "2130706433",
    "0x7f000001",
    "0177.0.0.1",
    "10.1",
    `${"a".repeat(300)}.example.com`,
    "bad_label.example.com",
    "-x.example.com",
    "singlelabel",
  ])("refuses the host %s", async (host) => {
    await expectField({ ...VALID, imap: { host, port: 993, security: "tls" } }, "imapHost");
    await expectField({ ...VALID, smtp: { host, port: 587, security: "starttls" } }, "smtpHost");
  });

  it.each([25, 0, 99999, 80])("refuses the port %s", async (port) => {
    await expectField({ ...VALID, imap: { host: "imap.example.com", port, security: "tls" } }, "imapPort");
    await expectField({ ...VALID, smtp: { host: "smtp.example.com", port, security: "tls" } }, "smtpPort");
  });

  it("refuses an unknown security mode and an empty username", async () => {
    await expectField(
      { ...VALID, imap: { host: "imap.example.com", port: 993, security: "none" as "tls" } },
      "imapSecurity",
    );
    await expectField({ ...VALID, username: " " }, "username");
  });

  it("the database refuses a half-set endpoint and a bad port on its own", async () => {
    await inRolledBackTransaction(async (client) => {
      await client.query("SAVEPOINT s1");
      await expect(
        client.query(
          "INSERT INTO mail_account_server_settings (mailbox_item_id, imap_host, username) VALUES ($1, 'imap.example.com', 'u')",
          [randomUUID()],
        ),
      ).rejects.toThrow(/imap_all_or_none/);
      await client.query("ROLLBACK TO SAVEPOINT s1");
      await expect(
        client.query(
          "INSERT INTO mail_account_server_settings (mailbox_item_id, smtp_host, smtp_port, smtp_security, username) VALUES ($1, 'smtp.example.com', 25, 'tls', 'u')",
          [randomUUID()],
        ),
      ).rejects.toThrow(/smtp_port/);
    });
  });

  it("hides another tenant's row under row-level security", async () => {
    await inRolledBackTransaction(async (client) => {
      const { rows: existing } = await client.query<{ id: string }>("SELECT id FROM tenants");
      const a = existing[0]?.id;
      if (!a) throw new Error("no existing tenant");
      await client.query("DROP INDEX IF EXISTS tenants_single_tenant_guard");
      const { rows } = await client.query<{ id: string }>(
        "INSERT INTO tenants (status) VALUES ('active') RETURNING id",
      );
      const b = rows[0]?.id;
      if (!b) throw new Error("second tenant was not inserted");
      await client.query("SET LOCAL ROLE semprec_data");
      const id = randomUUID();
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [a]);
      await upsertMailServerSettings(client, id, VALID);
      expect(await getMailServerSettings(client, id)).not.toBeNull();
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [b]);
      expect(await getMailServerSettings(client, id)).toBeNull();
      const { rows: all } = await client.query("SELECT 1 FROM mail_account_server_settings");
      expect(all).toEqual([]);
      expect(await deleteMailServerSettings(client, id)).toBe(false);
    });
  });
});
