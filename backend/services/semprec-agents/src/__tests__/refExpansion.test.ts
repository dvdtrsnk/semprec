import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BlobReadCleanupError, labeledSempMessageRefSchema, runInTenant } from "@semprec/shared";
import {
  createChokePoint,
  createAgentRun,
  createDocStore,
  createItemWithClient,
  createPendingApprovalRequest,
  claimSempMessage,
  createRelationWithClient,
  createSempChatThread,
  createSemprecTickAction,
  createUser,
  finishSempMessageTurn,
  getDatabaseByModuleId,
  ingestUploadedBlob,
  insertAgentRunEvent,
  listPropertiesByDatabase,
  LocalFsBlobStorageWriter,
  resolveMailModuleIds,
  sendSempMessage,
  seedSystem,
  startSempMessageTurn,
  withTransaction,
  writeComputed,
  type SempReplyStep,
} from "@semprec/data";
import {
  createRuntimeRolePool,
  createTestTenant,
  createInboxItemWithClient,
  createSeriesOccurrence,
  ensureFolderItem,
  getTestPool,
  ingestEmailMessage,
  resetDatabase,
  reviseProposalWithClient,
  startTaskSeries,
} from "@semprec/data/testSupport";
import { expandSempRefs } from "../refExpansion.js";

function pdfFixture(): Buffer {
  const stream = "BT /F1 24 Tf 20 100 Td (PDF reference sentinel) Tj ET";
  const objects = [
    "",
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 300 300] /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 1; i < objects.length; i += 1) {
    offsets[i] = Buffer.byteLength(body);
    body += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body);
  body += "xref\n0 6\n0000000000 65535 f \n";
  for (let i = 1; i <= 5; i += 1) body += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  return Buffer.from(`${body}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
}

describe("tenant-scoped reference blob expansion", () => {
  let admin: Pool;
  let runtime: Pool;
  let tenant: string;
  let foreign: string;
  let root: string;
  let files: LocalFsBlobStorageWriter;
  let mailAttachments: LocalFsBlobStorageWriter;

  beforeAll(async () => {
    admin = getTestPool();
    await resetDatabase(admin);
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    tenant = await createTestTenant(admin);
    foreign = await createTestTenant(admin);
    await createUser(admin, { tenantId: tenant, email: `${randomUUID()}@example.test`, passwordHash: "unused" });
    await runInTenant(tenant, () => seedSystem(runtime));
    await runInTenant(foreign, () => seedSystem(runtime));
    root = await mkdtemp(join(tmpdir(), "semp-ref-expansion-"));
    files = new LocalFsBlobStorageWriter(join(root, "files"));
    mailAttachments = new LocalFsBlobStorageWriter(join(root, "mail"));
  });
  afterAll(async () => {
    const errors: unknown[] = [];
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
    try {
      if (root) await rm(root, { recursive: true, force: true });
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) throw new AggregateError(errors, "Reference fixture cleanup failed", { cause: errors[0] });
  });

  async function createFile(owner: string, name: string, bytes: Buffer) {
    return runInTenant(owner, async () => {
      const upload = await ingestUploadedBlob(runtime, {
        mimeType: "application/octet-stream",
        source: Readable.from([bytes]),
        maxBytes: bytes.length + 1,
        storage: files,
      });
      const db = await withTransaction(runtime, (client) => getDatabaseByModuleId(client, "files"));
      if (!db) throw new Error("Missing Files database");
      const item = await createChokePoint(runtime).createItem({
        databaseId: db.id,
        properties: { name, file: { blobId: upload.blob.id } },
      });
      return { kind: "item" as const, databaseId: db.id, itemId: item.id };
    });
  }

  it("expands actual item, block, transcript, run and approval refs without writes", async () => {
    const databases = await runInTenant(tenant, () =>
      withTransaction(runtime, async (client) => ({
        tasks: await getDatabaseByModuleId(client, "tasks"),
        transcripts: await getDatabaseByModuleId(client, "transcripts"),
        projects: await getDatabaseByModuleId(client, "projects"),
        people: await getDatabaseByModuleId(client, "people"),
        companies: await getDatabaseByModuleId(client, "companies"),
      })),
    );
    if (!databases.tasks || !databases.transcripts || !databases.projects || !databases.people || !databases.companies)
      throw new Error("Missing reference fixture databases");
    const cp = createChokePoint(runtime);
    const page = await runInTenant(tenant, () =>
      cp.createItem({ databaseId: databases.tasks!.id, properties: { name: "Page sentinel" } }),
    );
    const transcript = await runInTenant(tenant, () =>
      cp.createItem({ databaseId: databases.transcripts!.id, properties: { name: "Transcript sentinel" } }),
    );
    const project = await runInTenant(tenant, () =>
      cp.createItem({ databaseId: databases.projects!.id, properties: { name: "Project relation sentinel" } }),
    );
    const person = await runInTenant(tenant, () =>
      cp.createItem({ databaseId: databases.people!.id, properties: { name: "Person relation sentinel" } }),
    );
    const company = await runInTenant(tenant, () =>
      cp.createItem({ databaseId: databases.companies!.id, properties: { name: "Company relation sentinel" } }),
    );
    const first = randomUUID();
    const sibling = randomUUID();
    const parent = randomUUID();
    await runInTenant(tenant, async () => {
      const docs = createDocStore(runtime);
      await docs.putBlock(page.id, { id: first, flavour: "paragraph", fields: { text: "Block sentinel" } }, "user");
      await docs.putBlock(page.id, { id: sibling, flavour: "paragraph", fields: { text: "Sibling sentinel" } }, "user");
      await docs.putBlock(page.id, { id: parent, flavour: "page", children: [first, sibling] }, "user");
      await withTransaction(runtime, async (client) => {
        await writeComputed(
          client,
          databases.transcripts!.id,
          transcript.id,
          "segments",
          Array.from({ length: 9 }, (_, index) => ({
            speaker: "SPEAKER_00",
            text: `Segment ${index} sentinel`,
            startsAt: index,
            endsAt: index + 1,
          })),
        );
        await writeComputed(client, databases.transcripts!.id, transcript.id, "summary", "Transcript summary sentinel");
        const speaker = (await listPropertiesByDatabase(client, databases.transcripts!.id)).find(
          (entry) => entry.key === "speakers",
        );
        if (!speaker) throw new Error("Missing transcript speakers relation");
        await createRelationWithClient(client, {
          relationPropertyId: speaker.id,
          callerItemId: transcript.id,
          targetItemId: person.id,
          metadata: { speaker: "SPEAKER_00" },
        });
        const taskProperties = await listPropertiesByDatabase(client, databases.tasks!.id);
        const projectProperties = await listPropertiesByDatabase(client, databases.projects!.id);
        const links = [
          {
            property: taskProperties.find((entry) => entry.key === "project"),
            callerItemId: page.id,
            targetItemId: project.id,
          },
          {
            property: projectProperties.find((entry) => entry.key === "people"),
            callerItemId: project.id,
            targetItemId: person.id,
          },
          {
            property: projectProperties.find((entry) => entry.key === "company"),
            callerItemId: project.id,
            targetItemId: company.id,
          },
        ];
        for (const link of links) {
          if (!link.property) throw new Error("Missing reference relation property");
          await createRelationWithClient(client, {
            relationPropertyId: link.property.id,
            callerItemId: link.callerItemId,
            targetItemId: link.targetItemId,
          });
        }
      });
    });
    const run = await runInTenant(tenant, () =>
      withTransaction(runtime, async (client) => {
        const created = await createAgentRun(client, { triggeredBy: "user", task: "Run sentinel" });
        await insertAgentRunEvent(client, created.id, "tool_use", { name: "Tool sentinel" });
        return created;
      }),
    );
    const approval = await runInTenant(tenant, () =>
      createPendingApprovalRequest(runtime, {
        agentRunId: run.id,
        toolName: "test",
        riskClass: "unclassified",
        payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
        resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
        description: { key: "approval.itemDelete", params: { itemName: "Approval sentinel" } },
      }),
    );
    const refs = [
      { kind: "item" as const, itemId: page.id, databaseId: databases.tasks.id },
      { kind: "item" as const, itemId: project.id, databaseId: databases.projects.id },
      { kind: "block" as const, itemId: page.id, blockId: first, label: "Saved block" },
      { kind: "transcriptSegment" as const, itemId: transcript.id, startsAt: 4, endsAt: 5 },
      { kind: "item" as const, itemId: transcript.id, databaseId: databases.transcripts.id },
      { kind: "agentRun" as const, agentRunId: run.id },
      { kind: "approvalRequest" as const, approvalRequestId: approval.id },
    ];
    await runInTenant(tenant, async () => {
      const snapshot = () =>
        runtime.query<{ items: number; edges: number; updates: number; events: number; approvals: number }>(
          "SELECT (SELECT count(*)::int FROM items) AS items, (SELECT count(*)::int FROM item_relations) AS edges, (SELECT count(*)::int FROM doc_updates) AS updates, (SELECT count(*)::int FROM agent_run_events) AS events, (SELECT count(*)::int FROM approval_requests) AS approvals",
        );
      const before = await snapshot();
      const result = await expandSempRefs(runtime, refs, { files, mailAttachments });
      expect(result.context.map((entry) => entry.label)).toEqual([
        "Page sentinel",
        "Project relation sentinel",
        "Saved block",
        "Transcript sentinel 0:04-0:05",
        "Transcript sentinel",
        "Run sentinel",
        "approval.itemDelete",
      ]);
      for (const sentinel of [
        "Page sentinel",
        "Project relation sentinel",
        "Person relation sentinel",
        "Company relation sentinel",
        "Block sentinel",
        "Sibling sentinel",
        "Segment 4 sentinel",
        "Transcript summary sentinel",
        "Run sentinel",
        "Tool sentinel",
        "Approval sentinel",
      ])
        expect(result.text).toContain(sentinel);
      const sections = result.text.split("\n\n");
      expect(sections).toHaveLength(7);
      for (const index of [1, 2, 3, 4, 5, 6, 7]) expect(sections[3]).toContain(`Segment ${index} sentinel`);
      expect(sections[3]).toContain("Person relation sentinel");
      expect(sections[3]).not.toContain("Segment 0 sentinel");
      expect(sections[3]).not.toContain("Segment 8 sentinel");
      expect(sections[4]).toContain("Transcript summary sentinel");
      expect(sections[4]).toContain("Segment 0 sentinel");
      expect(sections[4]).toContain("Segment 8 sentinel");
      expect(result.images).toEqual([]);
      expect(JSON.stringify(result.context)).not.toContain("Sibling sentinel");
      expect((await snapshot()).rows).toEqual(before.rows);
    });
    const refused = await runInTenant(foreign, () => expandSempRefs(runtime, refs, { files, mailAttachments }));
    expect(refused.context.map((entry) => entry.label)).toEqual(["", "", "Saved block", "", "", "", ""]);
    expect(refused.text).not.toContain("Page sentinel");
    expect(refused.text).not.toContain("Person relation sentinel");
    expect(refused.text).not.toContain("Company relation sentinel");
    expect(refused.text).not.toContain("Tool sentinel");
    expect(refused.text).not.toContain("Approval sentinel");
  });

  it("expands an agent run ref that names an answer as that answer only, and the whole session without it (issue gh-1936)", async () => {
    const step: SempReplyStep = {
      kind: "tool",
      toolName: "stepSentinelTool",
      label: { key: "agentStep.title.sentinel", params: {} },
      detail: { key: "agentStep.detail.sentinel", params: {} },
      status: "ok",
      startedAt: "2026-11-01T10:00:00.000Z",
      durationMs: 5,
    };
    const session = await runInTenant(tenant, () =>
      withTransaction(runtime, async (client) => {
        const threadId = await createSempChatThread(client);
        const run = await createAgentRun(client, {
          triggeredBy: "user",
          unit: "session",
          task: "Session task sentinel",
          threadId,
        });
        const answers: Array<{ answerId: string }> = [];
        for (const letter of ["A", "B", "C"]) {
          const turn = await sendSempMessage(client, {
            threadId,
            text: `Question ${letter} sentinel`,
            context: [],
            hasContext: false,
          });
          expect(await claimSempMessage(client, threadId, turn.assistantMessageId)).toBe(true);
          const started = await insertAgentRunEvent(client, run.id, "turn_start", { kind: "turn_start" });
          await startSempMessageTurn(client, turn.assistantMessageId, run.id, started.id);
          const ended = await insertAgentRunEvent(client, run.id, "turn_end", { kind: "turn_end" });
          expect(
            await finishSempMessageTurn(client, turn.assistantMessageId, {
              status: "done",
              text: `Answer ${letter} sentinel`,
              lastEventId: ended.id,
              summary: {
                steps: letter === "B" ? [step] : [],
                durationMs: 5,
                tokens: { input: 0, output: 0 },
                changes: [],
              },
            }),
          ).toBe(true);
          answers.push({ answerId: turn.assistantMessageId });
        }
        return { runId: run.id, answers };
      }),
    );
    const second = session.answers[1];
    if (!second) throw new Error("Missing second answer");
    const answerRef = { kind: "agentRun" as const, agentRunId: session.runId, messageId: second.answerId };

    const answer = await runInTenant(tenant, () => expandSempRefs(runtime, [answerRef], { files, mailAttachments }));

    expect(answer.context).toEqual([{ ...answerRef, label: "Question B sentinel" }]);
    for (const sentinel of ["Question B sentinel", "Answer B sentinel", "stepSentinelTool"])
      expect(answer.text).toContain(sentinel);
    for (const sentinel of [
      "Question A sentinel",
      "Answer A sentinel",
      "Question C sentinel",
      "Answer C sentinel",
      "Session task sentinel",
    ])
      expect(answer.text).not.toContain(sentinel);

    const whole = await runInTenant(tenant, () =>
      expandSempRefs(runtime, [{ kind: "agentRun", agentRunId: session.runId }], { files, mailAttachments }),
    );
    expect(whole.context.map((entry) => entry.label)).toEqual(["Session task sentinel"]);
    expect(whole.text).toContain("Session task sentinel");
    expect(whole.text).not.toContain("Question B sentinel");

    const refused = await runInTenant(foreign, () => expandSempRefs(runtime, [answerRef], { files, mailAttachments }));
    expect(refused.text).toBe("agentRun: no longer exists or is unavailable.");
    expect(refused.context.map((entry) => entry.label)).toEqual([""]);
  });

  it("expands a real Inbox capture and its revised tick-created card in both directions", async () => {
    const fixture = await runInTenant(tenant, async () => {
      const databases = await withTransaction(runtime, async (client) => ({
        inbox: await getDatabaseByModuleId(client, "inbox"),
        types: await getDatabaseByModuleId(client, "inboxItemTypes"),
        proposals: await getDatabaseByModuleId(client, "processingProposals"),
        projects: await getDatabaseByModuleId(client, "projects"),
      }));
      if (!databases.inbox?.ownerProjectItemId || !databases.types || !databases.proposals || !databases.projects)
        throw new Error("Missing Inbox fixture databases");
      const source = await withTransaction(runtime, (client) =>
        createInboxItemWithClient(client, {
          inboxDatabaseId: databases.inbox!.id,
          date: "2026-11-06",
          time: "12:00",
          text: "",
        }),
      );
      const tick = createSemprecTickAction(runtime, async () => {
        throw new Error("Unexpected model computation");
      });
      await tick(
        {
          inboxDatabaseId: databases.inbox.id,
          inboxItemTypesDatabaseId: databases.types.id,
          processingProposalsDatabaseId: databases.proposals.id,
        },
        { heartbeatId: randomUUID(), projectItemId: databases.inbox.ownerProjectItemId, itemId: source.id },
      );
      const cards = await runtime.query<{ id: string }>(
        `SELECT card.id FROM items card JOIN item_relations edge ON edge.item_a = card.id OR edge.item_b = card.id
         WHERE card.database_id = $1 AND card.deleted_at IS NULL AND (edge.item_a = $2 OR edge.item_b = $2)`,
        [databases.proposals.id, source.id],
      );
      if (cards.rows.length !== 1 || !cards.rows[0]) throw new Error("Missing tick-created card");
      const project = await createChokePoint(runtime).createItem({
        databaseId: databases.projects.id,
        properties: { name: "Inbox fixture project" },
      });
      const envelope = {
        entityKind: "pageContent" as const,
        target: project.id,
        properties: { flavour: "paragraph", fields: { content: "Inbox envelope sentinel" } },
      };
      await withTransaction(runtime, (client) =>
        reviseProposalWithClient(
          client,
          { processingProposalsDatabaseId: databases.proposals!.id },
          cards.rows[0]!.id,
          { message: "Inbox revision sentinel", ...envelope },
        ),
      );
      return {
        capture: { kind: "item" as const, databaseId: databases.inbox.id, itemId: source.id },
        card: { kind: "item" as const, databaseId: databases.proposals.id, itemId: cards.rows[0].id },
        projectId: project.id,
      };
    });
    const refs = [fixture.capture, fixture.card];
    const snapshot = () =>
      runInTenant(tenant, () =>
        runtime.query<{ items: number; edges: number; fixture_items: unknown; fixture_edges: unknown }>(
          `SELECT (SELECT count(*)::int FROM items) AS items, (SELECT count(*)::int FROM item_relations) AS edges,
         (SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id) FROM items i WHERE i.id = ANY($1::uuid[])) AS fixture_items,
         (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM item_relations r WHERE r.item_a = ANY($1::uuid[]) OR r.item_b = ANY($1::uuid[])) AS fixture_edges`,
          [[fixture.capture.itemId, fixture.card.itemId]],
        ),
      );
    const before = await snapshot();
    await runInTenant(tenant, async () => {
      const result = await expandSempRefs(runtime, refs, { files, mailAttachments });
      const sections = result.text.split("\n\n");
      expect(sections).toHaveLength(2);
      expect(sections[0]).toContain('"text":""');
      expect(sections[0]).toContain(fixture.card.itemId);
      expect(sections[0]).toContain("Inbox envelope sentinel");
      expect(sections[0]).toContain("Inbox revision sentinel");
      expect(sections[1]).toContain(fixture.capture.itemId);
      expect(sections[1]).toContain(fixture.projectId);
      expect(sections[1]).toContain("Inbox revision sentinel");
      expect(result.context).toEqual(refs.map((ref) => ({ ...ref, label: expect.any(String) })));
      for (const ref of result.context) expect(labeledSempMessageRefSchema.safeParse(ref).success).toBe(true);
      expect(JSON.stringify(result.context)).not.toContain("Inbox envelope sentinel");
      const random = await expandSempRefs(
        runtime,
        refs.map((ref) => ({ ...ref, itemId: randomUUID() })),
        { files, mailAttachments },
      );
      expect(random.context.map((ref) => ref.label)).toEqual(["", ""]);
      expect(random.text).not.toContain("Inbox revision sentinel");
    });
    const foreignResult = await runInTenant(foreign, () => expandSempRefs(runtime, refs, { files, mailAttachments }));
    expect(foreignResult.context.map((ref) => ref.label)).toEqual(["", ""]);
    expect(foreignResult.text).not.toContain("Inbox envelope sentinel");
    expect(foreignResult.text).not.toContain("Inbox revision sentinel");
    expect((await snapshot()).rows).toEqual(before.rows);
  });

  it("expands task occurrence and trace refs for the agent turn, and a deleted task as a note that does not fail the turn", async () => {
    const tasks = await runInTenant(tenant, () =>
      withTransaction(runtime, (client) => getDatabaseByModuleId(client, "tasks")),
    );
    if (!tasks) throw new Error("Missing Tasks database");
    const cp = createChokePoint(runtime);
    const task = await runInTenant(tenant, () =>
      cp.createItem({
        databaseId: tasks.id,
        properties: {
          name: "Task sentinel",
          date: "2026-11-02",
          timeFrom: "09:00",
          description: "Description sentinel",
        },
      }),
    );
    const seriesId = await runInTenant(tenant, () =>
      startTaskSeries(runtime, {
        databaseId: tasks.id,
        itemId: task.id,
        mode: "fixed",
        rule: { kind: "weekdays", days: ["mon"] },
      }),
    );
    await runInTenant(tenant, () =>
      createSeriesOccurrence(runtime, {
        databaseId: tasks.id,
        seriesId,
        occurrenceDate: "2026-11-09",
        status: "notDone",
      }),
    );
    const doomed = await runInTenant(tenant, () =>
      cp.createItem({ databaseId: tasks.id, properties: { name: "Doomed sentinel", date: "2026-11-03" } }),
    );
    const refs = [
      { kind: "taskOccurrence" as const, seriesId, occurrenceDate: "2026-11-16" },
      { kind: "taskOccurrence" as const, seriesId, occurrenceDate: "2026-11-09" },
      { kind: "taskTrace" as const, itemId: task.id, databaseId: tasks.id, traceDay: "2026-11-02" },
      { kind: "taskTrace" as const, itemId: doomed.id, databaseId: tasks.id, traceDay: "2026-11-03", label: "Saved" },
    ];
    await runInTenant(tenant, () => cp.softDeleteItem(tasks.id, doomed.id));

    const result = await runInTenant(tenant, () => expandSempRefs(runtime, refs, { files, mailAttachments }));

    const sections = result.text.split("\n\n");
    expect(sections).toHaveLength(4);
    expect(sections[0]).toContain("taskOccurrence: Task sentinel");
    expect(sections[0]).toContain('"occurrenceDate":"2026-11-16"');
    expect(sections[0]).toContain("Description sentinel");
    expect(sections[0]).toContain(seriesId);
    expect(sections[0]).not.toContain("persistent");
    expect(sections[1]).toContain('"occurrenceDate":"2026-11-09"');
    expect(sections[2]).toContain("taskTrace: Task sentinel");
    expect(sections[2]).toContain('"traceDay":"2026-11-02"');
    expect(sections[2]).toContain("Description sentinel");
    expect(sections[3]).toBe("taskTrace: no longer exists or is unavailable.");
    expect(result.context.map((ref) => ref.label)).toEqual([
      "Task sentinel",
      "Task sentinel",
      "Task sentinel",
      "Saved",
    ]);
    for (const ref of result.context) expect(labeledSempMessageRefSchema.safeParse(ref).success).toBe(true);

    // A series of another tenant is as unavailable as one that never existed, and shows nothing of it.
    const foreignTasks = await runInTenant(foreign, () =>
      withTransaction(runtime, (client) => getDatabaseByModuleId(client, "tasks")),
    );
    if (!foreignTasks) throw new Error("Missing foreign Tasks database");
    const foreignTask = await runInTenant(foreign, () =>
      cp.createItem({ databaseId: foreignTasks.id, properties: { name: "Foreign task sentinel", date: "2026-11-02" } }),
    );
    const foreignSeries = await runInTenant(foreign, () =>
      startTaskSeries(runtime, {
        databaseId: foreignTasks.id,
        itemId: foreignTask.id,
        mode: "fixed",
        rule: { kind: "weekdays", days: ["mon"] },
      }),
    );
    const foreignRefs = [{ kind: "taskOccurrence" as const, seriesId: foreignSeries, occurrenceDate: "2026-11-16" }];
    const unavailable = await runInTenant(tenant, () =>
      expandSempRefs(runtime, foreignRefs, { files, mailAttachments }),
    );
    expect(unavailable.text).toBe("taskOccurrence: no longer exists or is unavailable.");
    expect(unavailable.text).not.toContain("Foreign task sentinel");
  });

  // Projects, not Tasks: a deleted Tasks item expands as unavailable (next test), other trashed items keep the marker.
  it("marks only an own trashed item during direct tenant-scoped expansion", async () => {
    const ownDatabase = await runInTenant(tenant, () =>
      withTransaction(runtime, (client) => getDatabaseByModuleId(client, "projects")),
    );
    const foreignDatabase = await runInTenant(foreign, () =>
      withTransaction(runtime, (client) => getDatabaseByModuleId(client, "projects")),
    );
    if (!ownDatabase || !foreignDatabase) throw new Error("Missing project databases");
    const cp = createChokePoint(runtime);
    const active = await runInTenant(tenant, () =>
      cp.createItem({ databaseId: ownDatabase.id, properties: { name: "Active marker control" } }),
    );
    const trashed = await runInTenant(tenant, () =>
      cp.createItem({ databaseId: ownDatabase.id, properties: { name: "Trashed marker sentinel" } }),
    );
    const privateItem = await runInTenant(foreign, () =>
      cp.createItem({ databaseId: foreignDatabase.id, properties: { name: "Foreign trash sentinel" } }),
    );
    await runInTenant(tenant, () => cp.softDeleteItem(ownDatabase.id, trashed.id));
    await runInTenant(foreign, () => cp.softDeleteItem(foreignDatabase.id, privateItem.id));
    const refs = [
      { kind: "item" as const, itemId: active.id, databaseId: ownDatabase.id },
      { kind: "item" as const, itemId: trashed.id, databaseId: ownDatabase.id, label: "Saved trash label" },
      { kind: "item" as const, itemId: privateItem.id, databaseId: foreignDatabase.id },
      { kind: "item" as const, itemId: randomUUID(), databaseId: ownDatabase.id },
    ];
    const snapshot = () =>
      runInTenant(tenant, () =>
        withTransaction(runtime, (client) =>
          client.query<{
            items: unknown;
            edges: number;
            docs: number;
            messages: number;
            runs: number;
            events: number;
            jobs: number;
          }>(
            `SELECT (SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id) FROM items i WHERE i.id = ANY($1::uuid[])) AS items,
             (SELECT count(*)::int FROM item_relations) AS edges, (SELECT count(*)::int FROM doc_updates) AS docs,
             (SELECT count(*)::int FROM semp_messages) AS messages, (SELECT count(*)::int FROM agent_runs) AS runs,
             (SELECT count(*)::int FROM agent_run_events) AS events, (SELECT count(*)::int FROM graphile_worker.jobs) AS jobs`,
            [[active.id, trashed.id]],
          ),
        ),
      );
    const before = await snapshot();
    const foreignSnapshot = () =>
      runInTenant(foreign, () =>
        withTransaction(runtime, (client) =>
          client.query<{ id: string; trashed: boolean }>(
            "SELECT id, deleted_at IS NOT NULL AS trashed FROM items WHERE id = $1",
            [privateItem.id],
          ),
        ),
      );
    const foreignBefore = await foreignSnapshot();
    expect(foreignBefore.rows).toEqual([{ id: privateItem.id, trashed: true }]);
    const result = await runInTenant(tenant, () => expandSempRefs(runtime, refs, { files, mailAttachments }));
    const sections = result.text.split("\n\n");
    expect(sections).toHaveLength(4);
    expect(sections[0]).toContain("Active marker control");
    expect(sections[0]).not.toContain("[trashed]");
    expect(sections[1]).toContain("[trashed] Trashed marker sentinel");
    expect(sections[2]).toContain("item: no longer exists or is unavailable.");
    expect(sections[2]).not.toContain("[trashed]");
    expect(sections[2]).not.toContain("Foreign trash sentinel");
    expect(sections[3]).toContain("item: no longer exists or is unavailable.");
    expect(sections[3]).not.toContain("[trashed]");
    expect(result.context).toEqual(
      refs.map((ref, index) => ({ ...ref, label: ["Active marker control", "Saved trash label", "", ""][index] })),
    );
    for (const ref of result.context) expect(labeledSempMessageRefSchema.safeParse(ref).success).toBe(true);
    expect(JSON.stringify(result.context)).not.toContain("Trashed marker sentinel");
    expect((await snapshot()).rows).toEqual(before.rows);
    expect((await foreignSnapshot()).rows).toEqual(foreignBefore.rows);
  });

  it("expands a soft-deleted Tasks item and a series whose owner was soft-deleted as unavailable, not as trashed", async () => {
    const tasks = await runInTenant(tenant, () =>
      withTransaction(runtime, (client) => getDatabaseByModuleId(client, "tasks")),
    );
    if (!tasks) throw new Error("Missing Tasks database");
    const cp = createChokePoint(runtime);
    const owner = await runInTenant(tenant, () =>
      cp.createItem({ databaseId: tasks.id, properties: { name: "Owner sentinel", date: "2026-11-02" } }),
    );
    const seriesId = await runInTenant(tenant, () =>
      startTaskSeries(runtime, {
        databaseId: tasks.id,
        itemId: owner.id,
        mode: "fixed",
        rule: { kind: "weekdays", days: ["mon"] },
      }),
    );
    const plain = await runInTenant(tenant, () =>
      cp.createItem({ databaseId: tasks.id, properties: { name: "Deleted task sentinel", date: "2026-11-03" } }),
    );
    await runInTenant(tenant, () => cp.softDeleteItem(tasks.id, owner.id));
    await runInTenant(tenant, () => cp.softDeleteItem(tasks.id, plain.id));
    const refs = [
      { kind: "taskOccurrence" as const, seriesId, occurrenceDate: "2026-11-16" },
      { kind: "item" as const, itemId: plain.id, databaseId: tasks.id, label: "Saved task label" },
    ];

    const result = await runInTenant(tenant, () => expandSempRefs(runtime, refs, { files, mailAttachments }));

    expect(result.text.split("\n\n")).toEqual([
      "taskOccurrence: no longer exists or is unavailable.",
      "item: no longer exists or is unavailable.",
    ]);
    expect(result.text).not.toContain("[trashed]");
    expect(result.text).not.toContain("sentinel");
  });

  it("extracts real PDF and DOCX bytes and turns a current image into an ephemeral JPEG", async () => {
    const docx = await readFile(join(dirname(fileURLToPath(import.meta.url)), "fixtures/reference-text.docx"));
    const image = await sharp({ create: { width: 2000, height: 1000, channels: 3, background: "#abc123" } })
      .png()
      .toBuffer();
    const refs = [
      await createFile(tenant, "PDF", pdfFixture()),
      await createFile(tenant, "DOCX", docx),
      await createFile(tenant, "Image", image),
    ];
    const opened: Readable[] = [];
    const realRead = files.readStream.bind(files);
    const observer = vi.spyOn(files, "readStream").mockImplementation((key, range) => {
      const stream = realRead(key, range);
      opened.push(stream);
      return stream;
    });
    let result: Awaited<ReturnType<typeof expandSempRefs>>;
    try {
      result = await runInTenant(tenant, () => expandSempRefs(runtime, refs, { files, mailAttachments }));
      expect(opened).toHaveLength(3);
      expect(opened.every((stream) => stream.closed)).toBe(true);
    } finally {
      observer.mockRestore();
    }
    expect(result.text).toContain("PDF reference sentinel");
    expect(result.text).toContain("DOCX reference sentinel");
    expect(result.images).toHaveLength(1);
    expect(result.images[0]?.mimeType).toBe("image/jpeg");
    expect(result.context).toHaveLength(3);
    expect(JSON.stringify(result.context)).not.toContain(result.images[0]?.data ?? "missing");
  });

  it("stops before the next reference on a synthetic post-transfer cleanup failure", async () => {
    const first = await createFile(tenant, "First PDF", pdfFixture());
    const second = await createFile(tenant, "Second PDF", Buffer.concat([pdfFixture(), Buffer.from("next")]));
    const cleanupFailure = new Error("synthetic post-read transport error");
    const realRead = files.readStream.bind(files);
    const opened: Readable[] = [];
    const observer = vi.spyOn(files, "readStream").mockImplementation((key, range) => {
      const stream = realRead(key, range);
      opened.push(stream);
      if (opened.length === 1) {
        stream.once("end", () => {
          queueMicrotask(() => stream.emit("error", cleanupFailure));
        });
      }
      return stream;
    });
    try {
      let caught: unknown;
      try {
        await runInTenant(tenant, () => expandSempRefs(runtime, [first, second], { files, mailAttachments }));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(BlobReadCleanupError);
      if (!(caught instanceof BlobReadCleanupError)) throw new Error("Missing cleanup failure");
      expect(caught.errors).toContain(cleanupFailure);
      expect(opened).toHaveLength(1);
      expect(opened[0]?.closed).toBe(true);
    } finally {
      observer.mockRestore();
    }
  });

  it("preserves an aborted read as primary when a synthetic cleanup error follows", async () => {
    const first = await createFile(tenant, "Abort PDF", pdfFixture());
    const second = await createFile(tenant, "Later PDF", Buffer.concat([pdfFixture(), Buffer.from("later")]));
    const controller = new AbortController();
    const abortReason = new Error("synthetic turn cancellation");
    const cleanupFailure = new Error("synthetic cleanup error after cancellation");
    const realRead = files.readStream.bind(files);
    const opened: Readable[] = [];
    const observer = vi.spyOn(files, "readStream").mockImplementation((key, range) => {
      const stream = realRead(key, range);
      opened.push(stream);
      if (opened.length === 1) {
        stream.once("end", () => {
          controller.abort(abortReason);
          queueMicrotask(() => stream.emit("error", cleanupFailure));
        });
      }
      return stream;
    });
    try {
      let caught: unknown;
      try {
        await runInTenant(tenant, () =>
          expandSempRefs(runtime, [first, second], { files, mailAttachments }, controller.signal),
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(BlobReadCleanupError);
      if (!(caught instanceof BlobReadCleanupError)) throw new Error("Missing cleanup failure");
      expect(caught.errors).toEqual([abortReason, cleanupFailure]);
      expect(caught.cause).toBe(abortReason);
      expect(opened).toHaveLength(1);
      expect(opened[0]?.closed).toBe(true);
    } finally {
      observer.mockRestore();
    }
  });

  it("waits for delayed post-transfer closure before returning an ordinary placeholder", async () => {
    const ref = await createFile(tenant, "Delayed PDF", pdfFixture());
    let release: (() => void) | undefined;
    const stream = new Readable({
      read() {
        this.push(Buffer.from("%PDF-corrupt"));
        this.push(null);
      },
      destroy(_error, callback) {
        release = () => callback(null);
      },
    });
    const closed = new Promise<void>((resolve) => stream.once("close", resolve));
    const realRead = files.readStream.bind(files);
    let reads = 0;
    const observer = vi.spyOn(files, "readStream").mockImplementation((key, range) => {
      reads += 1;
      return reads === 1 ? stream : realRead(key, range);
    });
    let returned = false;
    const expansion = runInTenant(tenant, () => expandSempRefs(runtime, [ref], { files, mailAttachments })).then(
      (result) => {
        returned = true;
        return result;
      },
    );
    try {
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      expect(returned).toBe(false);
      expect(stream.closed).toBe(false);
      if (!release) throw new Error("Missing controlled destroy callback");
      release();
      release = undefined;
      const result = await expansion;
      expect(stream.closed).toBe(true);
      expect(result.text).toContain("Attachment text unavailable.");
      expect(result.context).toEqual([{ ...ref, label: "Delayed PDF" }]);
    } finally {
      if (!stream.destroyed) stream.destroy();
      if (release) release();
      await closed;
      await Promise.allSettled([expansion]);
      observer.mockRestore();
    }
  });

  it.each([
    ["over-cap bytes", () => Readable.from([Buffer.alloc(10 * 1024 * 1024 + 1)])],
    ["invalid chunk", () => Readable.from([{ invalid: true }])],
    [
      "read error",
      () => {
        let started = false;
        return new Readable({
          read() {
            if (started) return;
            started = true;
            this.push(Buffer.from("%PDF-"));
            setImmediate(() => this.destroy(new Error("synthetic transport read failure")));
          },
        });
      },
    ],
  ])("closes a controlled %s stream before an unavailable note and next real ref", async (_case, createStream) => {
    const first = await createFile(tenant, "Fault PDF", pdfFixture());
    const second = await createFile(tenant, "Next PDF", Buffer.concat([pdfFixture(), Buffer.from("next")]));
    const stream = createStream();
    const realRead = files.readStream.bind(files);
    let reads = 0;
    const observer = vi.spyOn(files, "readStream").mockImplementation((key, range) => {
      reads += 1;
      return reads === 1 ? stream : realRead(key, range);
    });
    try {
      const result = await runInTenant(tenant, () =>
        expandSempRefs(runtime, [first, second], { files, mailAttachments }),
      );
      expect(stream.closed).toBe(true);
      expect(reads).toBe(2);
      expect(result.text).toContain("Attachment text unavailable.");
      expect(result.text).toContain("PDF reference sentinel");
    } finally {
      observer.mockRestore();
    }
  });

  it("waits for post-transfer cleanup before propagating a cancelled read", async () => {
    const ref = await createFile(tenant, "Cancelled PDF", pdfFixture());
    const controller = new AbortController();
    const reason = new Error("synthetic cancellation during byte read");
    let release: (() => void) | undefined;
    let started!: () => void;
    const readable = new Promise<void>((resolve) => {
      started = resolve;
    });
    const stream = new Readable({
      read() {
        this.push(Buffer.from("%PDF-"));
        started();
      },
      destroy(_error, callback) {
        release = () => callback(null);
      },
    });
    const closed = new Promise<void>((resolve) => stream.once("close", resolve));
    const observer = vi.spyOn(files, "readStream").mockReturnValue(stream);
    const outcome = runInTenant(tenant, () =>
      expandSempRefs(runtime, [ref], { files, mailAttachments }, controller.signal),
    ).then(
      () => ({ kind: "success" as const }),
      (error: unknown) => ({ kind: "failure" as const, error }),
    );
    let settled = false;
    void outcome.then(() => {
      settled = true;
    });
    try {
      await readable;
      controller.abort(reason);
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      expect(settled).toBe(false);
      expect(stream.closed).toBe(false);
      if (!release) throw new Error("Missing controlled destroy callback");
      release();
      release = undefined;
      expect(await outcome).toEqual({ kind: "failure", error: reason });
      expect(stream.closed).toBe(true);
    } finally {
      controller.abort(reason);
      if (!stream.destroyed) stream.destroy();
      if (release) release();
      await closed;
      await outcome;
      observer.mockRestore();
    }
  });

  it("fails expansion at the cleanup deadline and observes eventual stream closure", async () => {
    const first = await createFile(tenant, "Stalled PDF", pdfFixture());
    const second = await createFile(tenant, "Unreached PDF", Buffer.concat([pdfFixture(), Buffer.from("last")]));
    let release: (() => void) | undefined;
    const stream = new Readable({
      read() {
        this.push(Buffer.from("%PDF-corrupt"));
        this.push(null);
      },
      destroy(_error, callback) {
        release = () => callback(null);
      },
    });
    const closed = new Promise<void>((resolve) => stream.once("close", resolve));
    const realRead = files.readStream.bind(files);
    let reads = 0;
    const observer = vi.spyOn(files, "readStream").mockImplementation((key, range) => {
      reads += 1;
      return reads === 1 ? stream : realRead(key, range);
    });
    try {
      let caught: unknown;
      try {
        await runInTenant(tenant, () => expandSempRefs(runtime, [first, second], { files, mailAttachments }));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(BlobReadCleanupError);
      if (!(caught instanceof BlobReadCleanupError)) throw new Error("Missing cleanup deadline failure");
      expect(caught.errors).toHaveLength(1);
      expect(caught.errors[0]).toBeInstanceOf(Error);
      expect(stream.closed).toBe(false);
      expect(reads).toBe(1);
    } finally {
      if (!stream.destroyed) stream.destroy();
      if (release) release();
      await closed;
      observer.mockRestore();
    }
    expect(stream.closed).toBe(true);
  }, 15_000);

  it("expands real mail text bytes ephemerally and refuses foreign, random and invalid UTF-8 references", async () => {
    const createMail = (owner: string, attachments: Array<{ filename: string; bytes: Buffer }>) =>
      runInTenant(owner, () =>
        withTransaction(runtime, async (client) => {
          const ids = await resolveMailModuleIds(client);
          const emailProperties = await listPropertiesByDatabase(client, ids.emailsDatabaseId);
          const folderProperties = await listPropertiesByDatabase(client, ids.foldersDatabaseId);
          const attachment = emailProperties.find((property) => property.key === "attachments");
          const folder = emailProperties.find((property) => property.key === "folder");
          const mailbox = folderProperties.find((property) => property.key === "mailbox");
          if (!attachment || !folder || !mailbox) throw new Error("Missing mail fixture relations");
          const mailboxItem = await createItemWithClient(client, {
            databaseId: ids.mailboxesDatabaseId,
            properties: { name: "Mail" },
          });
          const folderId = await ensureFolderItem(client, {
            foldersDatabaseId: ids.foldersDatabaseId,
            mailboxItemId: mailboxItem.id,
            mailboxRelationPropertyId: mailbox.id,
            providerId: "INBOX",
            name: "Inbox",
            behavior: "folder",
            specialPurpose: "inbox",
          });
          const email = await ingestEmailMessage(client, {
            emailsDatabaseId: ids.emailsDatabaseId,
            filesDatabaseId: ids.filesDatabaseId,
            folderRelationPropertyId: folder.id,
            attachmentsRelationPropertyId: attachment.id,
            folderItemId: folderId,
            mailboxItemId: mailboxItem.id,
            messageId: `<${randomUUID()}@example.test>`,
            subject: "Fixture",
            envelope: {},
            attachments: attachments.map(({ filename, bytes }) => ({
              filename,
              contentType: "text/plain",
              contentId: null,
              disposition: "attachment",
              openStream: () => Readable.from([bytes]),
            })),
            storage: mailAttachments,
            storageKeyPrefix: "semp-ref-fixture",
          });
          const result = await client.query<{ id: string; filename: string; content_type: string; mime_type: string }>(
            `SELECT attachment.id, attachment.filename, attachment.content_type, blob.mime_type
           FROM mail_attachments attachment JOIN blobs blob ON blob.tenant_id = attachment.tenant_id AND blob.id = attachment.blob_id
           WHERE attachment.message_item_id = $1 ORDER BY attachment.filename`,
            [email.itemId],
          );
          return result.rows;
        }),
      );
    const own = await createMail(tenant, [
      { filename: "plain.txt", bytes: Buffer.from("Mail text fixture sentinel") },
      { filename: "invalid.txt", bytes: Buffer.from([0xff, 0xfe]) },
    ]);
    const privateRows = await createMail(foreign, [
      { filename: "private.txt", bytes: Buffer.from("Foreign fixture sentinel") },
    ]);
    const longRows = await createMail(
      tenant,
      Array.from({ length: 5 }, (_, index) => ({
        filename: `long-${index}.txt`,
        bytes: Buffer.from(`Reference ${index}: ${"x".repeat(9000)}`),
      })),
    );
    expect(own.map(({ filename, content_type, mime_type }) => ({ filename, content_type, mime_type }))).toEqual([
      { filename: "invalid.txt", content_type: "text/plain", mime_type: "text/plain" },
      { filename: "plain.txt", content_type: "text/plain", mime_type: "text/plain" },
    ]);
    const plain = own.find((row) => row.filename === "plain.txt");
    const invalid = own.find((row) => row.filename === "invalid.txt");
    const privateRow = privateRows[0];
    if (!plain || !invalid || !privateRow) throw new Error("Missing ingested fixture attachments");
    const refs = [plain.id, invalid.id, privateRow.id, randomUUID()].map((attachmentId) => ({
      kind: "mailAttachment" as const,
      attachmentId,
    }));
    await runInTenant(tenant, async () => {
      const snapshot = () =>
        runtime.query<{
          items: number;
          edges: number;
          blobs: number;
          attachments: number;
          search: number;
          attachment_rows: unknown;
          blob_rows: unknown;
          message_rows: unknown;
          search_rows: unknown;
        }>(
          `SELECT (SELECT count(*)::int FROM items) AS items,
            (SELECT count(*)::int FROM item_relations) AS edges,
            (SELECT count(*)::int FROM blobs) AS blobs,
            (SELECT count(*)::int FROM mail_attachments) AS attachments,
            (SELECT count(*)::int FROM item_search_index) AS search,
            (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM mail_attachments a WHERE a.id = ANY($1::uuid[])) AS attachment_rows,
            (SELECT jsonb_agg(to_jsonb(b) ORDER BY b.id) FROM blobs b WHERE b.id IN
              (SELECT a.blob_id FROM mail_attachments a WHERE a.id = ANY($1::uuid[]))) AS blob_rows,
            (SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id) FROM items i WHERE i.id IN
              (SELECT a.message_item_id FROM mail_attachments a WHERE a.id = ANY($1::uuid[]))) AS message_rows,
            (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.item_id) FROM item_search_index s WHERE s.item_id IN
              (SELECT a.message_item_id FROM mail_attachments a WHERE a.id = ANY($1::uuid[]))) AS search_rows`,
          [own.map((row) => row.id)],
        );
      const before = await snapshot();
      const opened: Readable[] = [];
      const realRead = mailAttachments.readStream.bind(mailAttachments);
      const observer = vi.spyOn(mailAttachments, "readStream").mockImplementation((key, range) => {
        const stream = realRead(key, range);
        opened.push(stream);
        return stream;
      });
      let result: Awaited<ReturnType<typeof expandSempRefs>>;
      try {
        result = await expandSempRefs(runtime, refs, { files, mailAttachments }, new AbortController().signal);
        expect(opened).toHaveLength(2);
        expect(opened.every((stream) => stream.closed)).toBe(true);
      } finally {
        observer.mockRestore();
      }
      expect(result.text).toContain("Mail text fixture sentinel");
      expect(result.text).toContain('"mimeType":"text/plain"');
      expect(result.text).toContain("Attachment text unavailable.");
      expect(result.text).not.toContain("Foreign fixture sentinel");
      expect(result.context.map((entry) => entry.label)).toEqual(["plain.txt", "invalid.txt", "", ""]);
      expect(result.context).toEqual(
        refs.map((ref, index) => ({ ...ref, label: ["plain.txt", "invalid.txt", "", ""][index] })),
      );
      expect(JSON.stringify(result.context)).not.toContain("Mail text fixture sentinel");
      expect(JSON.stringify(result.context)).not.toContain(
        Buffer.from("Mail text fixture sentinel").toString("base64"),
      );
      const longRefs = longRows.map(({ id }) => ({ kind: "mailAttachment" as const, attachmentId: id }));
      const single = await expandSempRefs(runtime, longRefs.slice(0, 1), { files, mailAttachments });
      expect(single.text).toHaveLength(8000);
      expect(single.text.endsWith("\n[truncated]")).toBe(true);
      const bounded = await expandSempRefs(runtime, longRefs, { files, mailAttachments });
      const sections = bounded.text.split("\n\n");
      expect(bounded.text.length).toBeLessThanOrEqual(32000);
      expect(sections).toHaveLength(5);
      expect(sections.every((section) => section.length <= 8000 && section.endsWith("\n[truncated]"))).toBe(true);
      expect(bounded.context.map((entry) => entry.label)).toEqual(longRows.map((row) => row.filename));
      expect((await snapshot()).rows).toEqual(before.rows);
    });
  });

  it("keeps metadata and finite notes for corrupt, oversized and unsupported inputs, and refuses foreign and random refs", async () => {
    const corrupt = await createFile(tenant, "Corrupt", Buffer.from("%PDF-corrupt"));
    const large = await createFile(
      tenant,
      "Large",
      Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(10 * 1024 * 1024)]),
    );
    const unknown = await createFile(tenant, "Unknown", Buffer.from("unknown payload"));
    const other = await createFile(foreign, "Private", pdfFixture());
    const before = await runInTenant(tenant, () =>
      runtime.query<{ count: number }>("SELECT count(*)::int AS count FROM blobs"),
    );
    const result = await runInTenant(tenant, () =>
      expandSempRefs(runtime, [corrupt, large, unknown, other, { ...corrupt, itemId: randomUUID() }], {
        files,
        mailAttachments,
      }),
    );
    expect(result.text).toContain("Attachment text unavailable.");
    expect(result.text).toContain("Attachment exceeds the size limit.");
    expect(result.text).toContain("Attachment type cannot be extracted.");
    expect(result.text).not.toContain("Private");
    expect(result.images).toEqual([]);
    expect(result.context.map((ref) => ref.label)).toEqual(["Corrupt", "Large", "Unknown", "", ""]);
    const after = await runInTenant(tenant, () =>
      runtime.query<{ count: number }>("SELECT count(*)::int AS count FROM blobs"),
    );
    expect(after.rows).toEqual(before.rows);
  });

  it("preserves historical labels while fresh unavailable references carry empty labels", async () => {
    const own = await createFile(tenant, "Current label", Buffer.from("unsupported"));
    const other = await createFile(foreign, "Foreign label", Buffer.from("unsupported"));
    const missing = { ...own, itemId: randomUUID() };
    const refs = [own, other, missing, { ...own, label: "Historical label" }, { ...missing, label: "Old missing" }];
    const result = await runInTenant(tenant, () => expandSempRefs(runtime, refs, { files, mailAttachments }));
    expect(result.context).toEqual([
      { ...own, label: "Current label" },
      { ...other, label: "" },
      { ...missing, label: "" },
      { ...own, label: "Historical label" },
      { ...missing, label: "Old missing" },
    ]);
    for (const ref of result.context) expect(labeledSempMessageRefSchema.safeParse(ref).success).toBe(true);
    const sections = result.text.split("\n\n");
    expect(sections).toHaveLength(refs.length);
    expect(sections[0]).toContain("item: Current label");
    expect(sections[1]).toContain("item: no longer exists or is unavailable.");
    expect(sections[2]).toContain("item: no longer exists or is unavailable.");
    expect(sections[3]).toContain("item: Current label");
    expect(sections[4]).toContain("item: no longer exists or is unavailable.");
    expect(result.text).toContain("no longer exists or is unavailable");
    expect(result.text).not.toContain("Foreign label");
  });
});
