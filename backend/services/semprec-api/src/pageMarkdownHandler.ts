import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { ChokePointError, ValidationError } from "@semprec/data";
import type { GenericOperationGateway } from "@semprec/application";
import { runInTenant, type CapabilityId, type GenericApplicationPort } from "@semprec/shared";
import { authenticateRequest } from "./authHandler.js";
import { dispatchGenericOperation, restActor } from "./adapter/genericBinding.js";
import { statusForError, toErrorResponseBody } from "./adapter/errorContract.js";
import { extractBearerToken, NO_STORE, PayloadTooLargeError, readJsonBody, sendJson } from "./adapter/http.js";
import { assertUuid, requireJsonObjectBody } from "./adapter/requestValidation.js";
import { resolveRunCredentialCaller } from "./mcp/callerActor.js";
import { logger } from "./logger.js";

const PAGE_MARKDOWN_PATH = /^\/api\/items\/([^/]+)\/page\.md$/;

/** Whether `pathname` is `/api/items/:id/page.md`; `app.ts` routes only a `GET` of it here. */
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
      const bearerToken = extractBearerToken(req);
      const credentialCaller =
        bearerToken === null ? null : await resolveRunCredentialCaller(pool, bearerToken, grantedCapabilities);
      const identity = credentialCaller === null ? await authenticateRequest(pool, req) : null;
      const tenantId = credentialCaller?.tenantId ?? identity?.tenantId;
      if (tenantId === undefined) throw new Error("A caller resolved without a tenant");
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
        const userId = identity?.user.id;
        if (userId === undefined) throw new Error("A session caller resolved without a user");
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
