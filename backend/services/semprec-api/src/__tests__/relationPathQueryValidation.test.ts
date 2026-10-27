import { createServer, type Server } from "node:http";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createChokePoint,
  createUser,
  createViewTypeRegistry,
  hashPassword,
  login,
  seedSystem,
  ValidationError,
} from "@semprec/data";
import { getTenantZeroId, getTestPool, resetDatabase } from "@semprec/data/testSupport";
import { createGenericApplicationService, createGenericOperationGateway } from "@semprec/application";
import { OPERATION_METADATA, runInTenant, type FilterNode } from "@semprec/shared";
import { mountRoutes } from "../adapter/routeTable.js";
import { dispatchGenericOperation, restActor } from "../adapter/genericBinding.js";
import { createItemRoutes } from "../itemsHandler.js";
import { createViewRoutes } from "../viewsHandler.js";

const value = "11111111-1111-4111-8111-111111111111";
const valid = { type: "relation_path_contains", path: ["project", "area"], value };
const invalidConditions = [
  { name: "invalid UUID", node: { ...valid, value: "invalid" } },
  { name: "non-string UUID", node: { ...valid, value: 123 } },
  { name: "missing UUID", node: { type: valid.type, path: valid.path } },
  { name: "short path", node: { ...valid, path: ["project"] } },
  { name: "long path", node: { ...valid, path: ["project", "area", "extra"] } },
  { name: "empty path", node: { ...valid, path: [] } },
  { name: "missing path", node: { type: valid.type, value } },
  { name: "non-array path", node: { ...valid, path: "project.area" } },
  { name: "empty first key", node: { ...valid, path: ["", "area"] } },
  { name: "empty second key", node: { ...valid, path: ["project", ""] } },
  { name: "non-string key", node: { ...valid, path: ["project", null] } },
];
const shapes = [
  { name: "leaf", wrap: (node: unknown) => node },
  { name: "and", wrap: (node: unknown) => ({ type: "and", nodes: [{ type: "is_empty", property: "name" }, node] }) },
  { name: "or", wrap: (node: unknown) => ({ type: "or", nodes: [node] }) },
  { name: "nested not", wrap: (node: unknown) => ({ type: "not", node: { type: "and", nodes: [node] } }) },
];

describe("relation path query validation at the REST operation boundary", () => {
  let pool: Pool;
  let server: Server;
  let baseUrl: string;
  let token: string;
  let userId: string;
  let databaseId: string;
  let viewId: string;

  beforeAll(async () => {
    pool = getTestPool();
    await resetDatabase(pool);
    await runInTenant(getTenantZeroId(), async () => {
      await seedSystem(pool, createViewTypeRegistry());
      const cp = createChokePoint(pool);
      const tasks = (await cp.listDatabases()).find((database) => database.key === "tasks");
      if (!tasks) throw new Error("Missing seeded Tasks database");
      databaseId = tasks.id;
      viewId = (await cp.createView({ databaseId, type: "table", name: "Relation path validation", config: {} })).id;
      const user = await createUser(pool, {
        tenantId: getTenantZeroId(),
        email: "relation-path-validation@example.com",
        passwordHash: await hashPassword("test-password"),
      });
      userId = user.id;
      token = (await login(pool, { email: user.email, password: "test-password", platform: "ios", ip: "127.0.0.1" }))
        .token;
    });

    const service = createGenericApplicationService(pool);
    const dispatch = mountRoutes(pool, [...createItemRoutes(service, pool), ...createViewRoutes(service)]);
    server = createServer((req, res) => {
      if (!dispatch(req, res)) res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    if (server)
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await pool?.end();
  });

  for (const operation of ["database.query", "view.query"] as const) {
    function input(filter: unknown) {
      return operation === "database.query" ? { databaseId, filter } : { viewId, filter };
    }

    async function query(filter: unknown) {
      const path = operation === "database.query" ? `databases/${databaseId}` : `views/${viewId}`;
      return fetch(`${baseUrl}/api/${path}/query`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ filter }),
        signal: AbortSignal.timeout(10_000),
      });
    }

    describe(operation, () => {
      for (const shape of shapes) {
        it.each(invalidConditions)(`returns 400/filter for ${shape.name}: $name`, async ({ node }) => {
          const filter = shape.wrap(node);
          const response = await query(filter);
          expect(response.status).toBe(400);
          const body: unknown = await response.json();
          expect(body).toEqual({ error: { code: "validation_failed", details: { field: "filter" } } });

          const gateway = createGenericOperationGateway(pool);
          await expect(
            runInTenant(getTenantZeroId(), () =>
              gateway.invoke(
                operation,
                restActor(userId),
                new Set([OPERATION_METADATA[operation].requiresCapability]),
                input(filter),
              ),
            ),
          ).rejects.toMatchObject({ name: "ValidationError", status: 400, details: { field: "filter" } });
        });
      }

      it("accepts a valid relation path through REST and dispatch", async () => {
        const response = await query(valid);
        expect(response.status).toBe(200);
        const body: unknown = await response.json();
        expect(body).toMatchObject({ items: [], nextCursor: null });
        const filter: FilterNode = { type: "relation_path_contains", path: ["project", "area"], value };
        await expect(
          runInTenant(getTenantZeroId(), () =>
            dispatchGenericOperation(
              createGenericApplicationService(pool),
              operation,
              restActor(userId),
              input(filter),
            ),
          ),
        ).resolves.toMatchObject({ items: [] });
      });

      it("preserves the existing relation_contains value field", async () => {
        const filter = { type: "relation_contains", property: "project", value: "invalid" };
        const response = await query(filter);
        expect(response.status).toBe(400);
        const body: unknown = await response.json();
        expect(body).toEqual({ error: { code: "validation_failed", details: { field: "filter.value" } } });
        await expect(
          dispatchGenericOperation(createGenericApplicationService(pool), operation, restActor(userId), input(filter)),
        ).rejects.toBeInstanceOf(ValidationError);
      });

      it("preserves an unrelated invalid condition next to a valid relation path", async () => {
        const response = await query({
          type: "and",
          nodes: [valid, { type: "relation_contains", property: "project", value: "invalid" }],
        });
        expect(response.status).toBe(400);
        const body: unknown = await response.json();
        expect(body).toEqual({ error: { code: "validation_failed", details: { field: "filter.nodes.1.value" } } });
      });
    });
  }
});
