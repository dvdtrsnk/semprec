import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { runInTenant } from "@semprec/shared";
import { replayApprovedGenericOperation } from "@semprec/application";
import { createCoreTaskList } from "@semprec/data";
import { CORE_TASK_NAMES, runOnce } from "@semprec/queue";
import { PageHttpHarness } from "./pageHttpHarness.js";

const harness = new PageHttpHarness();

const pageBody = z.object({
  blocks: z.array(z.object({ id: z.string(), type: z.string(), pageId: z.string().optional() })),
});
const createdBody = z.object({
  pages: z.array(z.object({ pageItemId: z.string(), blockId: z.string() })).length(1),
});
const insertedBody = z.object({ blockIds: z.array(z.string()) });
const approvalRequiredBody = z.object({
  error: z.object({ code: z.literal(-32001), data: z.object({ approvalRequestId: z.string() }) }),
});

interface Subpage {
  pageItemId: string;
  blockId: string;
}

type Headers = { Authorization: string };

function call(method: string, path: string, headers: Headers, body?: unknown): Promise<Response> {
  return fetch(`${harness.baseUrl}${path}`, {
    method,
    headers: body === undefined ? headers : { ...headers, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function subpage(parent: string, title: string, afterBlockId?: string): Promise<Subpage> {
  const response = await call("POST", `/api/items/${parent}/page/subpages`, harness.headersA, { title, afterBlockId });
  expect(response.status, await response.clone().text()).toBe(201);
  const page = createdBody.parse(await response.json()).pages[0];
  if (!page) throw new Error("Missing page");
  return page;
}

/** The blocks of the notes of `itemId` as tenant A reads them, in document order. */
async function notesOf(itemId: string): Promise<Array<{ id: string; type: string; pageId?: string }>> {
  const response = await call("GET", `/api/items/${itemId}/page`, harness.headersA);
  expect(response.status).toBe(200);
  return pageBody.parse(await response.json()).blocks;
}

/** The status of `GET /api/items/:id` for each id, as tenant A. */
async function readStatuses(...itemIds: string[]): Promise<number[]> {
  const statuses: number[] = [];
  for (const itemId of itemIds) statuses.push((await call("GET", `/api/items/${itemId}`, harness.headersA)).status);
  return statuses;
}

/**
 * A host of tenant A whose notes read `Intro`, the page block of "Release checklist", `Outro`, with one page nested
 * under the checklist.
 */
async function hostWithNestedSubpage(): Promise<{
  host: string;
  intro: string;
  outro: string;
  checklist: Subpage;
  nested: Subpage;
}> {
  const host = await harness.createHost(harness.tenantA);
  const inserted = await call("POST", `/api/items/${host}/page/insert`, harness.headersA, {
    placement: "end",
    markdown: "Intro\n\nOutro",
  });
  expect(inserted.status, await inserted.clone().text()).toBe(200);
  const [intro, outro] = insertedBody.parse(await inserted.json()).blockIds;
  if (!intro || !outro) throw new Error("Missing inserted blocks");
  const checklist = await subpage(host, "Release checklist", intro);
  const nested = await subpage(checklist.pageItemId, "Notes for version 0.4");
  return { host, intro, outro, checklist, nested };
}

/** A response with its status and its body, where every occurrence of `itemId` is replaced by a placeholder. */
async function anonymized(response: Response, itemId: string): Promise<{ status: number; body: string }> {
  return { status: response.status, body: (await response.text()).replaceAll(itemId, "<id>") };
}

describe("trash and restore of a page with its subpages (issue #1723)", () => {
  beforeAll(() => harness.start());
  beforeEach(() => harness.reset());
  afterAll(() => harness.stop());

  it("hides a deleted subpage and its nested page, removes its block from the host's notes, and restore returns all of it", async () => {
    const { host, intro, outro, checklist, nested } = await hostWithNestedSubpage();
    expect((await notesOf(host)).map((block) => block.id)).toEqual([intro, checklist.blockId, outro]);

    const deleted = await call("DELETE", `/api/items/${checklist.pageItemId}`, harness.headersA);

    expect(deleted.status).toBe(200);
    expect(await readStatuses(checklist.pageItemId, nested.pageItemId, host)).toEqual([404, 404, 200]);
    expect((await notesOf(host)).map((block) => block.id)).toEqual([intro, outro]);

    const restored = await call("POST", `/api/items/${checklist.pageItemId}/restore`, harness.headersA);

    expect(restored.status).toBe(200);
    expect(await readStatuses(checklist.pageItemId, nested.pageItemId)).toEqual([200, 200]);
    expect(await notesOf(host)).toEqual([
      { id: intro, type: "text" },
      { id: checklist.blockId, type: "page", pageId: checklist.pageItemId },
      { id: outro, type: "text" },
    ]);
    const nestedBlocks = (await notesOf(checklist.pageItemId)).filter((block) => block.type === "page");
    expect(nestedBlocks).toEqual([{ id: nested.blockId, type: "page", pageId: nested.pageItemId }]);
  });

  it("answers a delete and a restore of another tenant's page like an unknown id, and changes nothing", async () => {
    const { host, intro, outro, checklist, nested } = await hostWithNestedSubpage();
    const unknown = randomUUID();

    const foreignDelete = await call("DELETE", `/api/items/${checklist.pageItemId}`, harness.headersB);
    const unknownDelete = await call("DELETE", `/api/items/${unknown}`, harness.headersB);

    expect(foreignDelete.status).toBe(404);
    expect(await anonymized(foreignDelete, checklist.pageItemId)).toEqual(await anonymized(unknownDelete, unknown));
    expect(await readStatuses(checklist.pageItemId, nested.pageItemId)).toEqual([200, 200]);
    expect((await notesOf(host)).map((block) => block.id)).toEqual([intro, checklist.blockId, outro]);

    // The owner trashes the page; the other tenant cannot bring it back either.
    expect((await call("DELETE", `/api/items/${checklist.pageItemId}`, harness.headersA)).status).toBe(200);
    const foreignRestore = await call("POST", `/api/items/${checklist.pageItemId}/restore`, harness.headersB);
    const unknownRestore = await call("POST", `/api/items/${unknown}/restore`, harness.headersB);

    expect(foreignRestore.status).toBe(404);
    expect(await anonymized(foreignRestore, checklist.pageItemId)).toEqual(await anonymized(unknownRestore, unknown));
    expect(await readStatuses(checklist.pageItemId, nested.pageItemId)).toEqual([404, 404]);
    expect((await notesOf(host)).map((block) => block.id)).toEqual([intro, outro]);
  });

  it("holds an agent's item.delete of a page for approval, and trashes the page with its subpage once it is approved", async () => {
    const token = await harness.mintRunCredential(harness.tenantA, ["core.item.write"]);
    const { host, intro, outro, checklist, nested } = await hostWithNestedSubpage();

    const called = await call(
      "POST",
      "/mcp",
      { Authorization: `Bearer ${token}` },
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "semprec.item.delete", arguments: { itemId: checklist.pageItemId } },
      },
    );

    expect(called.status).toBe(200);
    const { approvalRequestId } = approvalRequiredBody.parse(await called.json()).error.data;
    const requests = async () =>
      (
        await runInTenant(harness.tenantA, () =>
          harness.runtime.query<{ id: string; tool_name: string; status: string; execution_status: string }>(
            `SELECT id, tool_name, status, execution_status FROM approval_requests ORDER BY id`,
          ),
        )
      ).rows;
    expect(await requests()).toEqual([
      { id: approvalRequestId, tool_name: "item.delete", status: "pending", execution_status: "not_approved" },
    ]);
    // Nothing is trashed while the request waits.
    expect(await readStatuses(checklist.pageItemId, nested.pageItemId)).toEqual([200, 200]);
    expect((await notesOf(host)).map((block) => block.id)).toEqual([intro, checklist.blockId, outro]);

    const approved = await call("PATCH", `/api/approval-requests/${approvalRequestId}`, harness.headersA, {
      decision: "approved",
    });
    expect(approved.status).toBe(200);
    // The production executor of approved requests, as the API queue runtime composes it.
    const taskList = createCoreTaskList(
      harness.runtime,
      new Map(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      replayApprovedGenericOperation,
    );
    const execute = taskList[CORE_TASK_NAMES.APPROVAL_REQUEST_EXECUTE];
    if (!execute) throw new Error("The approval executor is missing from the core task list");
    await runOnce({ pgPool: harness.admin }, { [CORE_TASK_NAMES.APPROVAL_REQUEST_EXECUTE]: execute });

    expect(await requests()).toEqual([
      { id: approvalRequestId, tool_name: "item.delete", status: "approved", execution_status: "succeeded" },
    ]);
    expect(await readStatuses(checklist.pageItemId, nested.pageItemId)).toEqual([404, 404]);
    expect((await notesOf(host)).map((block) => block.id)).toEqual([intro, outro]);
    // The block left the host's notes as the agent's write.
    const { rows } = await runInTenant(harness.tenantA, () =>
      harness.runtime.query<{ created_by: string }>(
        `SELECT u.created_by FROM doc_updates u JOIN docs d ON d.id = u.doc_id WHERE d.item_id = $1
          ORDER BY u.id DESC LIMIT 1`,
        [host],
      ),
    );
    expect(rows[0]?.created_by).toBe("ai_agent");
  });
});

describe("trash and restore of a host with its subpages (issue #1763)", () => {
  beforeAll(() => harness.start());
  beforeEach(() => harness.reset());
  afterAll(() => harness.stop());

  it("hides the subpage and the nested page of a deleted host, and a restore of the host returns them and the block", async () => {
    const { host, intro, outro, checklist, nested } = await hostWithNestedSubpage();

    const deleted = await call("DELETE", `/api/items/${host}`, harness.headersA);

    expect(deleted.status).toBe(200);
    expect(await readStatuses(host, checklist.pageItemId, nested.pageItemId)).toEqual([404, 404, 404]);

    const restored = await call("POST", `/api/items/${host}/restore`, harness.headersA);

    expect(restored.status).toBe(200);
    expect(await readStatuses(host, checklist.pageItemId, nested.pageItemId)).toEqual([200, 200, 200]);
    expect(await notesOf(host)).toEqual([
      { id: intro, type: "text" },
      { id: checklist.blockId, type: "page", pageId: checklist.pageItemId },
      { id: outro, type: "text" },
    ]);
    const nestedBlocks = (await notesOf(checklist.pageItemId)).filter((block) => block.type === "page");
    expect(nestedBlocks).toEqual([{ id: nested.blockId, type: "page", pageId: nested.pageItemId }]);
  });
});
