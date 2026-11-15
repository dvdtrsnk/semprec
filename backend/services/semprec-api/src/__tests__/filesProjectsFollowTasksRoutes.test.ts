import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { CORE_TASK_NAMES, runOnce } from "@semprec/queue";
import { runInTenant } from "@semprec/shared";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "@semprec/data/testSupport";
import {
  createActionRegistry,
  createChokePoint,
  createCoreTaskList,
  createUser,
  createViewTypeRegistry,
  hashPassword,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  login,
  seedSystem,
  type ChokePoint,
} from "@semprec/data";
import { createDispatcher } from "../app.js";

// The HTTP surface of the attachment-project rule `fileProjectsFromTasks` (issue gh-1702): the `links` of a file, a
// user's write of `Files.projects`, `link.unlink`, `link.relink` and the answer for a file that has no link. The
// behaviour of the rule itself is proved through the choke point in
// `packages/data/src/tasks/__tests__/attachmentProjectInheritance.test.ts`.

const PASSWORD = "s3cret-password";
const tmpBlobDir = join(tmpdir(), `semprec-test-blobs-${randomUUID()}`);

let admin: Pool;
let runtime: Pool;
let cp: ChokePoint;
let server: Server;
let baseUrl: string;
let tenant: string;
let headers: { Authorization: string };

interface World {
  alpha: string;
  beta: string;
  gamma: string;
  databases: { files: string; projects: string; tasks: string };
}

const inTenant = <T>(fn: () => Promise<T>): Promise<T> => runInTenant(tenant, fn);

async function seedWorld(): Promise<World> {
  return inTenant(async () => {
    await seedSystem(runtime, createViewTypeRegistry());
    const all = await cp.listDatabases();
    const database = (moduleId: string): string => {
      const found = all.find((entry) => entry.ownerModuleId === moduleId);
      if (!found) throw new Error(`Missing database ${moduleId}`);
      return found.id;
    };
    const databases = { files: database("files"), projects: database("projects"), tasks: database("tasks") };
    const project = async (name: string): Promise<string> =>
      (await cp.createItem({ databaseId: databases.projects, properties: { name } })).id;
    return { alpha: await project("Alpha"), beta: await project("Beta"), gamma: await project("Gamma"), databases };
  });
}

/** One authenticated request; `body` is sent as JSON. */
async function request(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? headers : { ...headers, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function createItem(databaseId: string, name: string): Promise<string> {
  return (await inTenant(() => cp.createItem({ databaseId, properties: { name } }))).id;
}

/** Sets the task's single project over HTTP (`relation.set`), or clears it for `null`. */
async function setTaskProject(taskId: string, projectId: string | null): Promise<void> {
  const response = await request("PUT", `/api/items/${taskId}/relations/project`, { targetItemId: projectId });
  expect(response.status).toBe(200);
}

/** Attaches a file to a task over HTTP, as the attach of an upload does: an edge of `Tasks.files`. */
async function attach(taskId: string, fileId: string): Promise<void> {
  expect((await request("PUT", `/api/items/${taskId}/relations/files/${fileId}`)).status).toBe(200);
}

async function projectsOf(fileId: string): Promise<string[]> {
  const response = await request("GET", `/api/items/${fileId}/relations?propertyKey=projects`);
  expect(response.status).toBe(200);
  return (response.body.relations as { targetItemId: string }[]).map((edge) => edge.targetItemId).sort();
}

async function linksOf(fileId: string): Promise<Record<string, unknown>> {
  const response = await request("GET", `/api/items/${fileId}?include=links`);
  expect(response.status).toBe(200);
  return response.body.links as Record<string, unknown>;
}

/** Runs the queued value-link propagation jobs until none is left. */
async function runPropagation(): Promise<void> {
  const taskName = CORE_TASK_NAMES.VALUE_LINKS_PROPAGATE;
  const handler = createCoreTaskList(runtime, createActionRegistry())[taskName];
  if (!handler) throw new Error("Propagation handler missing");
  for (let pass = 0; pass < 40; pass++) {
    await runOnce({ pgPool: runtime, taskList: { [taskName]: handler } });
    const { rows } = await admin.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM graphile_worker.jobs WHERE task_identifier = $1",
      [taskName],
    );
    if (rows[0]?.count === 0) return;
  }
  throw new Error("Propagation queue did not drain");
}

describe("a file's project follows its task over HTTP (issue gh-1702)", () => {
  let world: World;

  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    cp = createChokePoint(runtime);
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    const user = await createUser(admin, {
      tenantId: tenant,
      email: `${randomUUID()}@example.com`,
      passwordHash: await hashPassword(PASSWORD),
    });
    const { token } = await login(admin, { email: user.email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
    headers = { Authorization: `Bearer ${token}` };
    world = await seedWorld();
    const dispatch = await createDispatcher(runtime, {
      passwordResetMailer: { async sendPasswordResetEmail() {} },
      appBaseUrl: "http://localhost",
      setupToken: "unused-setup-token",
      moduleRegistry: await loadFullModuleRegistry(),
      blobStorage: new LocalFsBlobStorageWriter(tmpBlobDir),
      maxFileSizeBytes: 10 * 1024 * 1024,
    });
    server = createServer(dispatch);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing REST address");
    baseUrl = `http://127.0.0.1:${address.port}`;
    return async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    };
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end();
  });

  it("reports the task as the source of a following file, then the user's change as a break, and relinks to the task's project", async () => {
    const task = await createItem(world.databases.tasks, "Prepare the offer");
    const file = await createItem(world.databases.files, "Offer.pdf");
    await setTaskProject(task, world.alpha);
    await attach(task, file);

    expect(await projectsOf(file)).toEqual([world.alpha]);
    expect(await linksOf(file)).toMatchObject({
      projects: {
        valueKind: "inherited",
        brokenBy: null,
        sources: [
          expect.objectContaining({ kind: "item", itemId: task, databaseKey: "tasks", propertyKey: "project" }),
        ],
      },
    });

    // A user's write of `Files.projects` ends the following, and the task's next change leaves the file alone.
    expect((await request("PUT", `/api/items/${file}/relations/projects/${world.beta}`)).status).toBe(200);
    expect(await linksOf(file)).toMatchObject({ projects: { valueKind: "inheritedBroken", brokenBy: "user" } });
    await setTaskProject(task, world.gamma);
    await runPropagation();
    expect(await projectsOf(file)).toEqual([world.alpha, world.beta].sort());

    const relinked = await request("POST", `/api/items/${file}/links/projects/relink`);
    expect(relinked.status).toBe(200);
    expect(relinked.body).toMatchObject({ valueKind: "inherited", brokenBy: null });
    expect(await projectsOf(file)).toEqual([world.gamma]);
    expect(await linksOf(file)).toMatchObject({ projects: { valueKind: "inherited", brokenBy: null } });
  });

  it("ends the following on link.unlink without changing the project, and follows the task again on link.relink", async () => {
    const task = await createItem(world.databases.tasks, "Prepare the offer");
    const file = await createItem(world.databases.files, "Offer.pdf");
    await setTaskProject(task, world.alpha);
    await attach(task, file);

    const unlinked = await request("POST", `/api/items/${file}/links/projects/unlink`);
    expect(unlinked.status).toBe(200);
    expect(unlinked.body).toMatchObject({ valueKind: "inheritedBroken", brokenBy: "user" });
    await setTaskProject(task, world.beta);
    await runPropagation();
    expect(await projectsOf(file)).toEqual([world.alpha]);

    expect((await request("POST", `/api/items/${file}/links/projects/relink`)).status).toBe(200);
    expect(await projectsOf(file)).toEqual([world.beta]);
  });

  it("answers link.relink with 409 for a file that kept its own project and has no link", async () => {
    const task = await createItem(world.databases.tasks, "Prepare the offer");
    const file = await createItem(world.databases.files, "Offer.pdf");
    expect((await request("PUT", `/api/items/${file}/relations/projects/${world.beta}`)).status).toBe(200);
    await setTaskProject(task, world.alpha);
    await attach(task, file);

    expect(await projectsOf(file)).toEqual([world.beta]);
    expect(await linksOf(file)).not.toHaveProperty("projects");
    const relink = await request("POST", `/api/items/${file}/links/projects/relink`);
    expect(relink.status).toBe(409);
    expect(relink.body).toMatchObject({ error: { code: "value_link_conflict" } });
    await setTaskProject(task, world.gamma);
    await runPropagation();
    expect(await projectsOf(file)).toEqual([world.beta]);
  });
});
