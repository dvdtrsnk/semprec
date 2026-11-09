import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { ChokePointError } from "@semprec/data";
import { runInTenant, type GenericApplicationPort } from "@semprec/shared";
import { authenticateRequest } from "./authHandler.js";
import { dispatchGenericOperation, restActor } from "./adapter/genericBinding.js";
import { statusForError, toErrorResponseBody } from "./adapter/errorContract.js";
import { NO_STORE, sendJson } from "./adapter/http.js";
import { assertUuid } from "./adapter/requestValidation.js";
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
