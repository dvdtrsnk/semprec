// Issue gh-1948: a chat message that refs a mail draft. The turn is run by the Semp message task the queue registers,
// with a scripted model: the context the model receives holds the draft, and its `mail.draft.update` call changes that
// same draft and publishes the ephemeral body delta of the run. A draft that is sent, in the Trash or another tenant's is
// answered by the tool as a refusal, and the run finishes.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Context,
  type FauxProviderHandle,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import { closeIdleThreadSessions } from "@semprec/agent-runtime";
import { runInTenant, type LabeledSempMessageRef } from "@semprec/shared";
import {
  createAgentRun,
  createChokePoint,
  createItemWithClient,
  createUser,
  getDatabaseByModuleId,
  getMailDraft,
  listPropertiesByDatabase,
  loadFullModuleRegistry,
  markMailDraftSent,
  resolveModuleAgentToolsForRun,
  seedSystem,
  sendSempMessage,
  setAgentRunDeltaHook,
  withTransaction,
  type AgentRunDeltaEvent,
} from "@semprec/data";
import {
  createRuntimeRolePool,
  createTestTenant,
  ensureFolderItem,
  getTestPool,
  resetDatabase,
  writeMailboxAddresses,
} from "@semprec/data/testSupport";
import type { ModuleRegistry } from "@semprec/module-registry";
import { createInFlightAgentRuns } from "../inFlightAgentRuns.js";
import { MAX_REF_CONTEXT_CHARS } from "../refExpansionLimits.js";
import { expandSempRefs } from "../refExpansion.js";
import type { GatewayModel } from "../modelComposition.js";
import { createSempMessageTask } from "../sempMessageTask.js";

interface MailTenant {
  tenantId: string;
  semprecProjectItemId: string;
  emailsDatabaseId: string;
  mailboxId: string;
}

let admin: Pool;
let runtime: Pool;
let registry: ModuleRegistry;
let tenant: MailTenant;
let foreign: MailTenant;
let deltas: AgentRunDeltaEvent[];

function inTenant<T>(t: MailTenant, fn: () => Promise<T>): Promise<T> {
  return runInTenant(t.tenantId, fn);
}

function gatewayOf(faux: FauxProviderHandle): GatewayModel {
  return {
    model: faux.getModel(),
    streamFn: (model, context, options) => faux.provider.streamSimple(model, context, options),
    isBudgetRefusal: () => false,
  };
}

/**
 * A tenant whose Semp chat project (the Semprec project, the project a chat turn runs in) holds the mail databases and so
 * the mail capabilities, with a mailbox that has a primary address and a Drafts folder.
 */
async function seededTenant(): Promise<MailTenant> {
  const tenantId = await createTestTenant(admin);
  await createUser(admin, { tenantId, email: `${randomUUID()}@example.test`, passwordHash: "unused", locale: "en" });
  await runInTenant(tenantId, () => seedSystem(runtime));
  const t = await runInTenant(tenantId, () =>
    withTransaction(runtime, async (client) => {
      const inbox = await getDatabaseByModuleId(client, "inbox");
      const mailboxes = await getDatabaseByModuleId(client, "mailboxes");
      const folders = await getDatabaseByModuleId(client, "folders");
      const emails = await getDatabaseByModuleId(client, "emails");
      if (!inbox?.ownerProjectItemId || !mailboxes?.ownerProjectItemId || !folders || !emails)
        throw new Error("Missing system databases");
      const mailboxRelation = (await listPropertiesByDatabase(client, folders.id)).find(
        (property) => property.key === "mailbox",
      );
      if (!mailboxRelation) throw new Error("Missing the folder-mailbox relation");
      const mailbox = await createItemWithClient(client, {
        databaseId: mailboxes.id,
        properties: { name: "Personal", provider: "gmail" },
      });
      await writeMailboxAddresses(client, {
        mailboxesDatabaseId: mailboxes.id,
        mailboxItemId: mailbox.id,
        address: "me@example.test",
        aliases: [],
      });
      await ensureFolderItem(client, {
        foldersDatabaseId: folders.id,
        mailboxItemId: mailbox.id,
        mailboxRelationPropertyId: mailboxRelation.id,
        providerId: "DRAFTS",
        name: "drafts",
        behavior: "folder",
        specialPurpose: "drafts",
      });
      return {
        tenantId,
        semprecProjectItemId: inbox.ownerProjectItemId,
        emailsDatabaseId: emails.id,
        mailboxId: mailbox.id,
        mailProjectItemId: mailboxes.ownerProjectItemId,
      };
    }),
  );
  // The generic API has no operation to transfer an owned system database; this fixture models a Semp chat project that
  // owns the mail databases, which is what grants the mail capabilities to the run of a chat turn.
  const transfer = await admin.query(
    "UPDATE databases SET owner_project_item_id = $1 WHERE tenant_id = $2 AND owner_project_item_id = $3",
    [t.semprecProjectItemId, tenantId, t.mailProjectItemId],
  );
  expect(transfer.rowCount).toBeGreaterThan(0);
  return {
    tenantId,
    semprecProjectItemId: t.semprecProjectItemId,
    emailsDatabaseId: t.emailsDatabaseId,
    mailboxId: t.mailboxId,
  };
}

/** An open draft of the tenant's mailbox, created through `mail.draft.create` by a run of the Semprec project. */
async function createDraft(
  t: MailTenant,
  subject: string,
  body: string,
  to: { address: string; name: string }[] = [{ address: "petr@example.test", name: "Petr" }],
): Promise<string> {
  return inTenant(t, async () => {
    const run = await createAgentRun(runtime, {
      projectItemId: t.semprecProjectItemId,
      triggeredBy: "user",
      task: "draft",
    });
    const tools = await resolveModuleAgentToolsForRun(runtime, registry, run.id, t.semprecProjectItemId);
    const create = tools.find((tool) => tool.name === "mail.draft.create");
    if (!create) throw new Error("The Semprec project has no mail.draft.create tool");
    const { result, error } = await create.invoke({
      mode: "new",
      mailboxId: t.mailboxId,
      to,
      subject,
      body,
    });
    expect(error, result).toBe(false);
    const draft: unknown = JSON.parse(result);
    if (typeof draft !== "object" || draft === null || !("id" in draft) || typeof draft.id !== "string")
      throw new Error("The draft has no id");
    return draft.id;
  });
}

function draftRef(t: MailTenant, draftId: string): LabeledSempMessageRef {
  return { kind: "item", itemId: draftId, databaseId: t.emailsDatabaseId, label: "Draft" };
}

const toolCall = (name: string, args: Record<string, unknown>, id: string) =>
  fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: "toolUse" });

/** Every text the model receives from the user in this request, the ephemeral ref context included. */
function userTexts(context: Context): string {
  const texts: string[] = [];
  for (const message of context.messages) {
    if (message.role !== "user") continue;
    if (typeof message.content === "string") texts.push(message.content);
    else for (const part of message.content) if (part.type === "text") texts.push(part.text);
  }
  return texts.join("\n");
}

function toolResultText(context: Context, toolCallId: string): string {
  for (const message of context.messages) {
    if (message.role === "toolResult" && message.toolCallId === toolCallId)
      return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
  }
  throw new Error(`The model received no result for ${toolCallId}`);
}

/** Queues a message that refs `draftId` and runs the registered task once, as the queue does. */
async function runChatTurn(
  t: MailTenant,
  faux: FauxProviderHandle,
  refs: LabeledSempMessageRef[],
): Promise<{ status: string; runId: string | null }> {
  const task = createSempMessageTask(runtime, registry, gatewayOf(faux), createInFlightAgentRuns());
  const turn = await inTenant(t, () =>
    withTransaction(runtime, (client) =>
      sendSempMessage(client, { text: "Make this draft friendlier", context: refs, hasContext: refs.length > 0 }),
    ),
  );
  await inTenant(t, () =>
    task({ threadId: turn.threadId, assistantMessageId: turn.assistantMessageId }, { job: { id: randomUUID() } }),
  );
  const { rows } = await inTenant(t, () =>
    runtime.query<{ status: string; agent_run_id: string | null }>(
      "SELECT status, agent_run_id FROM semp_messages WHERE id = $1",
      [turn.assistantMessageId],
    ),
  );
  const row = rows[0];
  if (!row) throw new Error("The reply message is missing");
  return { status: row.status, runId: row.agent_run_id };
}

async function draftState(t: MailTenant, draftId: string) {
  return inTenant(t, async () => {
    const row = await getMailDraft(runtime, draftId);
    const { rows } = await runtime.query<{ body: string | null }>(
      "SELECT properties->>'body' AS body FROM items WHERE id = $1",
      [draftId],
    );
    return { lastEditedBy: row?.lastEditedBy, sentAt: row?.sentAt ?? null, body: rows[0]?.body };
  });
}

describe("a chat turn that refs a mail draft (issue gh-1948)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    await resetDatabase(admin);
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    registry = await loadFullModuleRegistry();
    tenant = await seededTenant();
    foreign = await seededTenant();
  });

  afterEach(() => {
    setAgentRunDeltaHook(async () => {});
  });

  afterAll(async () => {
    const errors: unknown[] = [];
    try {
      await closeIdleThreadSessions(runtime);
    } catch (error) {
      errors.push(error);
    }
    try {
      await runtime?.end();
    } catch (error) {
      errors.push(error);
    }
    try {
      await admin?.end();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) throw new AggregateError(errors, "Draft ref turn test cleanup failed", { cause: errors[0] });
  });

  function recordDeltas(): void {
    deltas = [];
    setAgentRunDeltaHook(async (event) => {
      deltas.push(event);
    });
  }

  it("gives the run the draft in its context, and the run's mail.draft.update changes that same draft", async () => {
    const draftId = await createDraft(tenant, "Offer", "Dear Petr, the offer stands.");
    const faux = fauxProvider();
    let firstRequest = "";
    let updateAnswer = "";
    const steps: FauxResponseStep[] = [
      (context) => {
        firstRequest = userTexts(context);
        return toolCall("mail_draft_update", { draftId, body: "Hi Petr, our offer still stands." }, "update-draft");
      },
      (context) => {
        updateAnswer = toolResultText(context, "update-draft");
        return fauxAssistantMessage("I made it friendlier.");
      },
    ];
    faux.setResponses(steps);
    recordDeltas();

    const reply = await runChatTurn(tenant, faux, [draftRef(tenant, draftId)]);

    expect(reply.status).toBe("done");
    expect(firstRequest).toContain(draftId);
    expect(firstRequest).toContain("Dear Petr, the offer stands.");
    expect(firstRequest).toContain('"subject":"Offer"');
    expect(firstRequest).toContain("petr@example.test");
    expect(firstRequest).toContain(`Change it with the mail.draft.update tool and draftId ${draftId}`);
    expect(JSON.parse(updateAnswer)).toMatchObject({ id: draftId, body: "Hi Petr, our offer still stands." });
    expect(await draftState(tenant, draftId)).toMatchObject({
      lastEditedBy: "agent",
      body: "Hi Petr, our offer still stands.",
    });
    expect(deltas).toEqual([
      {
        agentRunId: reply.runId,
        delta: { kind: "mailDraftBody", draftId, body: "Hi Petr, our offer still stands." },
      },
    ]);
  });

  it("tells the model that a sent draft cannot be changed; its update is refused with a 409, no frame goes out and the run finishes", async () => {
    const draftId = await createDraft(tenant, "Sent offer", "Already gone.");
    await inTenant(tenant, () => withTransaction(runtime, (client) => markMailDraftSent(client, draftId)));
    const faux = fauxProvider();
    let firstRequest = "";
    let updateAnswer = "";
    faux.setResponses([
      (context) => {
        firstRequest = userTexts(context);
        return toolCall("mail_draft_update", { draftId, body: "Too late" }, "update-sent");
      },
      (context) => {
        updateAnswer = toolResultText(context, "update-sent");
        return fauxAssistantMessage("It was already sent.");
      },
    ]);
    recordDeltas();

    const reply = await runChatTurn(tenant, faux, [draftRef(tenant, draftId)]);

    expect(reply.status).toBe("done");
    expect(firstRequest).toContain("This draft has been sent and can no longer be changed");
    expect(JSON.parse(updateAnswer)).toMatchObject({ status: 409, error: "mail_draft_already_sent" });
    expect(deltas).toEqual([]);
    expect(await draftState(tenant, draftId)).toMatchObject({ lastEditedBy: "agent", body: "Already gone." });
  });

  it("marks a draft in the Trash as trashed; its update is refused with a 404, no frame goes out and the run finishes", async () => {
    const draftId = await createDraft(tenant, "Binned offer", "Binned text.");
    await inTenant(tenant, () => createChokePoint(runtime).softDeleteItem(tenant.emailsDatabaseId, draftId));
    const faux = fauxProvider();
    let firstRequest = "";
    let updateAnswer = "";
    faux.setResponses([
      (context) => {
        firstRequest = userTexts(context);
        return toolCall("mail_draft_update", { draftId, body: "Back again" }, "update-trashed");
      },
      (context) => {
        updateAnswer = toolResultText(context, "update-trashed");
        return fauxAssistantMessage("The draft is in the Trash.");
      },
    ]);
    recordDeltas();

    const reply = await runChatTurn(tenant, faux, [draftRef(tenant, draftId)]);

    expect(reply.status).toBe("done");
    expect(firstRequest).toContain("[trashed]");
    expect(firstRequest).not.toContain("Change it with the mail.draft.update tool");
    expect(JSON.parse(updateAnswer)).toMatchObject({ status: 404, message: "Draft not found" });
    expect(deltas).toEqual([]);
  });

  it("holds nothing of another tenant's draft in the context, and an update of that draft is the 404 of an unknown id", async () => {
    const foreignDraftId = await createDraft(foreign, "Private offer", "Private text.");
    const faux = fauxProvider();
    let firstRequest = "";
    let updateAnswer = "";
    faux.setResponses([
      (context) => {
        firstRequest = userTexts(context);
        return toolCall("mail_draft_update", { draftId: foreignDraftId, body: "Stolen" }, "update-foreign");
      },
      (context) => {
        updateAnswer = toolResultText(context, "update-foreign");
        return fauxAssistantMessage("I could not find that draft.");
      },
    ]);
    recordDeltas();

    // The send route refuses a ref of another tenant's item, so the turn carries none: the model names the id itself.
    const reply = await runChatTurn(tenant, faux, []);

    expect(reply.status).toBe("done");
    expect(firstRequest).not.toContain("Private text.");
    expect(firstRequest).not.toContain("Private offer");
    expect(JSON.parse(updateAnswer)).toMatchObject({ status: 404, message: "Draft not found" });
    expect(deltas).toEqual([]);
    expect(await draftState(foreign, foreignDraftId)).toMatchObject({ lastEditedBy: "agent", body: "Private text." });
  });

  describe("the rendered section of a draft ref", () => {
    const recipients = Array.from({ length: 100 }, (_, index) => ({
      name: `Recipient number ${index}`,
      address: `recipient-${index}@example.test`,
    }));

    async function expand(t: MailTenant, refs: LabeledSempMessageRef[]): Promise<string> {
      const { text } = await inTenant(t, () =>
        expandSempRefs(runtime, refs, undefined, undefined, t.semprecProjectItemId),
      );
      return text;
    }

    /** The section of a draft whose body is cut keeps the flag and the instruction, and is not cut by the per-ref bound. */
    function expectFlaggedCutBody(text: string): void {
      expect(text.length).toBeLessThanOrEqual(MAX_REF_CONTEXT_CHARS);
      expect(text).not.toMatch(/\n\[truncated\]$/);
      expect(text).toContain('"bodyTruncated":true');
      expect(text).toContain("the body below is cut");
    }

    it("keeps the flag and the instruction of a draft with 100 recipients and a body near the cap", async () => {
      const draftId = await createDraft(tenant, "Many recipients", "y".repeat(4_900), recipients);

      const text = await expand(tenant, [draftRef(tenant, draftId)]);

      expectFlaggedCutBody(text);
      expect(text).toContain('"recipientsOmitted":');
      expect(text).not.toContain('"recipientsOmitted":0');
    });

    it("keeps the flag and the instruction of a draft whose body is escape-heavy", async () => {
      const draftId = await createDraft(tenant, "Escapes", '"\n'.repeat(2_400));

      expectFlaggedCutBody(await expand(tenant, [draftRef(tenant, draftId)]));
    });

    it("keeps the flag and the instruction of a draft whose body is emoji", async () => {
      const draftId = await createDraft(tenant, "Emoji", "😀".repeat(4_900));

      expectFlaggedCutBody(await expand(tenant, [draftRef(tenant, draftId)]));
    });

    it("leaves a short draft whole, and not flagged", async () => {
      const draftId = await createDraft(tenant, "Short", "A short text.");

      const text = await expand(tenant, [draftRef(tenant, draftId)]);

      expect(text).toContain('"body":"A short text."');
      expect(text).toContain('"bodyTruncated":false');
      expect(text).not.toMatch(/\n\[truncated\]/);
    });

    it("tells the model, in each section of a turn with many refs, how to read a section the turn bound cut", async () => {
      const draftId = await createDraft(tenant, "Long", "z".repeat(4_900));
      const refs = Array.from({ length: 6 }, () => draftRef(tenant, draftId));

      const text = await expand(tenant, refs);

      // 6 sections of about 7000 units exceed the 32000 of the turn, so the bound cuts them.
      expect(text.match(/\n\[truncated\]/g)?.length).toBeGreaterThan(0);
      expect(text.split("\n\n").filter((section) => section.includes("mail.draft.update tool")).length).toBe(6);
      expect(text.match(/If this reference ends with the line \[truncated\]/g)?.length).toBe(6);
    });
  });
});
