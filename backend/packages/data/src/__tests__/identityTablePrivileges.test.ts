import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { withTransaction } from "../db/pool.js";
import { bootstrapFirstAccount, login, logout, verifySessionToken } from "../auth/authActions.js";
import { requestPasswordReset, resetPassword } from "../auth/passwordResetActions.js";
import type { PasswordResetMailer, SendPasswordResetEmailInput } from "../auth/passwordResetMail.js";
import { UnauthorizedError } from "../errors.js";

/**
 * Issue #976: the identity tables are written only by `semprec_data`; `semprec_side` may only read
 * them. Logs in as each role with its own random password, like `leastPrivilegeRoles.test.ts`.
 */
const TEST_ROLE_PASSWORD = randomUUID();
const IDENTITY_TABLES = ["users", "sessions", "password_reset_tokens", "login_attempts", "tenants"];
const SETUP_TOKEN = "setup-token-for-identity-privileges";
const PASSWORD = "s3cret-password";

let adminPool: Pool;
let dataPool: Pool;
let sidePool: Pool;

function roleConnectionString(role: string): string {
  const url = new URL(process.env.TEST_DATABASE_URL!);
  url.username = role;
  url.password = TEST_ROLE_PASSWORD;
  return url.toString();
}

function fakeMailer(): PasswordResetMailer & { sent: SendPasswordResetEmailInput[] } {
  const sent: SendPasswordResetEmailInput[] = [];
  return {
    sent,
    async sendPasswordResetEmail(input) {
      sent.push(input);
    },
  };
}

describe("identity table privileges (issue #976)", () => {
  beforeAll(async () => {
    adminPool = getTestPool();
    await adminPool.query(`ALTER ROLE semprec_data WITH PASSWORD '${TEST_ROLE_PASSWORD}'`);
    await adminPool.query(`ALTER ROLE semprec_side WITH PASSWORD '${TEST_ROLE_PASSWORD}'`);
    dataPool = new Pool({ connectionString: roleConnectionString("semprec_data") });
    sidePool = new Pool({ connectionString: roleConnectionString("semprec_side") });
  });

  afterAll(async () => {
    await dataPool?.end();
    await sidePool?.end();
    await adminPool?.end();
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
  });

  describe("semprec_side", () => {
    it.each(IDENTITY_TABLES)("can SELECT %s", async (table) => {
      await expect(sidePool.query(`SELECT * FROM ${table} LIMIT 1`)).resolves.toBeDefined();
    });

    it.each(IDENTITY_TABLES)("cannot INSERT, UPDATE or DELETE %s", async (table) => {
      // Privilege checks run before row and constraint checks, so the statements need no valid values.
      await expect(sidePool.query(`INSERT INTO ${table} DEFAULT VALUES`)).rejects.toThrow(/permission denied/);
      await expect(sidePool.query(`UPDATE ${table} SET id = id WHERE false`)).rejects.toThrow(/permission denied/);
      await expect(sidePool.query(`DELETE FROM ${table} WHERE false`)).rejects.toThrow(/permission denied/);
    });
  });

  describe("semprec_data", () => {
    it("runs the real auth flows against the identity tables", async () => {
      const user = await bootstrapFirstAccount(dataPool, SETUP_TOKEN, SETUP_TOKEN, {
        email: "owner@example.test",
        password: PASSWORD,
      });

      const result = await login(dataPool, {
        email: user.email,
        password: PASSWORD,
        platform: "web",
        ip: "203.0.113.7",
      });
      const attempts = await adminPool.query<{ succeeded: boolean }>(`SELECT succeeded FROM login_attempts`);
      expect(attempts.rows).toEqual([{ succeeded: true }]);

      const before = result.session.lastSeenAt;
      const identity = await verifySessionToken(dataPool, result.token);
      expect(identity.session.id).toBe(result.session.id);
      const touched = await adminPool.query<{ last_seen_at: Date }>(`SELECT last_seen_at FROM sessions WHERE id = $1`, [
        result.session.id,
      ]);
      expect(touched.rows[0]!.last_seen_at.getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());

      await logout(dataPool, result.session.id);
      await expect(verifySessionToken(dataPool, result.token)).rejects.toBeInstanceOf(UnauthorizedError);

      const mailer = fakeMailer();
      await requestPasswordReset(dataPool, mailer, { email: user.email, appBaseUrl: "https://app.example.test" });
      await expect.poll(() => mailer.sent.length).toBe(1);
      const token = new URL(mailer.sent[0]!.resetUrl).searchParams.get("token");
      expect(token).toBeTruthy();

      await withTransaction(dataPool, (client) =>
        resetPassword(client, { token: token!, newPassword: "n3w-password-ok" }),
      );
      const relogin = await login(dataPool, {
        email: user.email,
        password: "n3w-password-ok",
        platform: "web",
        ip: "203.0.113.7",
      });
      expect(relogin.user.id).toBe(user.id);
    });

    it("records a failed login attempt, which needs the inherited sequence access", async () => {
      await bootstrapFirstAccount(dataPool, SETUP_TOKEN, SETUP_TOKEN, {
        email: "owner@example.test",
        password: PASSWORD,
      });

      await expect(
        login(dataPool, {
          email: "owner@example.test",
          password: "wrong-password",
          platform: "web",
          ip: "203.0.113.8",
        }),
      ).rejects.toBeInstanceOf(UnauthorizedError);

      const attempts = await adminPool.query<{ succeeded: boolean }>(`SELECT succeeded FROM login_attempts`);
      expect(attempts.rows).toEqual([{ succeeded: false }]);
    });

    it("holds DML on every identity table directly, not through semprec_side", async () => {
      const client = await adminPool.connect();
      try {
        await client.query("BEGIN");
        await client.query("REVOKE semprec_side FROM semprec_data");
        for (const table of IDENTITY_TABLES) {
          for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
            const { rows } = await client.query<{ granted: boolean }>(
              `SELECT has_table_privilege('semprec_data', $1, $2) AS granted`,
              [table, privilege],
            );
            expect(`${table}:${privilege}:${rows[0]?.granted}`).toBe(`${table}:${privilege}:true`);
          }
        }
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });
  });
});
