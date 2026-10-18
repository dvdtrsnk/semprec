import type { PoolClient } from "pg";
import { EMAIL_PATTERN } from "../auth/authActions.js";
import { normalizeEmail } from "../auth/emailNormalization.js";
import { generateOpaqueToken } from "../auth/token.js";
import { runAfterCommit, type Queryable } from "../db/pool.js";
import { ChokePointError, NotFoundError, ValidationError } from "../errors.js";
import { assertKnownValue } from "../dbRowValidation.js";
import type { InviteMailer } from "./inviteMail.js";
import { describeMailFailure } from "../mail/describeMailFailure.js";
import { logger } from "./logger.js";

/**
 * Admin-issued account invitations (issue #1040). Only the token's hash is stored, as for
 * password-reset tokens. The raw token leaves the server once, inside `inviteUrl` and the mail.
 * Accepting an invitation is issue #1087's concern; this module never sets `accepted_at`.
 */

/** A pending invitation expires seven days after it was created. */
export const INVITE_TTL_SECONDS = 7 * 24 * 60 * 60;

const INVITE_STATUSES = ["pending", "accepted", "revoked", "expired"] as const;

export type InviteStatus = (typeof INVITE_STATUSES)[number];

export interface InviteSummary {
  id: string;
  email: string;
  invitedBy: string | null;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  status: InviteStatus;
}

/**
 * Status is derived in SQL in precedence order: accepted, then revoked, then expired, then pending.
 * `expires_at > now()` is the same window `createInvite` uses when it revokes superseded invites.
 */
const INVITE_COLUMNS = `id, email, invited_by, created_at, expires_at, accepted_at, revoked_at,
       CASE
         WHEN accepted_at IS NOT NULL THEN 'accepted'
         WHEN revoked_at IS NOT NULL THEN 'revoked'
         WHEN expires_at <= now() THEN 'expired'
         ELSE 'pending'
       END AS status`;

interface InviteRow {
  id: string;
  email: string;
  invited_by: string | null;
  created_at: Date;
  expires_at: Date;
  accepted_at: Date | null;
  revoked_at: Date | null;
  status: string;
}

function toInviteSummary(row: InviteRow): InviteSummary {
  return {
    id: row.id,
    email: row.email,
    invitedBy: row.invited_by,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    acceptedAt: row.accepted_at ? row.accepted_at.toISOString() : null,
    revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
    status: assertKnownValue(INVITE_STATUSES, row.status, "invites.status"),
  };
}

/**
 * The link is built on the fragment, which browsers never send to the server, so the token stays out
 * of Caddy's access log. `appBaseUrl` contributes only its origin.
 */
export function buildInviteUrl(appBaseUrl: string, token: string): string {
  return `${new URL(appBaseUrl).origin}/?page=invite#token=${token}`;
}

export interface CreateInviteInput {
  email: string;
  invitedBy: string;
  /** Origin the invite link is built against, e.g. `https://app.semprec.example`. */
  appBaseUrl: string;
  /** `null` when SMTP is not configured: the invite is created and the link is returned, but no mail is sent. */
  mailer: InviteMailer | null;
}

export interface CreatedInvite {
  invite: InviteSummary;
  inviteUrl: string;
}

/**
 * Creates a pending invitation and supersedes every earlier pending one for the same address. The
 * per-address advisory lock serializes concurrent `createInvite` calls for one address, so the
 * superseding update and the insert cannot interleave with another invite for it. The lock does not
 * serialize against user creation, which never takes it: the existing-account check refuses an address
 * that already had an account when it ran, and accepting an invitation (#1087) must check again. The
 * mail is dispatched from `runAfterCommit`, so a rolled-back transaction sends nothing.
 */
export async function createInvite(client: PoolClient, input: CreateInviteInput): Promise<CreatedInvite> {
  const email = normalizeEmail(input.email);
  if (!EMAIL_PATTERN.test(email)) {
    throw new ValidationError("'email' must be a valid email address", { field: "email" });
  }

  await client.query("SELECT pg_advisory_xact_lock(hashtext('semprec_invite:' || $1))", [email]);
  const { rows: existingUsers } = await client.query<{ found: number }>(
    "SELECT 1 AS found FROM users WHERE email = $1",
    [email],
  );
  if (existingUsers.length > 0) {
    throw new ValidationError("'email' already belongs to an account", { field: "email" });
  }

  await client.query(
    `UPDATE invites SET revoked_at = now()
      WHERE email = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()`,
    [email],
  );

  const { token, tokenHash } = generateOpaqueToken();
  const { rows } = await client.query<InviteRow>(
    `INSERT INTO invites (email, token_hash, invited_by, expires_at)
     VALUES ($1, $2, $3, now() + ($4::int * interval '1 second'))
     RETURNING ${INVITE_COLUMNS}`,
    [email, tokenHash, input.invitedBy, INVITE_TTL_SECONDS],
  );
  const invite = toInviteSummary(rows[0]!);
  const inviteUrl = buildInviteUrl(input.appBaseUrl, token);

  const mailer = input.mailer;
  if (mailer) {
    runAfterCommit(client, () => {
      void mailer
        .sendInviteEmail({ to: invite.email, inviteUrl, expiresAt: invite.expiresAt })
        .catch((err: unknown) => {
          logger.error(
            { inviteId: invite.id, ...describeMailFailure(err) },
            "createInvite: failed to send the invitation email",
          );
        });
    });
  }

  return { invite, inviteUrl };
}

/** Every invitation, newest first. Never selects `token_hash`. */
export async function listInvites(client: Queryable): Promise<InviteSummary[]> {
  const { rows } = await client.query<InviteRow>(
    `SELECT ${INVITE_COLUMNS} FROM invites ORDER BY created_at DESC, id DESC`,
  );
  return rows.map(toInviteSummary);
}

/**
 * Revokes one pending invitation with a single conditional update. When it matches no row, a missing
 * id is `NotFoundError`; an accepted, revoked or expired invitation is `invite_not_pending` (409), so
 * the caller learns why nothing changed.
 */
export async function revokeInvite(client: PoolClient, inviteId: string): Promise<InviteSummary> {
  const result = await client.query<InviteRow>(
    `UPDATE invites SET revoked_at = now()
      WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
      RETURNING ${INVITE_COLUMNS}`,
    [inviteId],
  );
  const row = result.rows[0];
  if (result.rowCount === 1 && row) return toInviteSummary(row);

  const { rows: existing } = await client.query<{ id: string }>("SELECT id FROM invites WHERE id = $1", [inviteId]);
  if (existing.length === 0) throw new NotFoundError("Invite not found", { inviteId });
  throw new ChokePointError(409, "invite_not_pending", "Only a pending invite can be revoked");
}
