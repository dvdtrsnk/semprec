import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { CORE_TASK_NAMES, runOnce } from "@semprec/queue";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { findOrCreateBlob } from "../../blobs/blobsStore.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { withTransaction } from "../../db/pool.js";
import { runTenantCutoverMigrations } from "../../db/tenantCutoverMigrations.js";
import { loadFullModuleRegistry } from "../../manifest/fullModuleRegistry.js";
import { createActionRegistry } from "../../scheduler/actions.js";
import { seedSystem } from "../../seed/seedSystem.js";
import {
  AGENT,
  classifiedAttachment,
  OWN_ADDRESS,
  recordingStorage,
  setupMailAttachmentWorld,
  type MailAttachmentWorld as World,
} from "../../testSupport/mailAttachmentFixtures.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createCoreTaskList } from "../../worker.js";
import { ingestAttachments } from "../attachments.js";
import { ingestEmailMessage } from "../ingest.js";
import {
  createMailDraftAttachmentAddRouteHandler,
  createMailDraftCreateRouteHandler,
} from "../mailDraftRouteHandlers.js";
import { reassignThread } from "../mailMessageMetaStore.js";
import { THREAD_ATTACHMENT_PROJECT_RULE_KEY } from "../threadAttachmentLinks.js";
import { runThreadAttachmentsCutoverMigration } from "../threadAttachmentsCutoverMigration.js";

const USER_ID = "7c0e2f6a-58a1-4d0e-9d55-2f1c6f7c9b02";

let admin: Pool;
let runtime: Pool;
let tenant: string;
let other: string;

const setup = (tenantId: string): Promise<World> => setupMailAttachmentWorld(runtime, tenantId);

/** Runs the queued value-link propagation jobs until none is left. */
async function runPropagation(): Promise<void> {
  const taskName = CORE_TASK_NAMES.VALUE_LINKS_PROPAGATE;
  const handler = createCoreTaskList(runtime, createActionRegistry())[taskName];
  if (!handler) throw new Error("Propagation handler missing");
  for (let pass = 0; pass < 40; pass++) {
    await runOnce({ pgPool: runtime, taskList: { [taskName]: handler } });
    if ((await queuedPropagationJobKeys()).length === 0) return;
  }
  throw new Error("Propagation queue did not drain");
}

/** The job keys of the value-link propagation jobs that are queued. */
async function queuedPropagationJobKeys(): Promise<string[]> {
  const { rows } = await admin.query<{ key: string | null }>(
    "SELECT key FROM graphile_worker.jobs WHERE task_identifier = $1 ORDER BY key",
    [CORE_TASK_NAMES.VALUE_LINKS_PROPAGATE],
  );
  return rows.map((row) => row.key ?? "");
}

/** Merges thread `fromThreadId` into `toThreadId` as the threading writer does, in one transaction of the tenant. */
function merge(world: World, fromThreadId: string, toThreadId: string): Promise<void> {
  return runInTenant(world.tenantId, () =>
    withTransaction(runtime, (client: PoolClient) => reassignThread(client, fromThreadId, toThreadId)),
  );
}

/** The value-link entry of a file that follows the project of thread item `itemId`. */
const followsProjectOf = (itemId: string) => ({
  valueKind: "inherited",
  sources: [{ kind: "item", itemId, databaseKey: "threads", propertyKey: "project", title: expect.any(String) }],
  brokenBy: null,
  brokenAt: null,
});

describe("Threads.attachments and the project of an attachment (issue gh-1898)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    other = await createTestTenant(admin);
    for (const id of [tenant, other]) await runInTenant(id, () => seedSystem(runtime));
  });

  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });

  describe("the relation, its cutover and the link rule", () => {
    interface AttachmentsSchemaRow {
      owner: string;
      owner_process: string | null;
      cardinality: string | null;
      target: string | null;
      property_id_b: string | null;
    }

    function schemaOf(world: World): Promise<AttachmentsSchemaRow[]> {
      return runInTenant(world.tenantId, () =>
        runtime.query<AttachmentsSchemaRow>(
          `SELECT p.owner, p.owner_process, r.cardinality, p.config->>'targetDatabaseId' AS target, r.property_id_b::text
           FROM properties p LEFT JOIN relation_definitions r ON r.property_id_a = p.id
           WHERE p.database_id = $1 AND p.key = 'attachments'`,
          [world.databases.threads],
        ),
      ).then((result) => result.rows);
    }

    function counts() {
      return admin
        .query<{ properties: number; edges: number; links: number }>(
          `SELECT (SELECT count(*)::int FROM properties) AS properties, (SELECT count(*)::int FROM item_relations) AS edges,
                  (SELECT count(*)::int FROM value_links) AS links`,
        )
        .then((result) => result.rows);
    }

    const EXPECTED_SCHEMA = (filesDatabaseId: string | undefined) => [
      {
        owner: "system",
        owner_process: "emails",
        cardinality: "one_to_many",
        target: filesDatabaseId,
        property_id_b: null,
      },
    ];

    it("exists on a fresh install as a one-directional one-to-many relation to Files owned by the emails process, and the cutover adds nothing there", async () => {
      const world = await setup(tenant);
      expect(await schemaOf(world)).toEqual(EXPECTED_SCHEMA(world.databases.files));
      const before = await counts();

      await runInTenant(tenant, () => runThreadAttachmentsCutoverMigration(runtime));

      expect(await counts()).toEqual(before);
      expect(await schemaOf(world)).toEqual(EXPECTED_SCHEMA(world.databases.files));
    });

    it("is added to an existing tenant by the registered cutover, a second run adds nothing, and files that exist get no edge and keep their values", async () => {
      const world = await setup(tenant);
      const project = await world.newItem("projects", { name: "Existing" });
      const file = await world.newItem("files", { name: "old.pdf" });
      await world.link(world.properties.filesProjects, file, project);
      // A tenant whose Threads schema predates issue gh-1898: the locked schema cannot lose a property publicly.
      await runInTenant(tenant, async () => {
        await runtime.query("DELETE FROM relation_definitions WHERE property_id_a = $1", [
          world.properties.threadAttachments,
        ]);
        const removed = await runtime.query("DELETE FROM properties WHERE id = $1", [
          world.properties.threadAttachments,
        ]);
        expect(removed.rowCount).toBe(1);
      });
      expect(await schemaOf(world)).toEqual([]);

      await runAsSystem("test:thread-attachments", () => runTenantCutoverMigrations(runtime));

      expect(await schemaOf(world)).toEqual(EXPECTED_SCHEMA(world.databases.files));
      const afterFirstRun = await counts();
      await runAsSystem("test:thread-attachments", () => runTenantCutoverMigrations(runtime));
      expect(await counts()).toEqual(afterFirstRun);
      const migratedProperty = await runInTenant(tenant, () =>
        runtime.query<{ id: string }>("SELECT id FROM properties WHERE database_id = $1 AND key = 'attachments'", [
          world.databases.threads,
        ]),
      );
      const edgesOfRelation = await runInTenant(tenant, () =>
        runtime.query(
          "SELECT 1 FROM item_relations r JOIN relation_definitions d ON d.id = r.relation_definition_id WHERE d.property_id_a = $1",
          [migratedProperty.rows[0]?.id],
        ),
      );
      expect(edgesOfRelation.rowCount).toBe(0);
      expect(await world.related(world.properties.filesProjects, file)).toEqual([project]);
      // The company link of the file's own project is another rule's; no link names the project of the file.
      expect((await world.linksOf(file)).projects).toBeUndefined();
    });

    it("leaves a tenant that has no Threads and Files databases unchanged", async () => {
      const bare = await createTestTenant(admin);
      const before = await counts();

      await runInTenant(bare, () => runThreadAttachmentsCutoverMigration(runtime));

      expect(await counts()).toEqual(before);
    });

    it("declares the link rule of the thread's project in the mail manifest", async () => {
      const registry = await loadFullModuleRegistry();
      const rules = await registry.getLinkRules();
      expect(
        rules.filter((rule) => rule.moduleId === "mailSync" && rule.key === THREAD_ATTACHMENT_PROJECT_RULE_KEY),
      ).toEqual([
        {
          moduleId: "mailSync",
          key: "fileProjectFromThread",
          source: { databaseKey: "threads", propertyKey: "project" },
          target: { databaseKey: "files", propertyKey: "projects" },
          via: { databaseKey: "threads", relationKey: "attachments" },
        },
      ]);
      expect(() => registry.validateLinkRules()).not.toThrow();
    });
  });

  describe("ingest", () => {
    it("writes the Threads.attachments edge and gives an attachment the project of its thread as an inherited value", async () => {
      const world = await setup(tenant);
      const first = await world.receive("<first@example.test>");
      const project = await world.newItem("projects", { name: "Web pro klienta" });
      await world.link(world.properties.threadProject, first.itemId, project);

      const reply = await world.receive("<reply@example.test>", {
        references: ["<first@example.test>"],
        attachments: ["nabidka.pdf"],
      });

      expect(reply.threadId).toBe(first.threadId);
      const [file] = reply.fileIds;
      if (!file) throw new Error("the reply brought no file");
      expect(await world.related(world.properties.threadAttachments, first.itemId)).toEqual([file]);
      expect(await world.related(world.properties.filesProjects, file)).toEqual([project]);
      expect((await world.linksOf(file)).projects).toEqual(followsProjectOf(first.itemId));
    });

    it("edges and links every attachment of a message, each file once", async () => {
      const world = await setup(tenant);
      const thread = await world.receive("<two@example.test>", { attachments: ["a.pdf", "b.pdf"] });
      const project = await world.newItem("projects", { name: "Web" });
      await world.link(world.properties.threadProject, thread.itemId, project);
      await runPropagation();

      expect(thread.fileIds).toHaveLength(2);
      expect(await world.related(world.properties.threadAttachments, thread.itemId)).toEqual(
        [...thread.fileIds].sort(),
      );
      for (const file of thread.fileIds) {
        expect(await world.related(world.properties.filesProjects, file)).toEqual([project]);
        expect((await world.linksOf(file)).projects).toEqual(followsProjectOf(thread.itemId));
      }
    });

    it("creates the link at ingest although the thread has no project yet, and a project the thread gets later reaches the file", async () => {
      const world = await setup(tenant);
      const thread = await world.receive("<early@example.test>", { attachments: ["early.pdf"] });
      const [file] = thread.fileIds;
      if (!file) throw new Error("the message brought no file");
      expect(await world.related(world.properties.filesProjects, file)).toEqual([]);
      expect((await world.linksOf(file)).projects).toEqual(followsProjectOf(thread.itemId));

      const project = await world.newItem("projects", { name: "Late" });
      await world.link(world.properties.threadProject, thread.itemId, project);
      await runPropagation();

      expect(await world.related(world.properties.filesProjects, file)).toEqual([project]);
      expect((await world.linksOf(file)).projects).toEqual(followsProjectOf(thread.itemId));
    });

    it("gives an attachment that arrives after the thread got its project that project, at ingest", async () => {
      const world = await setup(tenant);
      const first = await world.receive("<one@example.test>", { attachments: ["one.pdf"] });
      const project = await world.newItem("projects", { name: "Web" });
      await world.link(world.properties.threadProject, first.itemId, project);
      await runPropagation();

      const second = await world.receive("<two@example.test>", {
        references: ["<one@example.test>"],
        attachments: ["two.pdf"],
      });

      const [late] = second.fileIds;
      if (!late) throw new Error("the second message brought no file");
      expect(await world.related(world.properties.filesProjects, late)).toEqual([project]);
      expect((await world.linksOf(late)).projects).toEqual(followsProjectOf(first.itemId));
    });

    it("changes the project of its attachments when the thread's project changes", async () => {
      const world = await setup(tenant);
      const thread = await world.receive("<change@example.test>", { attachments: ["change.pdf"] });
      const [file] = thread.fileIds;
      if (!file) throw new Error("the message brought no file");
      const first = await world.newItem("projects", { name: "Web pro klienta" });
      const second = await world.newItem("projects", { name: "Redesign" });
      await world.link(world.properties.threadProject, thread.itemId, first);
      await runPropagation();
      expect(await world.related(world.properties.filesProjects, file)).toEqual([first]);

      await world.unlink(world.properties.threadProject, thread.itemId, first);
      await world.link(world.properties.threadProject, thread.itemId, second);
      await runPropagation();

      expect(await world.related(world.properties.filesProjects, file)).toEqual([second]);
      expect((await world.linksOf(file)).projects).toEqual(followsProjectOf(thread.itemId));
    });

    it("writes nothing for a message without attachments and does not read the Threads.attachments property", async () => {
      const world = await setup(tenant);
      // A tenant without the relation still ingests a message that brings no file.
      await runInTenant(tenant, async () => {
        await runtime.query("DELETE FROM relation_definitions WHERE property_id_a = $1", [
          world.properties.threadAttachments,
        ]);
        await runtime.query("DELETE FROM properties WHERE id = $1", [world.properties.threadAttachments]);
      });

      const thread = await world.receive("<plain@example.test>");

      expect(thread.fileIds).toEqual([]);
      expect((await admin.query("SELECT 1 FROM value_links")).rowCount).toBe(0);
    });

    it("fails the ingest of a message with an attachment in a tenant without the relation, before any byte is stored and with nothing written", async () => {
      const world = await setup(tenant);
      await runInTenant(tenant, async () => {
        await runtime.query("DELETE FROM relation_definitions WHERE property_id_a = $1", [
          world.properties.threadAttachments,
        ]);
        await runtime.query("DELETE FROM properties WHERE id = $1", [world.properties.threadAttachments]);
      });
      const written: string[] = [];

      await expect(
        runInTenant(tenant, () =>
          withTransaction(runtime, (client) =>
            ingestEmailMessage(client, {
              emailsDatabaseId: world.databases.emails!,
              filesDatabaseId: world.databases.files!,
              folderRelationPropertyId: world.properties.emailFolder,
              attachmentsRelationPropertyId: world.properties.emailAttachments,
              mailboxItemId: world.inbox.mailboxId,
              folderItemId: world.inbox.folderId,
              messageId: "<refused@example.test>",
              subject: "Refused",
              envelope: { from: { address: "klient@example.test" }, to: [{ address: OWN_ADDRESS }] },
              attachments: [classifiedAttachment("refused.pdf")],
              storage: recordingStorage(written),
              storageKeyPrefix: "thread-attachment-project",
            }),
          ),
        ),
      ).rejects.toThrow("Threads.attachments is not seeded");

      expect(written).toEqual([]);
      const rows = await admin.query(
        "SELECT (SELECT count(*)::int FROM mail_message_meta) AS messages, (SELECT count(*)::int FROM mail_attachments) AS attachments",
      );
      expect(rows.rows).toEqual([{ messages: 0, attachments: 0 }]);
    });

    it("rolls the whole message back, edge and file included, when the edge is refused", async () => {
      const world = await setup(tenant);
      const thread = await world.receive("<base@example.test>");
      // `ingestAttachments` called by hand with a thread item that is no Threads item: the edge write is refused after the file exists.
      const emailItem = thread.emailItemId;
      await expect(
        runInTenant(tenant, () =>
          withTransaction(runtime, (client) =>
            ingestAttachments(client, {
              messageItemId: emailItem,
              threadItemId: randomUUID(),
              filesDatabaseId: world.databases.files!,
              attachmentsRelationPropertyId: world.properties.emailAttachments,
              attachments: [classifiedAttachment("orphan.pdf")],
              storage: recordingStorage(),
              storageKeyPrefix: "thread-attachment-project",
            }),
          ),
        ),
      ).rejects.toThrow();

      expect(await world.related(world.properties.emailAttachments, emailItem)).toEqual([]);
      const files = await runInTenant(tenant, () =>
        runtime.query("SELECT 1 FROM items WHERE database_id = $1", [world.databases.files]),
      );
      expect(files.rowCount).toBe(0);
    });
  });

  describe("a change made by hand", () => {
    async function threadWithFollowingFile() {
      const world = await setup(tenant);
      const thread = await world.receive("<hand@example.test>", { attachments: ["hand.pdf"] });
      const [file] = thread.fileIds;
      if (!file) throw new Error("the message brought no file");
      const project = await world.newItem("projects", { name: "Web pro klienta" });
      await world.link(world.properties.threadProject, thread.itemId, project);
      await runPropagation();
      expect(await world.related(world.properties.filesProjects, file)).toEqual([project]);
      return { world, thread, file, project };
    }

    it("ends the link when a user replaces the file's project: a later project of the thread does not touch the file, and a relink restores following", async () => {
      const { world, thread, file, project } = await threadWithFollowingFile();
      const own = await world.newItem("projects", { name: "Own" });
      const next = await world.newItem("projects", { name: "Next" });

      await world.unlink(world.properties.filesProjects, file, project);
      await world.link(world.properties.filesProjects, file, own);

      const broken = (await world.linksOf(file)).projects;
      expect(broken).toMatchObject({ valueKind: "inheritedBroken", brokenBy: "user" });
      await world.unlink(world.properties.threadProject, thread.itemId, project);
      await world.link(world.properties.threadProject, thread.itemId, next);
      await runPropagation();
      expect(await world.related(world.properties.filesProjects, file)).toEqual([own]);

      await runInTenant(tenant, () => world.cp.relinkValue({ itemId: file, propertyKey: "projects" }));

      expect(await world.related(world.properties.filesProjects, file)).toEqual([next]);
      expect((await world.linksOf(file)).projects).toEqual(followsProjectOf(thread.itemId));
    });

    it("ends the link when a user adds a second project to the file, and keeps both", async () => {
      const { world, file, project } = await threadWithFollowingFile();
      const added = await world.newItem("projects", { name: "Added" });

      await world.link(world.properties.filesProjects, file, added);

      expect((await world.linksOf(file)).projects).toMatchObject({ valueKind: "inheritedBroken", brokenBy: "user" });
      expect(await world.related(world.properties.filesProjects, file)).toEqual([project, added].sort());
    });

    it("ends the link with the unlink operation, keeps the file's project, and a relink follows the thread again", async () => {
      const { world, thread, file, project } = await threadWithFollowingFile();
      const next = await world.newItem("projects", { name: "Next" });

      await runInTenant(tenant, () => world.cp.unlinkValue({ itemId: file, propertyKey: "projects" }, "user"));

      expect(await world.related(world.properties.filesProjects, file)).toEqual([project]);
      expect((await world.linksOf(file)).projects).toMatchObject({ valueKind: "inheritedBroken", brokenBy: "user" });
      await world.unlink(world.properties.threadProject, thread.itemId, project);
      await world.link(world.properties.threadProject, thread.itemId, next);
      await runPropagation();
      expect(await world.related(world.properties.filesProjects, file)).toEqual([project]);

      await runInTenant(tenant, () => world.cp.relinkValue({ itemId: file, propertyKey: "projects" }));

      expect(await world.related(world.properties.filesProjects, file)).toEqual([next]);
    });

    it("ends the link when Semp writes the file's project as an agent", async () => {
      const { world, file } = await threadWithFollowingFile();
      const proposed = await world.newItem("projects", { name: "Proposed" });

      await world.link(world.properties.filesProjects, file, proposed, AGENT);

      expect((await world.linksOf(file)).projects).toMatchObject({ valueKind: "inheritedBroken", brokenBy: "agent" });
    });

    it("keeps the link of the file when the system writes the project: a thread project change leaves it `on`", async () => {
      const { world, thread, file, project } = await threadWithFollowingFile();
      const next = await world.newItem("projects", { name: "Next" });

      await world.unlink(world.properties.threadProject, thread.itemId, project);
      await world.link(world.properties.threadProject, thread.itemId, next);
      await runPropagation();

      expect(await world.related(world.properties.filesProjects, file)).toEqual([next]);
      expect((await world.linksOf(file)).projects).toMatchObject({ valueKind: "inherited", brokenBy: null });
    });
  });

  describe("a file attached from an existing Files item", () => {
    const ctx = (params: Record<string, string>, body: unknown) => ({
      params,
      body,
      identity: { user: { id: USER_ID, locale: "en" } },
    });

    async function draftOf(world: World): Promise<string> {
      const answer = await runInTenant(world.tenantId, () =>
        createMailDraftCreateRouteHandler(runtime)(
          ctx(
            {},
            {
              mailboxId: world.inbox.mailboxId,
              from: OWN_ADDRESS,
              to: [{ address: "klient@example.test" }],
              cc: [],
              bcc: [],
              subject: "Re: nabídka",
              body: "Dobrý den",
            },
          ),
        ),
      );
      return answer.body.id;
    }

    function attach(world: World, draftId: string, fileItemId: string) {
      return runInTenant(world.tenantId, () =>
        createMailDraftAttachmentAddRouteHandler(runtime, { maxFileSizeBytes: 10 * 1024 * 1024 })(
          ctx({ id: draftId }, { fileItemId }),
        ),
      );
    }

    it("keeps the project of an uploaded file that is attached to a draft, and links nothing: no thread edge, no value link", async () => {
      const world = await setup(tenant);
      const thread = await world.receive("<reply-to@example.test>");
      const threadProject = await world.newItem("projects", { name: "Thread project" });
      await world.link(world.properties.threadProject, thread.itemId, threadProject);
      const own = await world.newItem("projects", { name: "Own project" });
      const upload = await runInTenant(tenant, () =>
        withTransaction(runtime, async (client) => {
          const blob = await findOrCreateBlob(client, {
            mimeType: "application/pdf",
            byteSize: 10,
            storageKey: `${randomUUID()}/upload.pdf`,
            contentHash: randomUUID(),
          });
          return createItemWithClient(client, {
            databaseId: world.databases.files!,
            properties: { name: "upload.pdf", file: { blobId: blob.id } },
          });
        }),
      );
      await world.link(world.properties.filesProjects, upload.id, own);
      const draftId = await draftOf(world);
      await runPropagation();

      const answer = await attach(world, draftId, upload.id);

      expect(answer.status).toBe(200);
      expect(await world.related(world.properties.filesProjects, upload.id)).toEqual([own]);
      expect(await world.related(world.properties.threadAttachments, thread.itemId)).toEqual([]);
      expect((await world.linksOf(upload.id)).projects).toBeUndefined();
      expect(await queuedPropagationJobKeys()).toEqual([]);
    });

    it("keeps the project of an ingested attachment that a draft copies, and the copy has no thread edge, no project and no link", async () => {
      const world = await setup(tenant);
      const thread = await world.receive("<with-file@example.test>", { attachments: ["offer.pdf"] });
      const [original] = thread.fileIds;
      if (!original) throw new Error("the message brought no file");
      const project = await world.newItem("projects", { name: "Web pro klienta" });
      await world.link(world.properties.threadProject, thread.itemId, project);
      await runPropagation();
      const draftId = await draftOf(world);

      await attach(world, draftId, original);

      expect(await world.related(world.properties.filesProjects, original)).toEqual([project]);
      expect((await world.linksOf(original)).projects).toEqual(followsProjectOf(thread.itemId));
      expect(await world.related(world.properties.threadAttachments, thread.itemId)).toEqual([original]);
      const copies = await runInTenant(tenant, () =>
        runtime.query<{ id: string }>("SELECT id FROM items WHERE database_id = $1 AND id <> $2", [
          world.databases.files,
          original,
        ]),
      );
      expect(copies.rows).toHaveLength(1);
      const copyId = copies.rows[0]?.id ?? "";
      expect(await world.related(world.properties.filesProjects, copyId)).toEqual([]);
      expect((await world.linksOf(copyId)).projects).toBeUndefined();
    });
  });

  describe("a thread merge", () => {
    it("makes the loser's attachments follow the winner's project, and later changes of it", async () => {
      const world = await setup(tenant);
      const winner = await world.receive("<winner@example.test>", { attachments: ["winner.pdf"] });
      const loser = await world.receive("<loser@example.test>", { attachments: ["loser.pdf"] });
      const [winnerFile] = winner.fileIds;
      const [loserFile] = loser.fileIds;
      if (!winnerFile || !loserFile) throw new Error("a message brought no file");
      const winnerProject = await world.newItem("projects", { name: "Winner project" });
      const loserProject = await world.newItem("projects", { name: "Loser project" });
      await world.link(world.properties.threadProject, winner.itemId, winnerProject);
      await world.link(world.properties.threadProject, loser.itemId, loserProject);
      await runPropagation();
      expect(await world.related(world.properties.filesProjects, loserFile)).toEqual([loserProject]);

      await merge(world, loser.threadId, winner.threadId);
      await runPropagation();

      expect(await world.related(world.properties.threadAttachments, winner.itemId)).toEqual(
        [winnerFile, loserFile].sort(),
      );
      expect(await world.related(world.properties.filesProjects, loserFile)).toEqual([winnerProject]);
      expect((await world.linksOf(loserFile)).projects).toEqual(followsProjectOf(winner.itemId));
      expect((await world.linksOf(winnerFile)).projects).toEqual(followsProjectOf(winner.itemId));

      const next = await world.newItem("projects", { name: "Next" });
      await world.unlink(world.properties.threadProject, winner.itemId, winnerProject);
      await world.link(world.properties.threadProject, winner.itemId, next);
      await runPropagation();

      expect(await world.related(world.properties.filesProjects, loserFile)).toEqual([next]);
      expect(await world.related(world.properties.filesProjects, winnerFile)).toEqual([next]);
    });

    it("moves the loser's project to a winner that has none, and the attachments of both follow it", async () => {
      const world = await setup(tenant);
      const winner = await world.receive("<winner@example.test>", { attachments: ["winner.pdf"] });
      const loser = await world.receive("<loser@example.test>", { attachments: ["loser.pdf"] });
      const [winnerFile] = winner.fileIds;
      const [loserFile] = loser.fileIds;
      if (!winnerFile || !loserFile) throw new Error("a message brought no file");
      const loserProject = await world.newItem("projects", { name: "Loser project" });
      await world.link(world.properties.threadProject, loser.itemId, loserProject);
      await runPropagation();

      await merge(world, loser.threadId, winner.threadId);
      await runPropagation();

      expect(await world.related(world.properties.threadProject, winner.itemId)).toEqual([loserProject]);
      for (const file of [winnerFile, loserFile]) {
        expect(await world.related(world.properties.filesProjects, file)).toEqual([loserProject]);
        expect((await world.linksOf(file)).projects).toEqual(followsProjectOf(winner.itemId));
      }
    });

    it("keeps the file's own project when its link was ended before the merge, and a relink then follows the winner", async () => {
      const world = await setup(tenant);
      const winner = await world.receive("<winner@example.test>");
      const loser = await world.receive("<loser@example.test>", { attachments: ["loser.pdf"] });
      const [loserFile] = loser.fileIds;
      if (!loserFile) throw new Error("the message brought no file");
      const winnerProject = await world.newItem("projects", { name: "Winner project" });
      const loserProject = await world.newItem("projects", { name: "Loser project" });
      const own = await world.newItem("projects", { name: "Own" });
      await world.link(world.properties.threadProject, winner.itemId, winnerProject);
      await world.link(world.properties.threadProject, loser.itemId, loserProject);
      await runPropagation();
      await world.unlink(world.properties.filesProjects, loserFile, loserProject);
      await world.link(world.properties.filesProjects, loserFile, own);

      await merge(world, loser.threadId, winner.threadId);
      await runPropagation();

      expect(await world.related(world.properties.filesProjects, loserFile)).toEqual([own]);
      expect((await world.linksOf(loserFile)).projects).toMatchObject({
        valueKind: "inheritedBroken",
        brokenBy: "user",
        sources: [{ kind: "item", itemId: winner.itemId, databaseKey: "threads", propertyKey: "project" }],
      });

      await runInTenant(tenant, () => world.cp.relinkValue({ itemId: loserFile, propertyKey: "projects" }));

      expect(await world.related(world.properties.filesProjects, loserFile)).toEqual([winnerProject]);
      expect((await world.linksOf(loserFile)).projects).toEqual(followsProjectOf(winner.itemId));
    });

    it("queues the propagation of the winner's attachments when it repoints a link", async () => {
      const world = await setup(tenant);
      const winner = await world.receive("<winner@example.test>");
      const loser = await world.receive("<loser@example.test>", { attachments: ["loser.pdf"] });
      await runPropagation();
      expect(await queuedPropagationJobKeys()).toEqual([]);

      await merge(world, loser.threadId, winner.threadId);

      // The value merge of gh-1869 queues the jobs of every rule that follows `Threads.project` of the winner, so the
      // queue holds other jobs too; the job of the attachment rule for the winner is among them.
      expect(await queuedPropagationJobKeys()).toContain(
        `valueLinksPropagate:${tenant}:${THREAD_ATTACHMENT_PROJECT_RULE_KEY}:${winner.itemId}:1`,
      );
    });

    it("moves no link when the loser has no attachment", async () => {
      const world = await setup(tenant);
      const winner = await world.receive("<winner@example.test>", { attachments: ["winner.pdf"] });
      const loser = await world.receive("<loser@example.test>");
      const [winnerFile] = winner.fileIds;
      if (!winnerFile) throw new Error("the message brought no file");
      await runPropagation();

      await merge(world, loser.threadId, winner.threadId);

      // The value merge of gh-1869 queues the jobs of the rules that follow `Threads.project` whatever the
      // attachments are, so the queue is not asserted here.
      expect((await world.linksOf(winnerFile)).projects).toEqual(followsProjectOf(winner.itemId));
    });

    it("merges threads of a tenant that has no Threads.attachments relation", async () => {
      const world = await setup(tenant);
      const winner = await world.receive("<winner@example.test>");
      const loser = await world.receive("<loser@example.test>");
      await runInTenant(tenant, async () => {
        await runtime.query("DELETE FROM relation_definitions WHERE property_id_a = $1", [
          world.properties.threadAttachments,
        ]);
        await runtime.query("DELETE FROM properties WHERE id = $1", [world.properties.threadAttachments]);
      });

      await merge(world, loser.threadId, winner.threadId);

      const remaining = await runInTenant(tenant, () =>
        runtime.query("SELECT 1 FROM mail_threads WHERE id = $1", [loser.threadId]),
      );
      expect(remaining.rowCount).toBe(0);
    });
  });

  describe("tenant isolation", () => {
    it("never carries a project, an edge or a link of one tenant to a file of another, through the runtime role", async () => {
      const a = await setup(tenant);
      const b = await setup(other);
      const role = await runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      );
      expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      const threadA = await a.receive("<same-id@example.test>", { attachments: ["a.pdf"] });
      const threadB = await b.receive("<same-id@example.test>", { attachments: ["b.pdf"] });
      const projectA = await a.newItem("projects", { name: "Project of A" });
      await a.link(a.properties.threadProject, threadA.itemId, projectA);
      await runPropagation();
      const [fileA] = threadA.fileIds;
      const [fileB] = threadB.fileIds;
      if (!fileA || !fileB) throw new Error("a message brought no file");

      expect(await a.related(a.properties.filesProjects, fileA)).toEqual([projectA]);
      expect(await b.related(b.properties.filesProjects, fileB)).toEqual([]);
      expect((await b.linksOf(fileB)).projects).toEqual(followsProjectOf(threadB.itemId));
      // B cannot see A's thread edge, A's file or A's link.
      expect(await b.related(b.properties.threadAttachments, threadA.itemId)).toEqual([]);
      expect(await b.linksOf(fileA)).toEqual({});
      const sourcesSeenByB = await runInTenant(other, () =>
        runtime.query<{ source_item_id: string }>("SELECT source_item_id FROM value_link_sources"),
      );
      expect(sourcesSeenByB.rows.map((row) => row.source_item_id)).toEqual([threadB.itemId]);

      // A merge in A does not touch B's links.
      const secondA = await a.receive("<second@example.test>", { attachments: ["a2.pdf"] });
      await merge(a, secondA.threadId, threadA.threadId);
      await runPropagation();
      expect(await b.related(b.properties.filesProjects, fileB)).toEqual([]);
      expect((await b.linksOf(fileB)).projects).toEqual(followsProjectOf(threadB.itemId));
    });
  });
});
