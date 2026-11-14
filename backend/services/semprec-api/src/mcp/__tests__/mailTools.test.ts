import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { ModuleRegistry } from "@semprec/module-registry";
import { createGenericOperationGateway } from "@semprec/application";
import { CAPABILITY_IDS, runInTenant } from "@semprec/shared";
import {
  createChokePoint,
  createCollectionMetadataResolver,
  createItemWithClient,
  createUser,
  createViewTypeRegistry,
  hashPassword,
  loadFullModuleRegistry,
  login,
  mintMcpRunCredential,
  seedSystem,
  withTransaction,
} from "@semprec/data";
import {
  createRuntimeRolePool,
  createTestTenant,
  ensureFolderItem,
  getTestPool,
  recordingTransport,
  resetDatabase,
  sendAdapters,
  transportFor,
  writeMailboxAddresses,
} from "@semprec/data/testSupport";
import { createMcpRequestListener } from "../mcpHandler.js";

const OWN_ADDRESS = "me@example.test";
const PETR = { name: "Petr Novák", address: "petr@example.test" };
const PASSWORD = "mcp-test-password";
const MAIL_TOOLS = ["mail.thread.get", "mail.draft.create", "mail.draft.update", "mail.draft.send"].map(
  (name) => `semprec.${name}`,
);

const rpcErrorSchema = z.object({ error: z.looseObject({ code: z.number(), message: z.string() }) });
const toolListSchema = z.object({
  result: z.object({ tools: z.array(z.looseObject({ name: z.string(), inputSchema: z.looseObject({}) })) }),
});
const toolResultSchema = z.object({
  result: z.object({ content: z.array(z.object({ type: z.literal("text"), text: z.string() })), isError: z.boolean() }),
});
const draftSchema = z.looseObject({ id: z.uuid(), subject: z.string(), body: z.string(), createdBy: z.string() });
const refusalSchema = z.looseObject({ status: z.number(), error: z.string(), message: z.string() });

interface MailTenant {
  tenantId: string;
  userId: string;
  email: string;
  mailProjectId: string;
  inboxProjectId: string;
  mailboxId: string;
}

let admin: Pool;
let runtime: Pool;
let registry: Awaited<ReturnType<typeof loadFullModuleRegistry>>;
let tenantA: MailTenant;
let tenantB: MailTenant;
let transport: ReturnType<typeof recordingTransport>;
let servers: Server[];

/** A tenant with a mailbox that has Drafts and Sent folders, the project that owns the mail databases and one that does not. */
async function seededTenant(): Promise<MailTenant> {
  const tenantId = await createTestTenant(admin);
  const email = `${randomUUID()}@example.test`;
  const user = await createUser(admin, { tenantId, email, passwordHash: await hashPassword(PASSWORD) });
  await runInTenant(tenantId, () => seedSystem(runtime, createViewTypeRegistry()));
  return runInTenant(tenantId, async () => {
    const databases = await createChokePoint(runtime).listDatabases();
    const db = (key: string) => {
      const found = databases.find((row) => row.ownerModuleId === key);
      if (!found) throw new Error(`Missing ${key}`);
      return found;
    };
    const folderProperties = await createChokePoint(runtime).listProperties(db("folders").id);
    const mailboxRelation = folderProperties.find((row) => row.key === "mailbox");
    const mailProjectId = db("mailboxes").ownerProjectItemId;
    const inboxProjectId = db("inbox").ownerProjectItemId;
    if (!mailboxRelation || !mailProjectId || !inboxProjectId) throw new Error("Missing the mail or the Inbox project");
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
      return { tenantId, userId: user.id, email, mailProjectId, inboxProjectId, mailboxId: mailbox.id };
    });
  });
}

/** A `/mcp` listener over the given module registry, on the runtime-role pool, that sends through the recording transport. */
async function startListener(moduleRegistry: ModuleRegistry, withSendAdapters = true): Promise<string> {
  const server = createServer(
    await createMcpRequestListener(
      runtime,
      createGenericOperationGateway(runtime, await createCollectionMetadataResolver(moduleRegistry)),
      new Set(CAPABILITY_IDS),
      moduleRegistry,
      withSendAdapters ? { mailServerClients: { send: sendAdapters(transportFor(transport)) } } : {},
    ),
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  return `http://127.0.0.1:${address.port}/mcp`;
}

async function rpc(endpoint: string, token: string, method: string, params?: unknown): Promise<unknown> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return { httpStatus: response.status, ...z.record(z.string(), z.unknown()).parse(await response.json()) };
}

async function toolNames(endpoint: string, token: string): Promise<string[]> {
  return toolListSchema.parse(await rpc(endpoint, token, "tools/list")).result.tools.map((tool) => tool.name);
}

/** The text of a tool call that answered, and whether the handler marked it an error. */
async function callTool(endpoint: string, token: string, name: string, args: unknown) {
  const { result } = toolResultSchema.parse(await rpc(endpoint, token, "tools/call", { name, arguments: args }));
  return { isError: result.isError, text: result.content[0]?.text ?? "" };
}

async function humanToken(t: MailTenant): Promise<string> {
  return (await login(admin, { email: t.email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" })).token;
}

const MAIL_CAPABILITIES = ["mail.read", "mail.draft", "mail.send"];

/** A run credential that lists core read access and, by default, the three mail capabilities of the registered module. */
async function credentialOf(
  t: MailTenant,
  projectItemId: string,
  capabilities: string[] = ["core.item.read", ...MAIL_CAPABILITIES],
) {
  return runInTenant(t.tenantId, () =>
    withTransaction(runtime, (client) =>
      mintMcpRunCredential(client, {
        projectItemId,
        capabilities,
        moduleCapabilityIds: [...MAIL_CAPABILITIES, "mail.taskProposal"],
        userId: t.userId,
      }),
    ),
  );
}

interface DraftTrace {
  created_by: string;
  last_edited_by: string;
  agent_run_id: string | null;
  sent_at: Date | null;
  claims: number;
}

/** The `mail_drafts` row of a draft and whether a send claimed it; the admin pool only inspects what the tools wrote. */
async function traceOf(draftId: string): Promise<DraftTrace> {
  const { rows } = await admin.query<DraftTrace>(
    `SELECT d.created_by, d.last_edited_by, d.agent_run_id, d.sent_at,
            (SELECT count(*)::int FROM mail_message_meta m WHERE m.item_id = d.email_item_id) AS claims
     FROM mail_drafts d WHERE d.email_item_id = $1`,
    [draftId],
  );
  const row = rows[0];
  if (!row) throw new Error("Missing draft row");
  return row;
}

async function draftCount(t: MailTenant): Promise<number> {
  const { rows } = await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM mail_drafts WHERE tenant_id = $1", [
    t.tenantId,
  ]);
  return rows[0]?.n ?? 0;
}

interface RequestRow {
  id: string;
  agent_run_id: string;
  tool_name: string;
  risk_class: string;
  status: string;
}

async function requestsOf(t: MailTenant): Promise<RequestRow[]> {
  const { rows } = await admin.query<RequestRow>(
    "SELECT id, agent_run_id, tool_name, risk_class, status FROM approval_requests WHERE tenant_id = $1 ORDER BY requested_at",
    [t.tenantId],
  );
  return rows;
}

/** A new draft made over `/mcp` with the given token, addressed to Petr. */
async function createDraft(endpoint: string, token: string, t: MailTenant): Promise<string> {
  const answer = await callTool(endpoint, token, "semprec.mail.draft.create", {
    mode: "new",
    mailboxId: t.mailboxId,
    to: [PETR],
    subject: "Offer",
    body: "Text",
  });
  expect(answer.isError, answer.text).toBe(false);
  return draftSchema.parse(JSON.parse(answer.text)).id;
}

describe("the mail tools on POST /mcp (issue gh-1956)", () => {
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
    tenantA = await seededTenant();
    tenantB = await seededTenant();
    transport = recordingTransport();
    servers = [];
  });

  afterEach(async () => {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  });

  describe("a run credential", () => {
    it("in a project with the mail grants lists the four tools and creates a draft as its run when it lists the mail capabilities", async () => {
      const endpoint = await startListener(registry);
      const credential = await credentialOf(tenantA, tenantA.mailProjectId);

      const names = await toolNames(endpoint, credential.token);
      expect(names).toEqual(expect.arrayContaining(MAIL_TOOLS));
      // The fifth mail tool declares no MCP exposure, and a module tool of another capability stays as it was.
      expect(names).not.toContain("semprec.mail.thread.proposeTask");
      const tools = toolListSchema.parse(await rpc(endpoint, credential.token, "tools/list")).result.tools;
      expect(tools.find((tool) => tool.name === "semprec.mail.draft.send")?.inputSchema).toMatchObject({
        type: "object",
        required: ["draftId"],
        additionalProperties: false,
      });

      const draftId = await createDraft(endpoint, credential.token, tenantA);

      expect(await traceOf(draftId)).toMatchObject({
        created_by: "agent",
        last_edited_by: "agent",
        agent_run_id: credential.run.id,
      });
      expect(await draftCount(tenantA)).toBe(1);
    });

    it("lists only the tools of the module capabilities its own list names, however much its project holds", async () => {
      const endpoint = await startListener(registry);
      const cases: { listed: string[]; tools: string[] }[] = [
        { listed: ["core.item.read"], tools: [] },
        { listed: ["core.item.write"], tools: [] },
        { listed: ["core.item.read", "mail.read"], tools: ["semprec.mail.thread.get"] },
        { listed: ["core.item.read", "mail.draft"], tools: ["semprec.mail.draft.create", "semprec.mail.draft.update"] },
        { listed: ["core.item.read", "mail.send"], tools: ["semprec.mail.draft.send"] },
      ];

      for (const { listed, tools } of cases) {
        const credential = await credentialOf(tenantA, tenantA.mailProjectId, listed);
        const names = (await toolNames(endpoint, credential.token)).filter((name) => MAIL_TOOLS.includes(name));
        expect(names.sort(), listed.join(",")).toEqual([...tools].sort());
      }
    });

    it("answers a call of a tool its list does not name with the method not found of an unknown tool and writes nothing", async () => {
      const endpoint = await startListener(registry);
      const readOnly = await credentialOf(tenantA, tenantA.mailProjectId, ["core.item.read", "mail.read"]);
      const coreOnly = await credentialOf(tenantA, tenantA.mailProjectId, ["core.item.read"]);

      for (const token of [readOnly.token, coreOnly.token]) {
        for (const name of ["semprec.mail.draft.create", "semprec.mail.draft.update", "semprec.mail.draft.send"]) {
          const answer = rpcErrorSchema.parse(
            await rpc(endpoint, token, "tools/call", {
              name,
              arguments: { mode: "new", mailboxId: tenantA.mailboxId, body: "Text", draftId: randomUUID() },
            }),
          ).error;
          expect(answer.code).toBe(-32601);
        }
      }
      const threadCall = rpcErrorSchema.parse(
        await rpc(endpoint, coreOnly.token, "tools/call", {
          name: "semprec.mail.thread.get",
          arguments: { threadId: randomUUID() },
        }),
      ).error;
      expect(threadCall.code).toBe(-32601);
      expect(await draftCount(tenantA)).toBe(0);
      expect(await requestsOf(tenantA)).toEqual([]);
    });

    it("does not gain a tool by listing the capability in a project that does not hold it", async () => {
      const endpoint = await startListener(registry);
      const credential = await credentialOf(tenantA, tenantA.inboxProjectId);

      const names = await toolNames(endpoint, credential.token);

      for (const name of MAIL_TOOLS) expect(names).not.toContain(name);
    });

    it("in a project without the mail grants lists none of the four and answers a call of each with the method not found of an unknown tool, and writes nothing", async () => {
      const endpoint = await startListener(registry);
      const credential = await credentialOf(tenantA, tenantA.inboxProjectId);

      const names = await toolNames(endpoint, credential.token);
      for (const name of MAIL_TOOLS) expect(names).not.toContain(name);
      const unknown = rpcErrorSchema.parse(
        await rpc(endpoint, credential.token, "tools/call", { name: "semprec.mail.nope", arguments: {} }),
      ).error;
      expect(unknown.code).toBe(-32601);
      for (const name of MAIL_TOOLS) {
        const answer = rpcErrorSchema.parse(
          await rpc(endpoint, credential.token, "tools/call", {
            name,
            arguments: {
              mode: "new",
              mailboxId: tenantA.mailboxId,
              body: "Text",
              draftId: randomUUID(),
              threadId: randomUUID(),
            },
          }),
        ).error;
        expect(answer.code).toBe(-32601);
        expect(answer.message).toBe(`Unknown tool '${name}'`);
      }
      expect(await draftCount(tenantA)).toBe(0);
    });

    it("files the approval request of the send with source mcp and sends nothing when it calls mail.draft.send", async () => {
      const endpoint = await startListener(registry);
      const credential = await credentialOf(tenantA, tenantA.mailProjectId);
      const draftId = await createDraft(endpoint, credential.token, tenantA);

      const answer = await callTool(endpoint, credential.token, "semprec.mail.draft.send", { draftId });

      const requests = await requestsOf(tenantA);
      expect(answer.isError).toBe(false);
      expect(requests).toEqual([
        {
          id: expect.any(String),
          agent_run_id: credential.run.id,
          tool_name: "mail.draft.send",
          risk_class: "outbound",
          status: "pending",
        },
      ]);
      expect(answer.text).toContain(`Approval request ${requests[0]?.id} has been created`);
      const source = await admin.query<{ triggered_by: string }>("SELECT triggered_by FROM agent_runs WHERE id = $1", [
        credential.run.id,
      ]);
      expect(source.rows[0]?.triggered_by).toBe("mcp");
      expect(transport.sent).toEqual([]);
      expect(await traceOf(draftId)).toMatchObject({ sent_at: null, claims: 0 });
    });

    it("refuses arguments the schema of the tool does not accept with the invalid-params error, as for a human session, and creates no request", async () => {
      const endpoint = await startListener(registry);
      const credential = await credentialOf(tenantA, tenantA.mailProjectId);
      const human = await humanToken(tenantA);

      for (const token of [credential.token, human]) {
        for (const args of [{ draftId: "x" }, { draftId: randomUUID(), to: [PETR] }, {}]) {
          const answer = rpcErrorSchema.parse(
            await rpc(endpoint, token, "tools/call", { name: "semprec.mail.draft.send", arguments: args }),
          ).error;
          expect(answer.code).toBe(-32602);
        }
      }
      expect(await requestsOf(tenantA)).toEqual([]);
      expect(transport.sent).toEqual([]);
    });

    it("cannot reach the draft of another tenant: the same refusal as an unknown draft, nothing filed", async () => {
      const endpoint = await startListener(registry);
      const credential = await credentialOf(tenantA, tenantA.mailProjectId);
      const foreignDraft = await createDraft(endpoint, await humanToken(tenantB), tenantB);

      const foreign = await callTool(endpoint, credential.token, "semprec.mail.draft.send", { draftId: foreignDraft });
      const unknown = await callTool(endpoint, credential.token, "semprec.mail.draft.send", { draftId: randomUUID() });

      expect(foreign.isError).toBe(true);
      expect(refusalSchema.parse(JSON.parse(foreign.text))).toMatchObject({ status: 404 });
      expect(JSON.parse(foreign.text)).toEqual(JSON.parse(unknown.text));
      expect(await requestsOf(tenantA)).toEqual([]);
      expect(await requestsOf(tenantB)).toEqual([]);
    });

    it("does not see the mail tools of a module that is not active", async () => {
      const inactive = await registryWithMailInactive();
      const endpoint = await startListener(inactive);
      const credential = await credentialOf(tenantA, tenantA.mailProjectId);

      const names = await toolNames(endpoint, credential.token);
      for (const name of MAIL_TOOLS) expect(names).not.toContain(name);
      expect(
        rpcErrorSchema.parse(
          await rpc(endpoint, credential.token, "tools/call", {
            name: "semprec.mail.draft.create",
            arguments: { mode: "new", mailboxId: tenantA.mailboxId, body: "Text" },
          }),
        ).error.code,
      ).toBe(-32601);
    });
  });

  describe("a human session", () => {
    it("lists the four tools and no other module tool", async () => {
      const endpoint = await startListener(registry);

      const names = await toolNames(endpoint, await humanToken(tenantA));

      expect(names).toEqual(expect.arrayContaining(MAIL_TOOLS));
      expect(names).not.toContain("semprec.mail.thread.proposeTask");
      expect(names.filter((name) => !name.startsWith("semprec.mail.") && /^semprec\.\w+\.\w+/.test(name))).not.toEqual(
        expect.arrayContaining(["semprec.heartbeat.list"]),
      );
    });

    it("creates, updates and sends a draft as the user, asks nobody, and records an agent with no run as the author", async () => {
      const endpoint = await startListener(registry);
      const token = await humanToken(tenantA);

      const draftId = await createDraft(endpoint, token, tenantA);
      expect(await traceOf(draftId)).toMatchObject({ created_by: "agent", agent_run_id: null });
      const updated = await callTool(endpoint, token, "semprec.mail.draft.update", { draftId, body: "Final text" });
      expect(updated.isError, updated.text).toBe(false);
      expect(draftSchema.parse(JSON.parse(updated.text))).toMatchObject({ id: draftId, body: "Final text" });
      const sent = await callTool(endpoint, token, "semprec.mail.draft.send", { draftId });

      expect(sent.isError, sent.text).toBe(false);
      expect(JSON.parse(sent.text)).toMatchObject({ emailId: draftId, mailbox: { id: tenantA.mailboxId } });
      expect(transport.sent).toHaveLength(1);
      expect(transport.sent[0]?.envelope).toEqual({ from: OWN_ADDRESS, recipients: [PETR.address] });
      expect((await traceOf(draftId)).sent_at).not.toBeNull();
      expect(await requestsOf(tenantA)).toEqual([]);
    });

    it("reads a thread and answers an unknown one with the 404 of the tool", async () => {
      const endpoint = await startListener(registry);
      const token = await humanToken(tenantA);

      const unknown = await callTool(endpoint, token, "semprec.mail.thread.get", { threadId: randomUUID() });

      expect(unknown.isError).toBe(true);
      expect(refusalSchema.parse(JSON.parse(unknown.text))).toMatchObject({ status: 404 });
    });

    it("cannot send or update the draft of another tenant: the same refusal as an unknown draft, and the draft stays as it was", async () => {
      const endpoint = await startListener(registry);
      const foreignDraft = await createDraft(endpoint, await humanToken(tenantB), tenantB);
      const token = await humanToken(tenantA);

      const sent = await callTool(endpoint, token, "semprec.mail.draft.send", { draftId: foreignDraft });
      const unknownSent = await callTool(endpoint, token, "semprec.mail.draft.send", { draftId: randomUUID() });
      const updated = await callTool(endpoint, token, "semprec.mail.draft.update", {
        draftId: foreignDraft,
        body: "x",
      });

      expect(sent.isError).toBe(true);
      expect(JSON.parse(sent.text)).toEqual(JSON.parse(unknownSent.text));
      expect(refusalSchema.parse(JSON.parse(updated.text))).toMatchObject({ status: 404 });
      expect(transport.sent).toEqual([]);
      expect(await traceOf(foreignDraft)).toMatchObject({ sent_at: null, claims: 0, last_edited_by: "agent" });
      expect(await draftCount(tenantA)).toBe(0);
    });

    it("is not offered the tools of a module that is not active, and a call answers method not found", async () => {
      const inactive = await registryWithMailInactive();
      const endpoint = await startListener(inactive);
      const token = await humanToken(tenantA);

      const names = await toolNames(endpoint, token);
      for (const name of MAIL_TOOLS) expect(names).not.toContain(name);
      expect(
        rpcErrorSchema.parse(
          await rpc(endpoint, token, "tools/call", {
            name: "semprec.mail.draft.send",
            arguments: { draftId: randomUUID() },
          }),
        ).error.code,
      ).toBe(-32601);
    });

    it("fails a send with an internal error and leaves the draft unsent when the process configured no send adapters", async () => {
      const endpoint = await startListener(registry, false);
      const token = await humanToken(tenantA);
      const draftId = await createDraft(endpoint, token, tenantA);

      const response = await rpc(endpoint, token, "tools/call", {
        name: "semprec.mail.draft.send",
        arguments: { draftId },
      });

      expect(response).toMatchObject({ httpStatus: 500, error: "Internal server error" });
      expect(await traceOf(draftId)).toMatchObject({ sent_at: null, claims: 0 });
      expect(transport.sent).toEqual([]);
    });
  });
});

/** The full set of module manifests with only the schema core module active, so the mail module is loaded and inactive. */
async function registryWithMailInactive(): Promise<ModuleRegistry> {
  const inactive = new ModuleRegistry(() => new Set(["schemaCore"]));
  await inactive.loadModule(
    new URL("../../../../../packages/data/src/chokePoint/schemaCoreModuleManifest.js", import.meta.url).href,
  );
  await inactive.loadModule(
    new URL("../../../../../packages/data/src/mail/mailModuleManifest.js", import.meta.url).href,
  );
  return inactive;
}
