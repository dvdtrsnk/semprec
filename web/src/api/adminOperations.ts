import { z } from "zod";
import { OperationError } from "./genericOperations.js";

/**
 * The client's binding for the admin plane under `/api/admin/*` (issue #1079): the account list
 * and the suspend, reactivate and role-change writes. Each route is an adapter route the backend
 * flags `admin: true`, so a member gets a 403 `admin_required` and never sees these answers.
 * Later admin panels extend this interface rather than adding a second adapter.
 *
 * Every call goes out as a same-origin fetch, so the browser carries the session cookie.
 */

const ADMIN_ROLES = ["admin", "member"] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

const adminAccountSummarySchema = z.object({
  userId: z.string(),
  email: z.string(),
  role: z.enum(ADMIN_ROLES),
  status: z.enum(["provisioning", "active", "suspended", "deleting"]),
  createdAt: z.string(),
  lastSeenAt: z.string().nullable(),
});

export type AdminAccountSummary = z.infer<typeof adminAccountSummarySchema>;

const accountsResponseSchema = z.object({ accounts: z.array(adminAccountSummarySchema) });

const accountResponseSchema = z.object({ account: adminAccountSummarySchema });

const INVITE_STATUSES = ["pending", "accepted", "revoked", "expired"] as const;
export type InviteStatus = (typeof INVITE_STATUSES)[number];

const inviteSummarySchema = z.object({
  id: z.string(),
  email: z.string(),
  invitedBy: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
  acceptedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  status: z.enum(INVITE_STATUSES),
});

export type InviteSummary = z.infer<typeof inviteSummarySchema>;

const invitesResponseSchema = z.object({ invites: z.array(inviteSummarySchema) });

const createInviteResponseSchema = z.object({
  invite: inviteSummarySchema,
  inviteUrl: z.string(),
  emailed: z.boolean(),
});

export type CreatedInvite = z.infer<typeof createInviteResponseSchema>;

const inviteResponseSchema = z.object({ invite: inviteSummarySchema });

const errorCodeSchema = z.object({ error: z.object({ code: z.string() }) });

/** Enough for any error envelope the admin routes answer; a longer failure body is not read further. */
const ERROR_BODY_LIMIT_BYTES = 8 * 1024;

/** Statuses that answer "this resource or plane is not here for you", so a retry only repeats the answer. */
const UNAVAILABLE_STATUSES = new Set([401, 403, 404, 501]);

export interface AdminOperationsOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

export interface AdminOperations {
  listAccounts(): Promise<AdminAccountSummary[]>;
  suspendAccount(userId: string): Promise<AdminAccountSummary>;
  reactivateAccount(userId: string): Promise<AdminAccountSummary>;
  changeRole(userId: string, role: AdminRole): Promise<AdminAccountSummary>;
  listInvites(): Promise<InviteSummary[]>;
  createInvite(email: string): Promise<CreatedInvite>;
  revokeInvite(inviteId: string): Promise<InviteSummary>;
}

export function createAdminOperations(options: AdminOperationsOptions): AdminOperations {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);

  async function request(path: string, init?: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, { credentials: "same-origin", ...init });
    } catch (error) {
      throw new OperationError("retryable", error instanceof Error ? error.message : String(error));
    }

    if (!response.ok) {
      throw await failure(path, response);
    }

    try {
      return await response.json();
    } catch {
      throw unexpectedResponse(path);
    }
  }

  return {
    async listAccounts() {
      const body = await request("/admin/accounts");
      return parseBody(accountsResponseSchema, body, "/admin/accounts").accounts;
    },

    async suspendAccount(userId) {
      const path = `/admin/accounts/${encodeURIComponent(userId)}/suspend`;
      const body = await request(path, { method: "POST" });
      return parseBody(accountResponseSchema, body, path).account;
    },

    async reactivateAccount(userId) {
      const path = `/admin/accounts/${encodeURIComponent(userId)}/reactivate`;
      const body = await request(path, { method: "POST" });
      return parseBody(accountResponseSchema, body, path).account;
    },

    async changeRole(userId, role) {
      const path = `/admin/accounts/${encodeURIComponent(userId)}/role`;
      const body = await request(path, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      });
      return parseBody(accountResponseSchema, body, path).account;
    },

    async listInvites() {
      const body = await request("/admin/invites");
      return parseBody(invitesResponseSchema, body, "/admin/invites").invites;
    },

    async createInvite(email) {
      const body = await request("/admin/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      return parseBody(createInviteResponseSchema, body, "/admin/invites");
    },

    async revokeInvite(inviteId) {
      const path = `/admin/invites/${encodeURIComponent(inviteId)}/revoke`;
      const body = await request(path, { method: "POST" });
      return parseBody(inviteResponseSchema, body, path).invite;
    },
  };
}

/**
 * A non-2xx answer. The message is the server's `error.code` (for example `last_admin`) when the
 * body carries one, so the panel can name the refusal; otherwise it names the path and status.
 * The body is read here once, and a body that is not JSON simply has no code.
 */
async function failure(path: string, response: Response): Promise<OperationError> {
  const code = await readErrorCode(response);
  return new OperationError(
    UNAVAILABLE_STATUSES.has(response.status) ? "unavailable" : "retryable",
    code ?? `Request to ${path} failed with ${response.status}`,
    response.status,
  );
}

/** A success body that does not match the documented shape is a retryable failure, not a crash of the panel. */
function parseBody<T extends z.ZodType>(schema: T, body: unknown, path: string): z.infer<T> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw unexpectedResponse(path);
  return parsed.data;
}

function unexpectedResponse(path: string): OperationError {
  return new OperationError("retryable", `Unexpected response from ${path}`);
}

async function readErrorCode(response: Response): Promise<string | null> {
  const text = await readBoundedText(response, ERROR_BODY_LIMIT_BYTES);
  if (text === null) return null;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = errorCodeSchema.safeParse(body);
  return parsed.success ? parsed.data.error.code : null;
}

/**
 * Reads at most `limit` bytes of a body as text, cancelling the stream past the limit. Resolves
 * `null` when the body is longer than the limit or cannot be read, so the caller falls back to the
 * status-based message instead of buffering an arbitrarily large failure body.
 */
async function readBoundedText(response: Response, limit: number): Promise<string | null> {
  if (response.body === null) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      received += value.byteLength;
      if (received > limit) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    return null;
  }
}
