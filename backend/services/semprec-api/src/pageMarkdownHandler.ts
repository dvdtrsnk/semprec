import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { ChokePointError, PageVersionConflictError, ValidationError } from "@semprec/data";
import type { GenericOperationGateway } from "@semprec/application";
import { runInTenant, type CapabilityId, type GenericApplicationPort } from "@semprec/shared";
import { authenticateRequest } from "./authHandler.js";
import { dispatchGenericOperation, restActor } from "./adapter/genericBinding.js";
import { statusForError, toErrorResponseBody } from "./adapter/errorContract.js";
import {
  extractBearerToken,
  NO_STORE,
  PayloadTooLargeError,
  readJsonBody,
  readRawBody,
  sendJson,
} from "./adapter/http.js";
import { assertUuid, requireJsonObjectBody } from "./adapter/requestValidation.js";
import { resolveRunCredentialCaller, type RunCredentialCaller } from "./mcp/callerActor.js";
import { logger } from "./logger.js";

const PAGE_MARKDOWN_PATH = /^\/api\/items\/([^/]+)\/page\.md$/;

/** `app.ts` routes only `GET` and `PUT` of it here. */
export function isPageMarkdownPath(pathname: string): boolean {
  return PAGE_MARKDOWN_PATH.test(pathname);
}

/**
 * Canonical Markdown with a strong `ETag` that is its content version. A bespoke listener because
 * the body is `text/markdown`, not a JSON envelope. Dispatches `page.get` with `format:
 * "markdown"`, so REST, MCP and agents share one implementation. The item is resolved in the
 * caller's tenant first, so a foreign item answers like an unknown one, and no conditional-request
 * branch exists to tell them apart.
 */
export function createPageMarkdownRequestListener(pool: Pool, service: GenericApplicationPort) {
  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      const identity = await authenticateRequest(pool, req);
      const page = await runInTenant(identity.tenantId, async () => {
        const match = PAGE_MARKDOWN_PATH.exec(url.pathname);
        // Group 1 of PAGE_MARKDOWN_PATH is not optional.
        const itemId = assertUuid(match?.[1] ?? "", "id");
        return dispatchGenericOperation(service, "page.get", restActor(identity.user.id), {
          itemId,
          format: "markdown",
        });
      });
      if (!("markdown" in page)) throw new Error("page.get answered a summary for the markdown format");
      res.writeHead(200, {
        "Content-Type": "text/markdown; charset=utf-8",
        ETag: `"${page.etag}"`,
        "Cache-Control": NO_STORE,
        "X-Content-Type-Options": "nosniff",
      });
      res.end(page.markdown);
    } catch (err) {
      if (err instanceof ChokePointError) {
        sendJson(res, statusForError(err), toErrorResponseBody(err));
        return;
      }
      logger.error({ err, method: req.method, path: url.pathname }, "Unexpected error handling request");
      sendJson(res, 500, { error: { code: "internal_error" } });
    }
  }

  return function handleRequestSafely(req: IncomingMessage, res: ServerResponse): void {
    handleRequest(req, res).catch((err: unknown) => {
      logger.error({ err }, "Unhandled error in the request listener");
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, 500, { error: { code: "internal_error" } });
    });
  };
}

/** `userId` is the user the request acts for. */
interface PageWriteCaller {
  tenantId: string;
  credentialCaller: RunCredentialCaller | null;
  userId: string;
}

/**
 * An MCP run credential presented as a bearer token, else the session. The tenant comes from the
 * credential or the session only.
 */
async function resolvePageWriteCaller(
  pool: Pool,
  req: IncomingMessage,
  grantedCapabilities: ReadonlySet<CapabilityId>,
): Promise<PageWriteCaller> {
  const bearerToken = extractBearerToken(req);
  const credentialCaller =
    bearerToken === null ? null : await resolveRunCredentialCaller(pool, bearerToken, grantedCapabilities);
  if (credentialCaller !== null) {
    return { tenantId: credentialCaller.tenantId, credentialCaller, userId: credentialCaller.actor.userId };
  }
  const identity = await authenticateRequest(pool, req);
  return { tenantId: identity.tenantId, credentialCaller: null, userId: identity.user.id };
}

const PAGE_INSERT_PATH = /^\/api\/items\/([^/]+)\/page\/insert$/;

/** The same cap as the JSON adapter's. */
const MAX_INSERT_BODY_BYTES = 1 * 1024 * 1024;

/** `app.ts` routes only a `POST` of it here. */
export function isPageInsertPath(pathname: string): boolean {
  return PAGE_INSERT_PATH.test(pathname);
}

/**
 * A bespoke listener because it accepts two kinds of caller:
 * - an MCP run credential (resolved by `resolveRunCredentialCaller`, as for `/mcp`), written
 * through `GenericOperationGateway.invoke` with the credential's capabilities: an ungranted
 * operation answers like an unknown one (404) and the update is authored `ai_agent`;
 * - anything else authenticated like every adapter route and dispatched as a person, authored
 * `user`.
 * The body is capped and strictly checked, and errors use the adapter's closed error contract.
 */
export function createPageInsertRequestListener(
  pool: Pool,
  service: GenericApplicationPort,
  gateway: GenericOperationGateway,
  grantedCapabilities: ReadonlySet<CapabilityId>,
) {
  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      const { credentialCaller, userId, tenantId } = await resolvePageWriteCaller(pool, req, grantedCapabilities);
      const inserted = await runInTenant(tenantId, async () => {
        const body = requireJsonObjectBody(await readJsonBody(req, { maxBytes: MAX_INSERT_BODY_BYTES }));
        const unexpected = Object.keys(body).find((key) => !["placement", "markdown", "blockIds"].includes(key));
        if (unexpected !== undefined) throw new ValidationError("Unexpected insert field", { field: unexpected });
        // Group 1 of PAGE_INSERT_PATH is not optional.
        const itemId = assertUuid(PAGE_INSERT_PATH.exec(url.pathname)?.[1] ?? "", "id");
        const input = { itemId, placement: body.placement, markdown: body.markdown, blockIds: body.blockIds };
        if (credentialCaller !== null) {
          return gateway.invoke("page.insert", credentialCaller.actor, credentialCaller.capabilities, input);
        }
        return dispatchGenericOperation(service, "page.insert", restActor(userId), input);
      });
      sendJson(res, 200, inserted);
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        sendJson(res, 413, { error: { code: "payload_too_large" } });
        return;
      }
      if (err instanceof ChokePointError) {
        sendJson(res, statusForError(err), toErrorResponseBody(err));
        return;
      }
      logger.error({ err, method: req.method, path: url.pathname }, "Unexpected error handling request");
      sendJson(res, 500, { error: { code: "internal_error" } });
    }
  }

  return function handleRequestSafely(req: IncomingMessage, res: ServerResponse): void {
    handleRequest(req, res).catch((err: unknown) => {
      logger.error({ err }, "Unhandled error in the request listener");
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, 500, { error: { code: "internal_error" } });
    });
  };
}

/** The same cap as an insert's. */
const MAX_REPLACE_BODY_BYTES = 1 * 1024 * 1024;

/** The one strong entity-tag form `GET /api/items/:id/page.md` sends; the token is base64url. */
const STRONG_ETAG = /^"([A-Za-z0-9_-]+)"$/;

/**
 * `null` when absent. Anything but one quoted strong entity-tag (a weak tag, a list, `*`, an
 * unquoted token) is a `ValidationError` on `If-Match`.
 */
function ifMatchEtag(req: IncomingMessage): string | null {
  const header = req.headers["if-match"];
  if (header === undefined) return null;
  const token = STRONG_ETAG.exec(header)?.[1];
  if (token === undefined) throw new ValidationError("If-Match must be one quoted ETag", { field: "If-Match" });
  return token;
}

/** Must be declared `text/markdown`, in UTF-8 when it names a charset. */
async function readMarkdownBody(req: IncomingMessage): Promise<string> {
  const [mediaType = "", ...parameters] = (req.headers["content-type"] ?? "").split(";").map((part) => part.trim());
  const charset = parameters.map((part) => /^charset=(.*)$/i.exec(part)?.[1]).find((value) => value !== undefined);
  if (
    mediaType.toLowerCase() !== "text/markdown" ||
    (charset !== undefined && charset.replaceAll('"', "").toLowerCase() !== "utf-8")
  ) {
    throw new ValidationError("The body must be text/markdown in UTF-8", { field: "Content-Type" });
  }
  const raw = await readRawBody(req, { maxBytes: MAX_REPLACE_BODY_BYTES });
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    throw new ValidationError("The body is not valid UTF-8", { field: "body" });
  }
}

/**
 * Requires `If-Match` with the current `ETag`: missing is 428, stale is 409 with the current `ETag`
 * header; success is 200 with the new `ETag` and `{ trashedPages }` (subpages the new Markdown no
 * longer links). Callers are resolved as in `createPageInsertRequestListener`. A run credential's
 * replace is held for approval (403 `approval_required`, nothing written) and the approved request
 * is replayed authored `user`; one without `core.item.write` answers like an unknown operation
 * (404). The tenant is resolved before the item, so a foreign item answers like an unknown one, and
 * `If-Match` is checked without reading the item.
 */
export function createPageReplaceRequestListener(
  pool: Pool,
  service: GenericApplicationPort,
  gateway: GenericOperationGateway,
  grantedCapabilities: ReadonlySet<CapabilityId>,
) {
  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      const { credentialCaller, userId, tenantId } = await resolvePageWriteCaller(pool, req, grantedCapabilities);
      const expectedEtag = ifMatchEtag(req);
      if (expectedEtag === null) {
        sendJson(res, 428, { error: { code: "precondition_required" } });
        return;
      }
      const replaced = await runInTenant(tenantId, async () => {
        // Group 1 of PAGE_MARKDOWN_PATH is not optional.
        const itemId = assertUuid(PAGE_MARKDOWN_PATH.exec(url.pathname)?.[1] ?? "", "id");
        const input = { itemId, markdown: await readMarkdownBody(req), expectedEtag };
        if (credentialCaller !== null) {
          return gateway.invoke("page.replace", credentialCaller.actor, credentialCaller.capabilities, input);
        }
        return dispatchGenericOperation(service, "page.replace", restActor(userId), input);
      });
      sendJson(res, 200, { trashedPages: replaced.trashedPages }, { ETag: `"${replaced.etag}"` });
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        sendJson(res, 413, { error: { code: "payload_too_large" } });
        return;
      }
      if (err instanceof PageVersionConflictError) {
        sendJson(res, statusForError(err), toErrorResponseBody(err), { ETag: `"${err.currentEtag}"` });
        return;
      }
      if (err instanceof ChokePointError) {
        sendJson(res, statusForError(err), toErrorResponseBody(err));
        return;
      }
      logger.error({ err, method: req.method, path: url.pathname }, "Unexpected error handling request");
      sendJson(res, 500, { error: { code: "internal_error" } });
    }
  }

  return function handleRequestSafely(req: IncomingMessage, res: ServerResponse): void {
    handleRequest(req, res).catch((err: unknown) => {
      logger.error({ err }, "Unhandled error in the request listener");
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, 500, { error: { code: "internal_error" } });
    });
  };
}
