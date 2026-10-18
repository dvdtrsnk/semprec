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

export const ADMIN_ROLES = ["admin", "member"] as const;
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

const errorCodeSchema = z.object({ error: z.object({ code: z.string() }) });

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
    } catch (error) {
      throw new OperationError("retryable", error instanceof Error ? error.message : String(error));
    }
  }

  return {
    async listAccounts() {
      const body = await request("/admin/accounts");
      return parseBody(accountsResponseSchema, body).accounts;
    },

    async suspendAccount(userId) {
      const body = await request(`/admin/accounts/${encodeURIComponent(userId)}/suspend`, { method: "POST" });
      return parseBody(accountResponseSchema, body).account;
    },

    async reactivateAccount(userId) {
      const body = await request(`/admin/accounts/${encodeURIComponent(userId)}/reactivate`, { method: "POST" });
      return parseBody(accountResponseSchema, body).account;
    },

    async changeRole(userId, role) {
      const body = await request(`/admin/accounts/${encodeURIComponent(userId)}/role`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      });
      return parseBody(accountResponseSchema, body).account;
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
function parseBody<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new OperationError("retryable", parsed.error.message);
  return parsed.data;
}

async function readErrorCode(response: Response): Promise<string | null> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  const parsed = errorCodeSchema.safeParse(body);
  return parsed.success ? parsed.data.error.code : null;
}
