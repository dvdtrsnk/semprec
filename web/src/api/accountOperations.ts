import { z } from "zod";
import { OperationError } from "./genericOperations.js";

/**
 * The client's binding for the caller's own account under `/api/account/*` (issue #1083): the
 * export request and list, the download link and self-deletion with password re-authentication.
 * Every call goes out as a same-origin fetch, so the browser carries the session cookie.
 */

const EXPORT_STATUSES = ["pending", "running", "ready", "failed"] as const;
export type TenantExportStatus = (typeof EXPORT_STATUSES)[number];

const tenantExportSchema = z.object({
  id: z.string(),
  status: z.enum(EXPORT_STATUSES),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  byteSize: z.number().nullable(),
});

export type TenantExport = z.infer<typeof tenantExportSchema>;

const exportResponseSchema = z.object({ export: tenantExportSchema });

const exportsResponseSchema = z.object({ exports: z.array(tenantExportSchema) });

const deletingResponseSchema = z.object({ status: z.literal("deleting") });

const errorCodeSchema = z.object({ error: z.object({ code: z.string() }) });

/** Enough for any error envelope the account routes answer; a longer failure body is not read further. */
const ERROR_BODY_LIMIT_BYTES = 8 * 1024;

/** Statuses that answer "this resource or plane is not here for you", so a retry only repeats the answer. */
const UNAVAILABLE_STATUSES = new Set([401, 403, 404, 501]);

export interface AccountOperationsOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

export interface AccountOperations {
  listExports(): Promise<TenantExport[]>;
  /** Resolves the export that was created (202) or the one already pending or running (200). */
  requestExport(): Promise<TenantExport>;
  /** The URL the browser follows to download an export; it makes no request itself. */
  exportDownloadUrl(exportId: string): string;
  /** Resolves once the server accepts the deletion (202); the session is revoked from then on. */
  deleteAccount(password: string): Promise<void>;
}

export function createAccountOperations(options: AccountOperationsOptions): AccountOperations {
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
    async listExports() {
      const body = await request("/account/exports");
      return parseBody(exportsResponseSchema, body, "/account/exports").exports;
    },

    async requestExport() {
      const body = await request("/account/exports", { method: "POST" });
      return parseBody(exportResponseSchema, body, "/account/exports").export;
    },

    exportDownloadUrl(exportId) {
      return `${baseUrl}/account/exports/${encodeURIComponent(exportId)}/download`;
    },

    async deleteAccount(password) {
      const body = await request("/account/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      parseBody(deletingResponseSchema, body, "/account/delete");
    },
  };
}

/**
 * A non-2xx answer. The message is the server's `error.code` (for example `last_admin`) when the
 * body carries one, so the page can name the refusal; otherwise it names the path and status.
 */
async function failure(path: string, response: Response): Promise<OperationError> {
  const code = await readErrorCode(response);
  return new OperationError(
    UNAVAILABLE_STATUSES.has(response.status) ? "unavailable" : "retryable",
    code ?? `Request to ${path} failed with ${response.status}`,
    response.status,
  );
}

/** A success body that does not match the documented shape is a retryable failure, not a crash of the page. */
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
