import "../../domainWriteHooks.js";
import type { Pool, PoolClient } from "pg";
import { runInTenant } from "@semprec/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withTransaction } from "../../db/pool.js";
import { seedSystem } from "../../seed/seedSystem.js";
import {
  setupMailAttachmentWorld,
  type MailAttachmentWorld as World,
} from "../../testSupport/mailAttachmentFixtures.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { getMailThreadDetail } from "../mailThreadDetail.js";
import { createMailThreadDetailRouteHandler } from "../mailThreadRoutes.js";

let admin: Pool;
let runtime: Pool;
let tenant: string;
let other: string;

const setup = (tenantId: string): Promise<World> => setupMailAttachmentWorld(runtime, tenantId);

/** The thread detail as the route reads it: one REPEATABLE READ transaction of the tenant. */
function detailOf(tenantId: string, threadId: string) {
  return runInTenant(tenantId, () =>
    withTransaction(runtime, (client) => getMailThreadDetail(client, threadId, false), {
      isolation: "repeatable_read",
    }),
  );
}

/** The number of statements the detail of thread `threadId` runs. */
function countStatements(threadId: string): Promise<number> {
  return runInTenant(tenant, () =>
    withTransaction(
      runtime,
      async (client: PoolClient) => {
        const spy = vi.spyOn(client, "query");
        try {
          await getMailThreadDetail(client, threadId, false);
          return spy.mock.calls.length;
        } finally {
          spy.mockRestore();
        }
      },
      { isolation: "repeatable_read" },
    ),
  );
}

/** The attachments of all messages of the detail, by file name. */
function attachmentsByName(detail: Awaited<ReturnType<typeof detailOf>>) {
  return Object.fromEntries(
    detail.messages.flatMap((message) => message.attachments).map((attachment) => [attachment.filename, attachment]),
  );
}

/** The value-link entry of a file that follows the project of thread item `itemId`. */
const inheritedFrom = (itemId: string) =>
  expect.objectContaining({
    valueKind: "inherited",
    sources: [expect.objectContaining({ kind: "item", itemId, databaseKey: "threads", propertyKey: "project" })],
    brokenBy: null,
  });

describe("the project and links of the attachments in the thread detail (issue gh-1922)", () => {
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

  it("shows an attachment that inherits its thread's project with that project and the inherited link, also through the route", async () => {
    const world = await setup(tenant);
    const first = await world.receive("<first@example.test>");
    const project = await world.newItem("projects", { name: "Web pro klienta" });
    await world.link(world.properties.threadProject, first.itemId, project);
    const reply = await world.receive("<reply@example.test>", {
      references: ["<first@example.test>"],
      attachments: ["nabidka.pdf"],
    });

    const detail = await detailOf(tenant, first.threadId);

    const [file] = reply.fileIds;
    expect(attachmentsByName(detail)["nabidka.pdf"]).toMatchObject({
      fileItemId: file,
      project: { id: project, name: "Web pro klienta" },
      links: { project: inheritedFrom(first.itemId) },
    });
    // Only the project's own entry: the company link that follows the file's project is another property's.
    expect(Object.keys(attachmentsByName(detail)["nabidka.pdf"]?.links ?? {})).toEqual(["project"]);
    const routed = await runInTenant(tenant, () =>
      createMailThreadDetailRouteHandler(runtime)({ req: { url: "/" }, params: { threadId: first.threadId } }),
    );
    expect(routed.status).toBe(200);
    expect(routed.body.messages.flatMap((message) => message.attachments)).toMatchObject([
      {
        filename: "nabidka.pdf",
        project: { id: project, name: "Web pro klienta" },
        links: { project: { valueKind: "inherited" } },
      },
    ]);
  });

  it("shows the new project with inheritedBroken after a manual change of the file's project", async () => {
    const world = await setup(tenant);
    const first = await world.receive("<first@example.test>");
    const inherited = await world.newItem("projects", { name: "Inherited" });
    const own = await world.newItem("projects", { name: "Own" });
    await world.link(world.properties.threadProject, first.itemId, inherited);
    const reply = await world.receive("<reply@example.test>", {
      references: ["<first@example.test>"],
      attachments: ["manual.pdf"],
    });
    const [file] = reply.fileIds;
    if (!file) throw new Error("the message brought no file");
    expect(attachmentsByName(await detailOf(tenant, first.threadId))["manual.pdf"]?.links.project).toMatchObject({
      valueKind: "inherited",
    });

    await world.unlink(world.properties.filesProjects, file, inherited);
    await world.link(world.properties.filesProjects, file, own);

    const shown = attachmentsByName(await detailOf(tenant, first.threadId))["manual.pdf"];
    expect(shown).toMatchObject({
      project: { id: own, name: "Own" },
      links: { project: { valueKind: "inheritedBroken", brokenBy: "user" } },
    });
  });

  it("answers project null and no links entry for an attachment that has no project and no value-link row", async () => {
    const world = await setup(tenant);
    const thread = await world.receive("<legacy@example.test>", { attachments: ["legacy.pdf"] });
    // Raw SQL: an attachment ingested before issue gh-1898 has no link row, and ingest now always writes one.
    const removed = await runInTenant(tenant, () =>
      runtime.query("DELETE FROM value_links WHERE property_key = 'projects'"),
    );
    expect(removed.rowCount).toBe(1);

    const shown = attachmentsByName(await detailOf(tenant, thread.threadId))["legacy.pdf"];

    expect(shown?.project).toBeNull();
    expect(shown?.links).toEqual({});
  });

  it("answers project null with the inherited link of an attachment whose thread has no project yet", async () => {
    const world = await setup(tenant);
    const thread = await world.receive("<early@example.test>", { attachments: ["early.pdf"] });

    const shown = attachmentsByName(await detailOf(tenant, thread.threadId))["early.pdf"];

    expect(shown?.project).toBeNull();
    expect(shown?.links).toEqual({ project: inheritedFrom(thread.itemId) });
  });

  it("reads a project in the Trash as null and keeps the link entry of the file", async () => {
    const world = await setup(tenant);
    const thread = await world.receive("<trash@example.test>", { attachments: ["trash.pdf"] });
    const project = await world.newItem("projects", { name: "Doomed" });
    const [file] = thread.fileIds;
    if (!file) throw new Error("the message brought no file");
    await world.link(world.properties.filesProjects, file, project);
    expect(attachmentsByName(await detailOf(tenant, thread.threadId))["trash.pdf"]?.project).toEqual({
      id: project,
      name: "Doomed",
    });

    const deleted = await runInTenant(tenant, () => world.cp.softDeleteItem(world.databases.projects!, project));
    expect(deleted).not.toBeNull();

    const shown = attachmentsByName(await detailOf(tenant, thread.threadId))["trash.pdf"];
    expect(shown?.project).toBeNull();
    expect(shown?.links.project).toBeDefined();
  });

  it("shows the live project that is first by name when a file has several, and skips one in the Trash", async () => {
    const world = await setup(tenant);
    const thread = await world.receive("<several@example.test>", { attachments: ["several.pdf"] });
    const [file] = thread.fileIds;
    if (!file) throw new Error("the message brought no file");
    const beta = await world.newItem("projects", { name: "Beta" });
    const alpha = await world.newItem("projects", { name: "Alpha" });
    const trashed = await world.newItem("projects", { name: "Aardvark" });
    for (const project of [beta, alpha, trashed]) await world.link(world.properties.filesProjects, file, project);
    await runInTenant(tenant, () => world.cp.softDeleteItem(world.databases.projects!, trashed));

    const shown = attachmentsByName(await detailOf(tenant, thread.threadId))["several.pdf"];

    expect(shown?.project).toEqual({ id: alpha, name: "Alpha" });
  });

  it("answers project null and no links for an attachment whose Files item is in the Trash", async () => {
    const world = await setup(tenant);
    const thread = await world.receive("<gone@example.test>", { attachments: ["gone.pdf"] });
    const project = await world.newItem("projects", { name: "Web" });
    await world.link(world.properties.threadProject, thread.itemId, project);
    const [file] = thread.fileIds;
    if (!file) throw new Error("the message brought no file");
    const deleted = await runInTenant(tenant, () => world.cp.softDeleteItem(world.databases.files!, file));
    expect(deleted).not.toBeNull();

    const shown = attachmentsByName(await detailOf(tenant, thread.threadId))["gone.pdf"];

    expect(shown).toMatchObject({ fileItemId: null, project: null, links: {} });
  });

  it("reads the projects and links of all attachments of a thread in the same number of statements whatever their number", async () => {
    const world = await setup(tenant);
    const project = await world.newItem("projects", { name: "Web" });
    const one = await world.receive("<one@example.test>");
    const many = await world.receive("<many@example.test>");
    for (const thread of [one, many]) await world.link(world.properties.threadProject, thread.itemId, project);
    await world.receive("<one-file@example.test>", { references: ["<one@example.test>"], attachments: ["a.pdf"] });
    await world.receive("<four-files@example.test>", {
      references: ["<many@example.test>"],
      attachments: ["m1.pdf", "m2.pdf", "m3.pdf", "m4.pdf"],
    });

    const withOne = await countStatements(one.threadId);
    const withFour = await countStatements(many.threadId);

    expect(withOne).toBeGreaterThan(0);
    expect(withFour).toBe(withOne);
  });

  it("never shows a project or a link of another tenant's file", async () => {
    const a = await setup(tenant);
    const b = await setup(other);
    const role = await runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    const threadA = await a.receive("<same@example.test>");
    const threadB = await b.receive("<same@example.test>");
    const projectA = await a.newItem("projects", { name: "Project of A" });
    await a.link(a.properties.threadProject, threadA.itemId, projectA);
    // The attachments arrive after the project, so each file takes its thread's project at ingest.
    await a.receive("<a-file@example.test>", { references: ["<same@example.test>"], attachments: ["a.pdf"] });
    await b.receive("<b-file@example.test>", { references: ["<same@example.test>"], attachments: ["b.pdf"] });

    const ownDetail = await detailOf(other, threadB.threadId);
    expect(JSON.stringify(ownDetail)).not.toContain(projectA);
    expect(JSON.stringify(ownDetail)).not.toContain("Project of A");
    expect(JSON.stringify(ownDetail)).not.toContain(threadA.itemId);
    expect(attachmentsByName(ownDetail)["b.pdf"]?.project).toBeNull();
    expect(attachmentsByName(await detailOf(tenant, threadA.threadId))["a.pdf"]?.project).toEqual({
      id: projectA,
      name: "Project of A",
    });
    await expect(detailOf(other, threadA.threadId)).rejects.toMatchObject({ message: "Thread not found" });
  });
});
