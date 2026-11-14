import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { runInTenant } from "@semprec/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAgentRun } from "../../agentRuns/agentRunsStore.js";
import { resolveModuleAgentToolsForRun, type ResolvedModuleAgentTool } from "../../agentTools/moduleAgentTools.js";
import { createUser } from "../../auth/usersStore.js";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import * as databasesStore from "../../chokePoint/databasesStore.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../../db/pool.js";
import { loadFullModuleRegistry } from "../../manifest/fullModuleRegistry.js";
import { decideAndEnqueueApprovalRequest } from "../../mcp/approvalDecisionAction.js";
import { handleApprovalRequestExecuteTask } from "../../mcp/approvalRequestExecution.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { recordingTransport, sendAdapters, transportFor } from "../../testSupport/mailSendFakes.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { ensureFolderItem } from "../folderDiscovery.js";
import { createMailDraftSendTool } from "../mailAgentTools.js";
import { createMailDraftCreateRouteHandler, createMailDraftDiscardRouteHandler } from "../mailDraftRouteHandlers.js";
import { writeMailboxAddresses } from "../mailboxAddresses.js";

const OWN_ADDRESS = "me@example.test";
const PETR = { name: "Petr Novák", address: "petr@example.test" };
const SUBJECT = "Smlouva o dílo";
const BODY = "Dobrý den,\nposílám smlouvu k podpisu.";

const refusalSchema = z.looseObject({ status: z.number(), error: z.string(), message: z.string() });

interface MailTenant {
  tenantId: string;
  userId: string;
  /** The project that owns the mail databases: the project of a run that holds the mail grants. */
  mailProjectId: string;
  mailboxId: string;
}

let admin: Pool;
let runtime: Pool;
let tenant: MailTenant;
let other: MailTenant;
let registry: Awaited<ReturnType<typeof loadFullModuleRegistry>>;

function inTenant<T>(t: MailTenant, fn: () => Promise<T>): Promise<T> {
  return runInTenant(t.tenantId, fn);
}

/** A tenant with a mailbox that has a Drafts and a Sent folder, and the mail project that owns the mail databases. */
async function seededTenant(): Promise<MailTenant> {
  const tenantId = await createTestTenant(admin);
  const user = await createUser(admin, {
    tenantId,
    email: `${randomUUID()}@example.test`,
    passwordHash: "unused",
  });
  await runInTenant(tenantId, () => seedSystem(runtime, createViewTypeRegistry()));
  return runInTenant(tenantId, async () => {
    const cp = createChokePoint(runtime);
    const databases = await cp.listDatabases();
    const db = (key: string) => {
      const found = databases.find((row) => row.ownerModuleId === key);
      if (!found) throw new Error(`Missing ${key}`);
      return found;
    };
    const folderProperties = await cp.listProperties(db("folders").id);
    const mailboxRelation = folderProperties.find((row) => row.key === "mailbox");
    if (!mailboxRelation) throw new Error("Missing the folder-mailbox relation");
    const mailProjectId = db("mailboxes").ownerProjectItemId;
    if (!mailProjectId) throw new Error("The mail databases have no owner project");
    return withTransaction(runtime, async (client) => {
      const mailbox = await createItemWithClient(client, {
        databaseId: db("mailboxes").id,
        properties: { name: "Personal", provider: "generic" },
      });
      await writeMailboxAddresses(client, {
        mailboxesDatabaseId: db("mailboxes").id,
        mailboxItemId: mailbox.id,
        address: OWN_ADDRESS,
      });
      for (const specialPurpose of ["drafts", "sent"]) {
        await ensureFolderItem(client, {
          foldersDatabaseId: db("folders").id,
          mailboxItemId: mailbox.id,
          mailboxRelationPropertyId: mailboxRelation.id,
          providerId: specialPurpose.toUpperCase(),
          name: specialPurpose,
          behavior: "folder",
          specialPurpose,
        });
      }
      return { tenantId, userId: user.id, mailProjectId, mailboxId: mailbox.id };
    });
  });
}

const routeContext = (t: MailTenant, params: Record<string, string>, body: unknown) => ({
  params,
  body,
  identity: { user: { id: t.userId, locale: "en" } },
});

/** A draft made through the real create route, with a recipient in To. */
async function newDraft(t: MailTenant): Promise<string> {
  const created = await inTenant(t, () =>
    createMailDraftCreateRouteHandler(runtime)(
      routeContext(
        t,
        {},
        { mailboxId: t.mailboxId, from: OWN_ADDRESS, to: [PETR], cc: [], bcc: [], subject: SUBJECT, body: BODY },
      ),
    ),
  );
  expect(created.status).toBe(201);
  return z.object({ id: z.uuid() }).parse(created.body).id;
}

async function newRun(t: MailTenant, projectItemId: string | null = t.mailProjectId): Promise<string> {
  return inTenant(t, async () => {
    const run = await createAgentRun(runtime, {
      projectItemId,
      userId: t.userId,
      triggeredBy: "user",
      task: "send the draft",
    });
    return run.id;
  });
}

async function toolsFor(
  t: MailTenant,
  runId: string,
  projectItemId: string = t.mailProjectId,
  effectiveCapabilities?: ReadonlySet<string>,
): Promise<ResolvedModuleAgentTool[]> {
  return inTenant(t, () =>
    resolveModuleAgentToolsForRun(runtime, registry, runId, projectItemId, effectiveCapabilities),
  );
}

/** The send tool as the session of the run composes it from the manifest. */
async function sendToolOf(t: MailTenant, runId: string): Promise<ResolvedModuleAgentTool> {
  const tool = (await toolsFor(t, runId)).find((candidate) => candidate.name === "mail.draft.send");
  if (!tool) throw new Error("The run has no tool mail.draft.send");
  return tool;
}

/** Calls the tool as a session does. */
async function callSend(t: MailTenant, runId: string, args: unknown): Promise<{ error: boolean; result: string }> {
  const tool = await sendToolOf(t, runId);
  return inTenant(t, () => tool.invoke(args));
}

function refusalOf(answer: { error: boolean; result: string }) {
  expect(answer.error).toBe(true);
  return refusalSchema.parse(JSON.parse(answer.result));
}

interface RequestRow {
  id: string;
  agent_run_id: string;
  tool_name: string;
  risk_class: string;
  status: string;
  payload: unknown;
}

/** The approval requests of the tenant; the admin pool reads them, the tests only inspect rows the tool wrote. */
async function requestsOf(t: MailTenant): Promise<RequestRow[]> {
  const { rows } = await admin.query<RequestRow>(
    "SELECT id, agent_run_id, tool_name, risk_class, status, payload FROM approval_requests WHERE tenant_id = $1 ORDER BY requested_at",
    [t.tenantId],
  );
  return rows;
}

/** Whether the mailbox's draft was claimed or sent: its `sent_at` and a `mail_message_meta` claim row. */
async function sendTraceOf(draftId: string): Promise<{ sentAt: Date | null; claims: number }> {
  const draft = await admin.query<{ sent_at: Date | null }>(
    "SELECT sent_at FROM mail_drafts WHERE email_item_id = $1",
    [draftId],
  );
  const claims = await admin.query("SELECT 1 FROM mail_message_meta WHERE item_id = $1", [draftId]);
  return { sentAt: draft.rows[0]?.sent_at ?? null, claims: claims.rowCount ?? 0 };
}

/** Raw SQL: the server operator grants `emailSendAutonomous` on a project by direct database access, no API writes it. */
async function grantAutonomousSend(projectItemId: string): Promise<void> {
  await admin.query(
    `UPDATE items SET properties = properties || '{"emailSendAutonomous": true}'::jsonb WHERE id = $1`,
    [projectItemId],
  );
}

async function approveAndDeliver(t: MailTenant, requestId: string, transport: ReturnType<typeof recordingTransport>) {
  await inTenant(t, () =>
    withTransaction(runtime, (client) =>
      decideAndEnqueueApprovalRequest(client, {
        approvalRequestId: requestId,
        decision: "approved",
        decidedByUserId: t.userId,
      }),
    ),
  );
  await inTenant(t, () =>
    handleApprovalRequestExecuteTask(
      runtime,
      { approvalRequestId: requestId },
      undefined,
      undefined,
      sendAdapters(transportFor(transport)),
    ),
  );
}

describe("the mail.draft.send agent tool (issue gh-1949)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    registry = await loadFullModuleRegistry();
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end();
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await seededTenant();
    other = await seededTenant();
  });

  describe("composition", () => {
    it("is offered to a run whose project holds the mail.send grant, and is not deferred by the session", async () => {
      const runId = await newRun(tenant);

      const tool = await sendToolOf(tenant, runId);

      expect(tool).toMatchObject({ name: "mail.draft.send", requiresApproval: false });
      expect(tool.acceptsArguments({ draftId: randomUUID() })).toBe(true);
    });

    it("is absent from a run of a project without the grant: one that does not own the mail databases, or one whose capabilities lack mail.send", async () => {
      const mailRun = await newRun(tenant);
      const inbox = await inTenant(tenant, () =>
        withTransaction(runtime, (client) => databasesStore.getDatabaseByModuleId(client, "inbox")),
      );
      if (!inbox?.ownerProjectItemId) throw new Error("Missing Semprec project");
      const inboxRun = await newRun(tenant, inbox.ownerProjectItemId);
      const names = (tools: ResolvedModuleAgentTool[]) =>
        tools
          .map((tool) => tool.name)
          .filter((name) => name.startsWith("mail."))
          .sort();

      expect(names(await toolsFor(tenant, inboxRun, inbox.ownerProjectItemId))).toEqual([]);
      expect(
        names(await toolsFor(tenant, mailRun, tenant.mailProjectId, new Set(["mail.read", "mail.draft"]))),
      ).toEqual(["mail.draft.create", "mail.draft.update", "mail.thread.get"]);
      expect(names(await toolsFor(tenant, mailRun, tenant.mailProjectId, new Set(["mail.send"])))).toEqual([
        "mail.draft.send",
      ]);
      expect(names(await toolsFor(tenant, mailRun))).toContain("mail.draft.send");
    });

    it("declares an argument schema that takes only a draft id", async () => {
      const tool = await sendToolOf(tenant, await newRun(tenant));

      expect(tool.acceptsArguments({ draftId: "not-a-uuid" })).toBe(false);
      expect(tool.acceptsArguments({})).toBe(false);
      expect(tool.acceptsArguments({ draftId: randomUUID(), to: [PETR] })).toBe(false);
    });
  });

  describe("a call of a run in a project without send permission", () => {
    it("files one pending outbound request of the draft and answers with the sentence of a deferred tool; no mail leaves", async () => {
      const draftId = await newDraft(tenant);
      const runId = await newRun(tenant);

      const answer = await callSend(tenant, runId, { draftId });

      const requests = await requestsOf(tenant);
      expect(requests).toHaveLength(1);
      const [request] = requests;
      expect(request).toMatchObject({
        agent_run_id: runId,
        tool_name: "mail.draft.send",
        risk_class: "outbound",
        status: "pending",
        payload: { draftId, mailboxId: tenant.mailboxId, to: [PETR], subject: SUBJECT, body: BODY },
      });
      expect(answer).toEqual({
        error: false,
        result: `Tool 'mail.draft.send' requires human approval before it can run. Approval request ${request?.id} has been created and is awaiting a decision; this call has not been executed.`,
        approvalRequestId: request?.id,
      });
      expect(await sendTraceOf(draftId)).toEqual({ sentAt: null, claims: 0 });
    });

    it("sends nothing while the request is pending, even when its job is delivered", async () => {
      const draftId = await newDraft(tenant);
      const answer = await callSend(tenant, await newRun(tenant), { draftId });
      const [request] = await requestsOf(tenant);
      const transport = recordingTransport();

      await inTenant(tenant, () =>
        handleApprovalRequestExecuteTask(
          runtime,
          { approvalRequestId: request?.id ?? "" },
          undefined,
          undefined,
          sendAdapters(transportFor(transport)),
        ),
      );

      expect(answer.error).toBe(false);
      expect(transport.sent).toHaveLength(0);
      expect((await requestsOf(tenant)).map((row) => row.status)).toEqual(["pending"]);
      expect(await sendTraceOf(draftId)).toEqual({ sentAt: null, claims: 0 });
    });

    it("answers a repeated call with the pending request of the draft and files no second one", async () => {
      const draftId = await newDraft(tenant);
      const runId = await newRun(tenant);

      const first = await callSend(tenant, runId, { draftId });
      const second = await callSend(tenant, await newRun(tenant), { draftId });

      const requests = await requestsOf(tenant);
      expect(requests).toHaveLength(1);
      expect(first.result).toContain(`Approval request ${requests[0]?.id} `);
      expect(second.result).toContain(`Approval request ${requests[0]?.id} `);
    });
  });

  describe("a call of a run in a project with emailSendAutonomous", () => {
    it("still files a request and sends nothing; after the approval the draft is sent once and a repeated call is a conflict", async () => {
      await grantAutonomousSend(tenant.mailProjectId);
      const draftId = await newDraft(tenant);
      const runId = await newRun(tenant);
      const transport = recordingTransport();

      const answer = await callSend(tenant, runId, { draftId });

      expect(answer.error).toBe(false);
      const [request] = await requestsOf(tenant);
      expect(request).toMatchObject({ risk_class: "outbound", status: "pending" });
      expect(transport.sent).toHaveLength(0);
      expect(await sendTraceOf(draftId)).toEqual({ sentAt: null, claims: 0 });

      await approveAndDeliver(tenant, request?.id ?? "", transport);

      expect(transport.sent).toHaveLength(1);
      expect((await sendTraceOf(draftId)).sentAt).toBeInstanceOf(Date);

      const repeated = refusalOf(await callSend(tenant, runId, { draftId }));

      expect(repeated).toMatchObject({ status: 409, error: "mail_draft_already_sent" });
      expect(await requestsOf(tenant)).toHaveLength(1);
      expect(transport.sent).toHaveLength(1);
    });
  });

  describe("refusals", () => {
    it("answers an unknown draft and a discarded draft with the same 404 and files nothing", async () => {
      const discarded = await newDraft(tenant);
      await inTenant(tenant, () =>
        createMailDraftDiscardRouteHandler(runtime)(routeContext(tenant, { id: discarded }, undefined)),
      );
      const runId = await newRun(tenant);

      const unknown = refusalOf(await callSend(tenant, runId, { draftId: randomUUID() }));
      const gone = refusalOf(await callSend(tenant, runId, { draftId: discarded }));

      expect(unknown).toMatchObject({ status: 404 });
      expect(gone).toEqual(expect.objectContaining({ status: 404, error: unknown.error, message: unknown.message }));
      expect(await requestsOf(tenant)).toEqual([]);
    });

    it("answers a draft of another tenant like an unknown draft, through the runtime role, and files nothing in either tenant", async () => {
      const foreignDraft = await newDraft(other);
      const runId = await newRun(tenant);

      const foreign = refusalOf(await callSend(tenant, runId, { draftId: foreignDraft }));
      const unknown = refusalOf(await callSend(tenant, runId, { draftId: randomUUID() }));

      expect(foreign).toEqual(unknown);
      expect(foreign.status).toBe(404);
      expect(await requestsOf(tenant)).toEqual([]);
      expect(await requestsOf(other)).toEqual([]);
      expect(await sendTraceOf(foreignDraft)).toEqual({ sentAt: null, claims: 0 });
    });

    it("answers a bad argument object of a handler called directly with a 400 and files nothing", async () => {
      const runId = await newRun(tenant);

      for (const args of [{}, { draftId: "x" }, { draftId: randomUUID(), extra: true }]) {
        const answer = await inTenant(tenant, () => createMailDraftSendTool(runtime)(runId, args));
        expect(refusalOf(answer)).toMatchObject({ status: 400, message: "Invalid arguments" });
      }
      expect(await requestsOf(tenant)).toEqual([]);
    });

    it("refuses a run that does not exist with a 404 and a run without a project with a 403, and files nothing", async () => {
      const draftId = await newDraft(tenant);
      const noProject = await newRun(tenant, null);

      const unknown = await inTenant(tenant, () => createMailDraftSendTool(runtime)(randomUUID(), { draftId }));
      const withoutProject = await inTenant(tenant, () => createMailDraftSendTool(runtime)(noProject, { draftId }));

      expect(refusalOf(unknown)).toMatchObject({ status: 404, message: "Run not found" });
      expect(refusalOf(withoutProject)).toMatchObject({ status: 403, error: "forbidden" });
      expect(await requestsOf(tenant)).toEqual([]);
    });
  });
});
