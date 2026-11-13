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

/** Whether `pathname` is `/api/items/:id/page.md`; `app.ts` routes only a `GET` of it to the read and a `PUT` of it to the replace. */
export function isPageMarkdownPath(pathname: string): boolean {
  return PAGE_MARKDOWN_PATH.test(pathname);
}

/**
 * `GET /api/items/:id/page.md` (issue #1678): the page as canonical Markdown with a strong `ETag` that is its
 * content version. Like `blobsHandler.ts`, this cannot go through `createAdapterRequestListener`, because the
 * response body is `text/markdown` and not a JSON envelope, so it is a bespoke listener sharing the adapter's
 * authentication and error contract. The read is the `page.get` catalog operation with `format: "markdown"`, so REST,
 * MCP and agents reach one implementation. The item is resolved in the caller's tenant before anything else, so a
 * foreign item answers exactly like an unknown one, and no conditional-request branch exists to tell them apart.
 */
export function createPageMarkdownRequestListener(pool: Pool, service: GenericApplicationPort) {
  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      const identity = await authenticateRequest(pool, req);
      const page = await runInTenant(identity.tenantId, async () => {
        const match = PAGE_MARKDOWN_PATH.exec(url.pathname);
        // Group 1 of PAGE_MARKDOWN_PATH is not optional, so a successful match always captured it.
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

/** Who made a request to a page write route: a run credential's caller (`credentialCaller`), or else a session. `userId` is the user the request acts for. */
interface PageWriteCaller {
  tenantId: string;
  credentialCaller: RunCredentialCaller | null;
  userId: string;
}

/**
 * Resolves the caller of a page write route that accepts two kinds (docs/adr/2026-11-09-page-insert-authentication-reuses-scoped-run-callers.md):
 * an MCP run credential presented as a bearer token, else the session `authenticateRequest` resolves. The tenant comes
 * from the credential or the session only.
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

/** The request body cap, the same as the JSON adapter's. */
const MAX_INSERT_BODY_BYTES = 1 * 1024 * 1024;

/** Whether `pathname` is `/api/items/:id/page/insert`; `app.ts` routes only a `POST` of it here. */
export function isPageInsertPath(pathname: string): boolean {
  return PAGE_INSERT_PATH.test(pathname);
}

/**
 * `POST /api/items/:id/page/insert` (issue #1679): inserts Markdown into the page at a placement, dispatching the
 * `page.insert` catalog operation. The path is the one the issue's Task names (accepted ADR
 * 2026-10-28-page-operation-family says `/page/blocks`; see 2026-11-09-page-http-routes-and-subpage-paths-follow-delivery-contracts).
 * It is a bespoke listener because it accepts two kinds of caller (docs/adr/2026-11-09-page-insert-authentication-reuses-scoped-run-callers.md):
 *  - an MCP run credential presented as a bearer token, resolved by the same `resolveRunCredentialCaller` as `/mcp`:
 *    the write goes through `GenericOperationGateway.invoke` with the credential's capability set, so an operation
 *    the credential was not granted answers like an unknown one (404) and the stored update is authored `ai_agent`;
 *  - anything else is authenticated exactly as every adapter route is (`authenticateRequest`: the session cookie or a
 *    session bearer) and dispatched as a person, authored `user`.
 * The tenant comes from the credential or the session only, the body is capped and strictly checked, and errors use
 * the adapter's closed error contract.
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
        // Group 1 of PAGE_INSERT_PATH is not optional, so a successful match always captured it.
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

/** The request body cap of a replace, the same as an insert's. */
const MAX_REPLACE_BODY_BYTES = 1 * 1024 * 1024;

/** `"<token>"`: the one strong entity-tag form `GET /api/items/:id/page.md` sends, whose token is base64url. */
const STRONG_ETAG = /^"([A-Za-z0-9_-]+)"$/;

/**
 * The version token `If-Match` names, or `null` when the header is absent. A value that is not one quoted strong
 * entity-tag (a weak tag, a list, `*`, an unquoted token) is a `ValidationError` on `If-Match`.
 */
function ifMatchEtag(req: IncomingMessage): string | null {
  const header = req.headers["if-match"];
  if (header === undefined) return null;
  const token = STRONG_ETAG.exec(header)?.[1];
  if (token === undefined) throw new ValidationError("If-Match must be one quoted ETag", { field: "If-Match" });
  return token;
}

/** The request body as UTF-8 text, bounded by `MAX_REPLACE_BODY_BYTES`; the body must be declared `text/markdown`, in UTF-8 when it names a charset. */
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
 * `PUT /api/items/:id/page.md` (issue #1765): replaces the whole body of the page with the `text/markdown` request
 * body when `If-Match` carries the page's current `ETag` (the token `GET` sent), dispatching the `page.replace` catalog
 * operation. A missing `If-Match` is `428`; a token that is not the current one is `409` with the current `ETag` in the
 * response header; success is `200` with the new `ETag` and `{ trashedPages }`, the subpages the new Markdown no longer
 * links, which the operation sent to the trash. Authentication, tenant and error contract are the ones of
 * `createPageInsertRequestListener`: a run credential is passed to the gateway, anything else is a session (authored
 * `user`). A run credential's `page.replace` is held for approval: the gateway answers `403 approval_required`, writes
 * nothing and creates no `ai_agent` block, and the approved request is replayed authored `user` (issue #1844); a
 * credential without `core.item.write` is answered like an unknown operation (404). The tenant is resolved before
 * the item, so a foreign item answers like an unknown one, and `If-Match` is checked without reading the item.
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
        // Group 1 of PAGE_MARKDOWN_PATH is not optional, so a successful match always captured it.
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
