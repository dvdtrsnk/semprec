import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { runAsSystem } from "@semprec/shared";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { withTransaction } from "../db/pool.js";
import { ChokePointError, NotFoundError, ValidationError } from "../errors.js";
import { createUser } from "../auth/usersStore.js";
import { hashToken } from "../auth/token.js";
import { createInvite, INVITE_TTL_SECONDS, listInvites, revokeInvite, type CreatedInvite } from "../tenancy/invites.js";
import type { InviteMailer, SendInviteEmailInput } from "../tenancy/inviteMail.js";

const APP_BASE_URL = "https://app.example.test";

interface InviteRow {
  id: string;
  email: string;
  token_hash: string;
  invited_by: string | null;
  created_at: Date;
  expires_at: Date;
  accepted_at: Date | null;
  revoked_at: Date | null;
}

/** A mailer that records every call; `failWith` makes it reject instead. */
function recordingMailer(failWith?: Error): InviteMailer & { calls: SendInviteEmailInput[] } {
  const calls: SendInviteEmailInput[] = [];
  return {
    calls,
    async sendInviteEmail(input) {
      calls.push(input);
      if (failWith) throw failWith;
    },
  };
}

/** The raw token from an invite URL's fragment. */
function tokenFromUrl(inviteUrl: string): string {
  const token = new URL(inviteUrl).hash.replace("#token=", "");
  if (token.length === 0) throw new Error(`no token in ${inviteUrl}`);
  return token;
}

describe("invites (issue #1040)", () => {
  let pool: Pool;
  let dataPool: Pool;
  let sidePool: Pool;
  let inviterId: string;

  beforeAll(async () => {
    pool = getTestPool();
    dataPool = await createRuntimeRolePool(pool, "semprec_data");
    sidePool = await createRuntimeRolePool(pool, "semprec_side");
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    const tenantId = await createTestTenant(pool);
    inviterId = (await createUser(pool, { email: "admin@example.test", passwordHash: "x", tenantId, role: "admin" }))
      .id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await dataPool.end();
    await sidePool.end();
  });

  function invite(email: string, mailer: InviteMailer | null = null): Promise<CreatedInvite> {
    return runAsSystem("invitesTest", () =>
      withTransaction(dataPool, (client) =>
        createInvite(client, { email, invitedBy: inviterId, appBaseUrl: APP_BASE_URL, mailer }),
      ),
    );
  }

  async function rows(): Promise<InviteRow[]> {
    const result = await pool.query<InviteRow>(
      "SELECT id, email, token_hash, invited_by, created_at, expires_at, accepted_at, revoked_at FROM invites ORDER BY created_at, id",
    );
    return result.rows;
  }

  it("normalizes the email, stores only the token hash and expires seven days after creation", async () => {
    const created = await invite(" New@Example.COM ");

    expect(created.invite.email).toBe("new@example.com");
    expect(created.invite.status).toBe("pending");
    expect(created.invite.invitedBy).toBe(inviterId);
    const lifetimeMs = Date.parse(created.invite.expiresAt) - Date.parse(created.invite.createdAt);
    expect(lifetimeMs).toBe(INVITE_TTL_SECONDS * 1000);
    expect(created.inviteUrl).toMatch(/^https:\/\/app\.example\.test\/\?page=invite#token=[A-Za-z0-9_-]+$/);

    const token = tokenFromUrl(created.inviteUrl);
    const [row] = await rows();
    expect(row?.token_hash).toBe(hashToken(token));
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it("sends the mail once after commit with the normalized address and the same URL", async () => {
    const mailer = recordingMailer();
    const created = await invite("New@Example.com", mailer);

    expect(mailer.calls).toEqual([
      { to: "new@example.com", inviteUrl: created.inviteUrl, expiresAt: created.invite.expiresAt },
    ]);
  });

  it("sends nothing when no mailer is configured", async () => {
    const created = await invite("new@example.com", null);
    expect(created.invite.status).toBe("pending");
    expect(await rows()).toHaveLength(1);
  });

  it("sends nothing and writes no row when the email is malformed", async () => {
    const mailer = recordingMailer();
    const attempt = invite("not-an-email", mailer);

    await expect(attempt).rejects.toBeInstanceOf(ValidationError);
    await expect(attempt).rejects.toMatchObject({ details: { field: "email" } });
    expect(mailer.calls).toEqual([]);
    expect(await rows()).toEqual([]);
  });

  it("refuses an email that already belongs to an account, with no row and no mail", async () => {
    const tenantId = await createTestTenant(pool);
    await createUser(pool, { email: "taken@example.com", passwordHash: "x", tenantId, role: "member" });
    const mailer = recordingMailer();

    const attempt = invite("Taken@Example.com", mailer);

    await expect(attempt).rejects.toBeInstanceOf(ValidationError);
    await expect(attempt).rejects.toMatchObject({ details: { field: "email" } });
    expect(mailer.calls).toEqual([]);
    expect(await rows()).toEqual([]);
  });

  it("revokes the earlier pending invite when a second one is created for the same email", async () => {
    const first = await invite("new@example.com");
    const second = await invite("NEW@example.com");

    const byId = new Map((await listInvites(pool)).map((summary) => [summary.id, summary.status]));
    expect(byId.get(first.invite.id)).toBe("revoked");
    expect(byId.get(second.invite.id)).toBe("pending");
  });

  it("does not hold a mail send back when the mailer rejects, and logs neither the token nor the URL", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const mailer = recordingMailer(new Error("SMTP refused the connection"));

    const created = await invite("new@example.com", mailer);

    await vi.waitFor(() => expect(errorSpy).toHaveBeenCalled());
    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged).toContain(created.invite.id);
    expect(logged).not.toContain(tokenFromUrl(created.inviteUrl));
    expect(logged).not.toContain(created.inviteUrl);
  });

  it("reports each invite's status from its timestamps, in precedence order, without any token", async () => {
    const pending = await invite("pending@example.com");
    const accepted = await invite("accepted@example.com");
    const revoked = await invite("revoked@example.com");
    const expired = await invite("expired@example.com");
    await pool.query("UPDATE invites SET accepted_at = now() WHERE id = $1", [accepted.invite.id]);
    await pool.query("UPDATE invites SET revoked_at = now() WHERE id = $1", [revoked.invite.id]);
    await pool.query("UPDATE invites SET expires_at = now() - interval '1 second' WHERE id = $1", [expired.invite.id]);

    const summaries = await listInvites(pool);
    const statusById = new Map(summaries.map((summary) => [summary.id, summary.status]));
    expect(statusById.get(pending.invite.id)).toBe("pending");
    expect(statusById.get(accepted.invite.id)).toBe("accepted");
    expect(statusById.get(revoked.invite.id)).toBe("revoked");
    expect(statusById.get(expired.invite.id)).toBe("expired");
    expect(JSON.stringify(summaries)).not.toContain("token_hash");
  });

  it("revokes a pending invite and refuses an accepted, revoked or expired one with invite_not_pending", async () => {
    const pending = await invite("pending@example.com");
    const accepted = await invite("accepted@example.com");
    const expired = await invite("expired@example.com");
    await pool.query("UPDATE invites SET accepted_at = now() WHERE id = $1", [accepted.invite.id]);
    await pool.query("UPDATE invites SET expires_at = now() - interval '1 second' WHERE id = $1", [expired.invite.id]);

    const revoked = await withTransaction(dataPool, (client) => revokeInvite(client, pending.invite.id));
    expect(revoked.status).toBe("revoked");
    expect(revoked.revokedAt).not.toBeNull();

    for (const id of [accepted.invite.id, expired.invite.id, pending.invite.id]) {
      const attempt = withTransaction(dataPool, (client) => revokeInvite(client, id));
      await expect(attempt).rejects.toBeInstanceOf(ChokePointError);
      await expect(attempt).rejects.toMatchObject({ status: 409, code: "invite_not_pending" });
    }
  });

  it("answers NotFoundError for an unknown invite id", async () => {
    const attempt = withTransaction(dataPool, (client) => revokeInvite(client, "00000000-0000-0000-0000-000000000000"));
    await expect(attempt).rejects.toBeInstanceOf(NotFoundError);
  });

  it("refuses INSERT into invites from semprec_side", async () => {
    await expect(
      sidePool.query(
        "INSERT INTO invites (email, token_hash, expires_at) VALUES ('x@example.com', 'hash', now() + interval '1 day')",
      ),
    ).rejects.toThrow(/permission denied/);
  });
});
