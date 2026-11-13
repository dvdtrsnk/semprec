import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import type { CollectionMetadataResolver } from "@semprec/data";
import { createTestProjectItem, getTenantZeroId, getTestPool, resetDatabase } from "@semprec/data/testSupport";
import {
  ChokePointError,
  createAgentRun,
  createUser,
  createViewTypeRegistry,
  hashPassword,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  login,
  seedSystem,
  type PasswordResetMailer,
} from "@semprec/data";
import { createGenericOperationGateway } from "@semprec/application";
import { CAPABILITY_IDS, type AuthenticatedActor } from "@semprec/shared";
import { createDispatcher } from "../app.js";

const testMetadataResolver: CollectionMetadataResolver = {
  resolve: () => ({
    icon: null,
    color: null,
    overviewOrder: null,
    switcherOrder: null,
    clientVisible: true,
    overviewHidden: false,
  }),
  collectionFilter: () => undefined,
  overviewHideable: () => false,
};

const PASSWORD = "s3cret-password";
const tmpBlobDir = join(tmpdir(), `semprec-test-blobs-${randomUUID()}`);
const noopMailer: PasswordResetMailer = { async sendPasswordResetEmail() {} };
const moduleRegistry = await loadFullModuleRegistry();

const itemBody = z.object({ id: z.string(), updatedAt: z.string() }).passthrough();
const storedRow = z.object({ id: z.string(), properties: z.record(z.string(), z.unknown()) });
const restError = z.object({
  error: z.object({ code: z.string(), details: z.record(z.string(), z.unknown()) }).strict(),
});

/** A refusal as REST exposes it: the HTTP status and the error body's `code` and `details`. */
interface Refusal {
  status: number;
  code: string;
  details: Record<string, unknown>;
}

type ModuleKey = "sleepSettings" | "sleepPlans" | "sleepNights";
type Transport = "rest" | "gateway";
const TRANSPORTS: readonly Transport[] = ["rest", "gateway"];

const PLAN = { name: "Short nights", wakeDays: ["tue"], bedTime: "23:30", wakeTime: "06:00", alarm: true, position: 2 };
const SETTINGS_NAME = "Sleep settings";

/** The refused creates: a label, the database, the properties, and the field the 400 names. */
const CREATE_REFUSALS: Array<[string, ModuleKey, Record<string, unknown>, string]> = [
  ["goalMinutes 485", "sleepSettings", { name: SETTINGS_NAME, goalMinutes: 485 }, "goalMinutes"],
  ["alarmSound gong", "sleepSettings", { name: SETTINGS_NAME, alarmSound: "gong" }, "alarmSound"],
  ["wakeDays mon and mon", "sleepPlans", { ...PLAN, wakeDays: ["mon", "mon"] }, "wakeDays"],
  ["bedTime 7:5", "sleepPlans", { ...PLAN, bedTime: "7:5" }, "bedTime"],
  ["wakeTime 25:00", "sleepPlans", { ...PLAN, wakeTime: "25:00" }, "wakeTime"],
  ["alarm yes", "sleepPlans", { ...PLAN, alarm: "yes" }, "alarm"],
  ["night 2026-13-01", "sleepNights", { night: "2026-13-01" }, "night"],
  ["a night alarm yes", "sleepNights", { night: "2026-10-16", alarm: "yes" }, "alarm"],
];

/** The refused patches of a stored item: a label, the database, the patch, and the field the 400 names. */
const PATCH_REFUSALS: Array<[string, ModuleKey, Record<string, unknown>, string]> = [
  ["goalMinutes 485", "sleepSettings", { goalMinutes: 485 }, "goalMinutes"],
  ["wakeDays mon and mon", "sleepPlans", { wakeDays: ["mon", "mon"] }, "wakeDays"],
  ["bedTime 25:00", "sleepPlans", { bedTime: "25:00" }, "bedTime"],
  ["bedTime 7:5", "sleepPlans", { bedTime: "7:5" }, "bedTime"],
  ["night 2026-13-01", "sleepNights", { night: "2026-13-01" }, "night"],
  ["a night wakeTime 25:00", "sleepNights", { wakeTime: "25:00" }, "wakeTime"],
];

let pool: Pool;
let databaseIds: Record<ModuleKey, string>;

async function storedItems(key: ModuleKey) {
  const { rows } = await pool.query<Record<string, unknown>>(
    "SELECT id, properties FROM items WHERE database_id = $1 AND deleted_at IS NULL ORDER BY id",
    [databaseIds[key]],
  );
  return rows.map((row) => storedRow.parse(row));
}

describe("sleep value rules and one-item-per-key rules through REST and the agent gateway (issue gh-1784)", () => {
  let server: Server;
  let baseUrl: string;
  let headers: Record<string, string>;
  let agentActor: AuthenticatedActor;
  const gateway = () => createGenericOperationGateway(pool, testMetadataResolver);

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
    const { rows } = await pool.query<{ key: string; id: string }>(
      "SELECT owner_module_id AS key, id FROM databases WHERE system AND owner_module_id IN ('sleepSettings', 'sleepPlans', 'sleepNights')",
    );
    const idOf = (key: ModuleKey): string => {
      const row = rows.find((candidate) => candidate.key === key);
      if (!row) throw new Error(`The seed left no ${key} database`);
      return row.id;
    };
    databaseIds = {
      sleepSettings: idOf("sleepSettings"),
      sleepPlans: idOf("sleepPlans"),
      sleepNights: idOf("sleepNights"),
    };

    const user = await createUser(pool, {
      email: `${randomUUID()}@example.com`,
      passwordHash: await hashPassword(PASSWORD),
      tenantId: getTenantZeroId(),
    });
    const { token } = await login(pool, { email: user.email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
    headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

    const projectItemId = await createTestProjectItem(pool);
    const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "plan my sleep" });
    agentActor = { userId: run.actorUserId, runId: run.id, agentProjectItemId: projectItemId };
    // The Sleep databases are sensitive, so the data layer closes them to an agent's project until the user grants
    // write access (issue gh-1810). The user-only admin store is not exported from `@semprec/data`, so the fixture
    // stores the decision with the statement of `setAgentDatabaseGrant`.
    for (const key of Object.keys(databaseIds) as ModuleKey[]) {
      const grant = await pool.query(
        `INSERT INTO agent_database_grants (project_item_id, database_id, access)
           SELECT $1, id, 'write' FROM databases WHERE id = $2`,
        [projectItemId, databaseIds[key]],
      );
      expect(grant.rowCount).toBe(1);
    }

    server = createServer(
      await createDispatcher(pool, {
        passwordResetMailer: noopMailer,
        appBaseUrl: "http://localhost",
        setupToken: "unused-setup-token",
        moduleRegistry,
        blobStorage: new LocalFsBlobStorageWriter(tmpBlobDir),
        maxFileSizeBytes: 10 * 1024 * 1024,
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function rest(method: string, path: string, body: unknown): Promise<{ status: number; body: unknown }> {
    const res = await fetch(`${baseUrl}${path}`, { method, headers, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  }

  async function restRefusal(method: string, path: string, body: unknown): Promise<Refusal> {
    const response = await rest(method, path, body);
    const parsed = restError.parse(response.body);
    return { status: response.status, code: parsed.error.code, details: parsed.error.details };
  }

  /** The error the agent gateway throws for the operation, as the same `{ status, code, details }` REST exposes. */
  async function gatewayRefusal(operation: "item.create" | "item.patch", input: unknown): Promise<Refusal> {
    const error: unknown = await gateway()
      .invoke(operation, agentActor, new Set(CAPABILITY_IDS), input)
      .then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
    if (!(error instanceof ChokePointError)) throw new Error(`Expected a ChokePointError, got ${String(error)}`);
    return {
      status: error.status,
      code: error.code,
      details: z.record(z.string(), z.unknown()).parse(error.details),
    };
  }

  /** The `updatedAt` the API reports for an item, which a patch sends back as `ifVersion`. */
  async function versionOf(itemId: string): Promise<string> {
    const res = await fetch(`${baseUrl}/api/items/${itemId}`, { headers });
    expect(res.status).toBe(200);
    return itemBody.parse(await res.json()).updatedAt;
  }

  function refuse(
    transport: Transport,
    operation: "create" | "patch",
    target: { databaseId: string; itemId?: string; updatedAt?: string },
    properties: Record<string, unknown>,
  ): Promise<Refusal> {
    if (operation === "create") {
      return transport === "rest"
        ? restRefusal("POST", `/api/databases/${target.databaseId}/items`, { properties })
        : gatewayRefusal("item.create", { databaseId: target.databaseId, properties });
    }
    const input = { itemId: target.itemId, properties, ifVersion: target.updatedAt };
    return transport === "rest"
      ? restRefusal("PATCH", `/api/items/${target.itemId}`, { properties, ifVersion: target.updatedAt })
      : gatewayRefusal("item.patch", input);
  }

  function writeApiFor(transport: Transport) {
    return {
      async create(key: ModuleKey, properties: Record<string, unknown>) {
        if (transport === "rest") {
          const created = await rest("POST", `/api/databases/${databaseIds[key]}/items`, { properties });
          expect(created.status).toBe(201);
          return itemBody.parse(created.body);
        }
        return itemBody.parse(
          await gateway().invoke("item.create", agentActor, new Set(CAPABILITY_IDS), {
            databaseId: databaseIds[key],
            properties,
          }),
        );
      },
    };
  }

  /** The item a patch case starts from: the seeded settings item, or an item the transport itself creates. */
  async function patchTarget(transport: Transport, key: ModuleKey) {
    if (key === "sleepSettings") {
      const [seeded] = await storedItems(key);
      if (!seeded) throw new Error("The seed left no settings item");
      return seeded;
    }
    // One exception per night, so each transport gets a night of its own.
    const properties =
      key === "sleepPlans"
        ? { ...PLAN, name: `Plan ${transport}` }
        : { night: transport === "rest" ? "2026-10-16" : "2026-10-17" };
    const created = await writeApiFor(transport).create(key, properties);
    const stored = (await storedItems(key)).find((item) => item.id === created.id);
    if (!stored) throw new Error("The created item is not stored");
    return stored;
  }

  it.each(CREATE_REFUSALS)(
    "refuses a create with %s alike through REST and the agent gateway, storing nothing",
    async (_label, key, properties, field) => {
      const before = await storedItems(key);
      const target = { databaseId: databaseIds[key] };

      const refusals = {
        rest: await refuse("rest", "create", target, properties),
        gateway: await refuse("gateway", "create", target, properties),
      };

      expect(refusals.rest).toEqual({ status: 400, code: "validation_failed", details: { field } });
      expect(refusals.gateway).toEqual(refusals.rest);
      expect(await storedItems(key)).toEqual(before);
    },
  );

  it.each(PATCH_REFUSALS)(
    "refuses a patch with %s alike through REST and the agent item.patch, keeping the stored item",
    async (_label, key, patch, field) => {
      for (const transport of TRANSPORTS) {
        const target = await patchTarget(transport, key);
        const before = await storedItems(key);

        const refusal = await refuse(
          transport,
          "patch",
          { databaseId: databaseIds[key], itemId: target.id, updatedAt: await versionOf(target.id) },
          patch,
        );

        expect(refusal).toEqual({ status: 400, code: "validation_failed", details: { field } });
        expect(await storedItems(key)).toEqual(before);
      }
    },
  );

  it.each(TRANSPORTS)("stores bedTime 6:45 as 06:45 and accepts wakeDays [] through %s", async (transport) => {
    const created = await writeApiFor(transport).create("sleepPlans", {
      ...PLAN,
      name: `Accepted ${transport}`,
      bedTime: "6:45",
      wakeDays: [],
    });

    const stored = (await storedItems("sleepPlans")).find((item) => item.id === created.id);
    expect(stored?.properties).toMatchObject({ bedTime: "06:45", wakeDays: [] });
  });

  it.each(TRANSPORTS)("answers a second settings item with 409 duplicate_item through %s", async (transport) => {
    const before = await storedItems("sleepSettings");
    expect(before).toHaveLength(1);

    const refusal = await refuse(
      transport,
      "create",
      { databaseId: databaseIds.sleepSettings },
      { name: SETTINGS_NAME, enabled: true },
    );

    expect(refusal).toEqual({ status: 409, code: "duplicate_item", details: { field: "sleepSettings" } });
    expect(await storedItems("sleepSettings")).toEqual(before);
  });

  it("answers the second of two concurrent POSTs for the night 2026-10-16 with 409 duplicate_item and stores one item", async () => {
    const post = () =>
      rest("POST", `/api/databases/${databaseIds.sleepNights}/items`, { properties: { night: "2026-10-16" } });

    const responses = await Promise.all([post(), post()]);

    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    const conflict = responses.find((response) => response.status === 409);
    expect(restError.parse(conflict?.body)).toEqual({
      error: { code: "duplicate_item", details: { field: "night" } },
    });
    expect(await storedItems("sleepNights")).toHaveLength(1);
  });

  it.each(TRANSPORTS)(
    "answers a second exception for a night with 409 duplicate_item through %s",
    async (transport) => {
      await writeApiFor("rest").create("sleepNights", { night: "2026-10-16" });

      const refusal = await refuse(
        transport,
        "create",
        { databaseId: databaseIds.sleepNights },
        { night: "2026-10-16" },
      );

      expect(refusal).toEqual({ status: 409, code: "duplicate_item", details: { field: "night" } });
      expect(await storedItems("sleepNights")).toHaveLength(1);
    },
  );

  it.each(TRANSPORTS)(
    "answers a night moved onto an occupied date with 409 duplicate_item through %s",
    async (transport) => {
      await writeApiFor("rest").create("sleepNights", { night: "2026-10-16" });
      const moving = await writeApiFor("rest").create("sleepNights", { night: "2026-10-17" });
      const before = await storedItems("sleepNights");

      const refusal = await refuse(
        transport,
        "patch",
        { databaseId: databaseIds.sleepNights, itemId: moving.id, updatedAt: moving.updatedAt },
        { night: "2026-10-16" },
      );

      expect(refusal).toEqual({ status: 409, code: "duplicate_item", details: { field: "night" } });
      expect(await storedItems("sleepNights")).toEqual(before);
    },
  );
  it.each(TRANSPORTS)(
    "moves fri from the weekday plan to the weekend plan with one patch through %s, without an approval step",
    async (transport) => {
      const plans = await storedItems("sleepPlans");
      const weekday = plans.find(
        (plan) => Array.isArray(plan.properties.wakeDays) && plan.properties.wakeDays.includes("mon"),
      );
      const weekend = plans.find(
        (plan) => Array.isArray(plan.properties.wakeDays) && plan.properties.wakeDays.includes("sat"),
      );
      if (!weekday || !weekend) throw new Error("The seed left no weekday and weekend plan");
      const properties = { wakeDays: ["fri", "sat", "sun"] };
      const ifVersion = await versionOf(weekend.id);

      if (transport === "rest") {
        const patched = await rest("PATCH", `/api/items/${weekend.id}`, { properties, ifVersion });
        expect(patched.status).toBe(200);
      } else {
        await gateway().invoke("item.patch", agentActor, new Set(CAPABILITY_IDS), {
          itemId: weekend.id,
          properties,
          ifVersion,
        });
      }

      const after = await storedItems("sleepPlans");
      expect(after.find((plan) => plan.id === weekend.id)?.properties.wakeDays).toEqual(["fri", "sat", "sun"]);
      expect(after.find((plan) => plan.id === weekday.id)?.properties.wakeDays).toEqual(["mon", "tue", "wed", "thu"]);
      const approvals = await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM approval_requests");
      expect(approvals.rows).toEqual([{ count: 0 }]);
    },
  );
});
