import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { runAsSystem } from "@alldots/shared";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "@alldots/data/testSupport";
import {
  createUser,
  hashPassword,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  provisionTenant,
  type PasswordResetMailer,
} from "@alldots/data";
import { createDispatcher } from "../app.js";

/**
 * Project tags through the real dispatcher on a runtime-role pool, so row-level security applies. Each test gets two
 * freshly provisioned tenants, each with a signed-in user.
 */

const noopMailer: PasswordResetMailer = { async sendPasswordResetEmail() {} };
const moduleRegistry = await loadFullModuleRegistry();
const blobStorage = new LocalFsBlobStorageWriter(join(tmpdir(), `alldots-test-blobs-project-tags-${randomUUID()}`));

let adminPool: Pool;
let pool: Pool;
let server: Server;
let baseUrl: string;
const tenants = { a: { Authorization: "" }, b: { Authorization: "" } };

type Headers = { Authorization: string };

const optionBody = z.strictObject({ key: z.string(), label: z.string(), color: z.string().optional() });
const schemaBody = z.object({
  databases: z.array(
    z.object({
      databaseId: z.string(),
      key: z.string().nullable(),
      facetBarProperty: z.string().optional(),
      properties: z.array(
        z.object({
          id: z.string(),
          key: z.string(),
          type: z.string(),
          owner: z.string(),
          options: z.array(optionBody).optional(),
        }),
      ),
    }),
  ),
});
const itemBody = z.object({ id: z.string(), version: z.string(), properties: z.record(z.string(), z.unknown()) });
const queryBody = z.object({ items: z.array(itemBody) });
const facetsBody = z.object({
  facets: z.array(
    z.object({
      property: z.string(),
      values: z.array(
        z.object({ value: z.union([z.string(), z.null()]), label: z.string().optional(), count: z.number() }),
      ),
    }),
  ),
});
const searchBody = z.object({
  groups: z.array(z.object({ type: z.string(), items: z.array(z.object({ itemId: z.string() }).passthrough()) })),
});
const errorBody = z.object({ error: z.object({ code: z.string(), details: z.object({ field: z.string() }) }) });

interface Answer {
  status: number;
  text: string;
}

async function signUp(tenantId: string): Promise<Headers> {
  const email = `${randomUUID()}@example.test`;
  const password = `pw-${randomUUID()}`;
  const passwordHash = await hashPassword(password);
  // `users` is a global identity table, written outside any tenant as account creation does.
  await runAsSystem("test-fixture-create-user", () => createUser(adminPool, { email, passwordHash, tenantId }));
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, platform: "ios" }),
  });
  expect(login.status).toBe(200);
  const { token } = z.object({ token: z.string() }).parse(await login.json());
  return { Authorization: `Bearer ${token}` };
}

async function send(headers: Headers, method: string, path: string, body?: unknown): Promise<Answer> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, text: await response.text() };
}

async function sendOk(headers: Headers, method: string, path: string, body?: unknown): Promise<string> {
  const answer = await send(headers, method, path, body);
  expect(answer.status, answer.text).toBeLessThan(300);
  return answer.text;
}

interface ProjectsSchema {
  databaseId: string;
  facetBarProperty: string | undefined;
  tags: z.infer<typeof schemaBody>["databases"][number]["properties"][number];
}

async function projectsSchema(headers: Headers): Promise<ProjectsSchema> {
  const schema = schemaBody.parse(JSON.parse(await sendOk(headers, "GET", "/api/schema")));
  const projects = schema.databases.find((database) => database.key === "projects");
  const tags = projects?.properties.find((property) => property.key === "tags");
  if (!projects || !tags) throw new Error("The schema lists no Projects tags");
  return { databaseId: projects.databaseId, facetBarProperty: projects.facetBarProperty, tags };
}

async function addTag(headers: Headers, propertyId: string, label: string): Promise<string> {
  const answer = await send(headers, "POST", `/api/properties/${propertyId}/options`, { label });
  expect(answer.status, answer.text).toBe(201);
  return optionBody.parse(JSON.parse(answer.text)).key;
}

async function createProject(headers: Headers, databaseId: string, name: string, tags?: string[]): Promise<string> {
  const text = await sendOk(headers, "POST", `/api/databases/${databaseId}/items`, {
    properties: { name, ...(tags === undefined ? {} : { tags }) },
  });
  return itemBody.parse(JSON.parse(text)).id;
}

async function queryTagged(headers: Headers, databaseId: string, value: string[]): Promise<string[]> {
  const text = await sendOk(headers, "POST", `/api/databases/${databaseId}/query`, {
    filter: { type: "in", property: "tags", value },
  });
  return queryBody
    .parse(JSON.parse(text))
    .items.map((item) => item.id)
    .sort();
}

async function tagFacet(
  headers: Headers,
  databaseId: string,
): Promise<{ value: string; label: string; count: number }[]> {
  const text = await sendOk(headers, "POST", `/api/databases/${databaseId}/facets`, { facets: ["tags"] });
  const [facet] = facetsBody.parse(JSON.parse(text)).facets;
  expect(facet?.property).toBe("tags");
  return (facet?.values ?? []).flatMap(({ value, label, count }) =>
    value === null ? [] : [{ value, label: label ?? "", count }],
  );
}

describe("tags on Projects", () => {
  beforeAll(async () => {
    adminPool = getTestPool();
    await resetDatabase(adminPool);
    pool = await createRuntimeRolePool(adminPool, "alldots_data");
    const dispatch = await createDispatcher(pool, {
      passwordResetMailer: noopMailer,
      appBaseUrl: "http://localhost",
      setupToken: "unused-setup-token",
      moduleRegistry,
      blobStorage,
      maxFileSizeBytes: 1024 * 1024,
    });
    server = createServer(dispatch);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 120_000);
  beforeEach(async () => {
    for (const name of ["a", "b"] as const) {
      const tenantId = await createTestTenant(adminPool);
      await provisionTenant(pool, tenantId);
      tenants[name] = await signUp(tenantId);
    }
  }, 120_000);
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool?.end();
    await adminPool?.end();
  });

  it("gives a new tenant's Projects a user-owned tags multi_select with no options, declared as the facet bar", async () => {
    for (const headers of [tenants.a, tenants.b]) {
      const projects = await projectsSchema(headers);
      expect(projects.tags).toMatchObject({ type: "multi_select", owner: "user", options: [] });
      expect(projects.facetBarProperty).toBe("tags");
    }
  });

  it("adds a tag through the option route, sets it on a project, and refuses an unknown tag key with 400 leaving the project unchanged", async () => {
    const { databaseId, tags } = await projectsSchema(tenants.a);
    const garden = await addTag(tenants.a, tags.id, "Garden");
    expect(garden).toBe("garden");
    expect((await projectsSchema(tenants.a)).tags.options).toEqual([{ key: "garden", label: "Garden" }]);

    const projectId = await createProject(tenants.a, databaseId, "Greenhouse");
    const created = itemBody.parse(JSON.parse(await sendOk(tenants.a, "GET", `/api/items/${projectId}`)));
    const set = await send(tenants.a, "PATCH", `/api/items/${projectId}`, {
      properties: { tags: [garden] },
      ifVersion: created.version,
    });
    expect(set.status, set.text).toBe(200);
    const tagged = itemBody.parse(JSON.parse(set.text));
    expect(tagged.properties.tags).toEqual([garden]);

    const unknown = await send(tenants.a, "PATCH", `/api/items/${projectId}`, {
      properties: { tags: [garden, "kitchen"] },
      ifVersion: tagged.version,
    });
    expect(unknown.status, unknown.text).toBe(400);
    expect(errorBody.parse(JSON.parse(unknown.text)).error).toMatchObject({
      code: "validation_failed",
      details: { field: "tags" },
    });
    const stored = itemBody.parse(JSON.parse(await sendOk(tenants.a, "GET", `/api/items/${projectId}`)));
    expect([stored.version, stored.properties.tags]).toEqual([tagged.version, [garden]]);
  });

  it("queries exactly the projects having any of the listed tags, and counts each tag in the facets", async () => {
    const { databaseId, tags } = await projectsSchema(tenants.a);
    const [garden, kitchen, travel] = [
      await addTag(tenants.a, tags.id, "Garden"),
      await addTag(tenants.a, tags.id, "Kitchen"),
      await addTag(tenants.a, tags.id, "Travel"),
    ];
    const onlyGarden = await createProject(tenants.a, databaseId, "Greenhouse", [garden]);
    const gardenAndKitchen = await createProject(tenants.a, databaseId, "Herb shelf", [garden, kitchen]);
    const onlyKitchen = await createProject(tenants.a, databaseId, "New oven", [kitchen]);
    await createProject(tenants.a, databaseId, "Lisbon", [travel]);
    await createProject(tenants.a, databaseId, "Untagged");

    expect(await queryTagged(tenants.a, databaseId, [garden, kitchen])).toEqual(
      [onlyGarden, gardenAndKitchen, onlyKitchen].sort(),
    );
    expect(await queryTagged(tenants.a, databaseId, [garden])).toEqual([onlyGarden, gardenAndKitchen].sort());
    expect(await tagFacet(tenants.a, databaseId)).toEqual([
      { value: garden, label: "Garden", count: 2 },
      { value: kitchen, label: "Kitchen", count: 2 },
      { value: travel, label: "Travel", count: 1 },
    ]);
  });

  it("finds a project by search through the label of its tag", async () => {
    const { databaseId, tags } = await projectsSchema(tenants.a);
    const label = "Zahradnictvi";
    const tagged = await createProject(tenants.a, databaseId, "Greenhouse", [await addTag(tenants.a, tags.id, label)]);
    await createProject(tenants.a, databaseId, "Untagged");

    const text = await sendOk(tenants.a, "GET", `/api/search?q=${encodeURIComponent(label)}&scope=project`);
    expect(
      searchBody.parse(JSON.parse(text)).groups.map((group) => [group.type, group.items.map((i) => i.itemId)]),
    ).toEqual([["project", [tagged]]]);
  });

  it("never returns another tenant's tag options or projects through query, facets or schema", async () => {
    const a = await projectsSchema(tenants.a);
    const b = await projectsSchema(tenants.b);
    const ownTag = await addTag(tenants.b, b.tags.id, "Shared label");
    const foreignTag = await addTag(tenants.a, a.tags.id, "Shared label");
    const foreignOnly = await addTag(tenants.a, a.tags.id, "Secret of A");
    expect(ownTag).toBe(foreignTag);
    const foreignProject = await createProject(tenants.a, a.databaseId, "Project of A", [foreignTag, foreignOnly]);
    const ownProject = await createProject(tenants.b, b.databaseId, "Project of B", [ownTag]);

    expect(await queryTagged(tenants.b, b.databaseId, [ownTag, foreignOnly])).toEqual([ownProject]);
    expect(await tagFacet(tenants.b, b.databaseId)).toEqual([{ value: ownTag, label: "Shared label", count: 1 }]);
    expect((await projectsSchema(tenants.b)).tags.options).toEqual([{ key: ownTag, label: "Shared label" }]);
    for (const answer of [
      await send(tenants.b, "GET", "/api/schema"),
      await send(tenants.b, "POST", `/api/databases/${b.databaseId}/facets`, { facets: ["tags"] }),
      await send(tenants.b, "POST", `/api/databases/${b.databaseId}/query`, {}),
    ]) {
      expect(answer.status).toBe(200);
      expect(answer.text).not.toContain(foreignProject);
      expect(answer.text).not.toContain("Secret of A");
      expect(answer.text).not.toContain(a.tags.id);
    }
    // Tenant A's database is answered to B exactly like a database that does not exist.
    const foreignQuery = await send(tenants.b, "POST", `/api/databases/${a.databaseId}/query`, {});
    const foreignFacets = await send(tenants.b, "POST", `/api/databases/${a.databaseId}/facets`, {
      facets: ["tags"],
    });
    expect([foreignQuery.status, foreignFacets.status]).toEqual([404, 404]);
    expect(foreignQuery.text + foreignFacets.text).not.toContain(foreignProject);
  });
});
