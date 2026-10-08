import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import { createHeartbeat, getHeartbeat, updateHeartbeatRule } from "../scheduler/schedulerStore.js";
import { registerMailboxClientViewType, MAILBOX_CLIENT_VIEW_TYPE } from "../views/mailboxClientViewType.js";
import { registerJournalInboxViewType, JOURNAL_INBOX_VIEW_TYPE } from "../views/journalInboxViewType.js";

let adminPool: Pool;
let dataPool: Pool;
let chokePoint: ChokePoint;
let tenantA: string;
let tenantB: string;

/** Fixtures that live in one tenant: a database with a live item, plus a soft-deleted item. */
interface TenantFixture {
  databaseId: string;
  itemId: string;
  deletedItemId: string;
}

async function seedTenant(tenantId: string): Promise<TenantFixture> {
  return runInTenant(tenantId, async () => {
    const database = await chokePoint.createDatabase({ name: "Fixture" });
    const item = await chokePoint.createItem({ databaseId: database.id });
    const deleted = await chokePoint.createItem({ databaseId: database.id });
    await chokePoint.softDeleteItem(database.id, deleted.id);
    return { databaseId: database.id, itemId: item.id, deletedItemId: deleted.id };
  });
}

/** Runs `fn` expecting a ValidationError and returns it. */
async function validationError(fn: () => Promise<unknown>): Promise<ValidationError> {
  const error: unknown = await fn().then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ValidationError);
  return error as ValidationError;
}

/** Asserts every error is byte-identical in message and details, and returns the first. */
function expectIdentical(errors: ValidationError[]): ValidationError {
  const [first, ...rest] = errors;
  for (const error of rest) {
    expect(error.message).toBe(first!.message);
    expect(error.details).toEqual(first!.details);
  }
  return first!;
}

async function databaseCount(): Promise<number> {
  const { rows } = await adminPool.query<{ count: string }>("SELECT count(*) FROM databases");
  return Number(rows[0]!.count);
}

describe("references are validated inside the caller's tenant (issue #1017)", () => {
  let a: TenantFixture;
  let b: TenantFixture;

  beforeAll(async () => {
    adminPool = getTestPool();
    dataPool = await createRuntimeRolePool(adminPool, "semprec_data");
    const registry = createViewTypeRegistry();
    registerMailboxClientViewType(registry);
    registerJournalInboxViewType(registry);
    chokePoint = createChokePoint(dataPool, undefined, registry);
  });

  afterAll(async () => {
    await dataPool?.end();
    await adminPool?.end();
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
    tenantA = getTenantZeroId();
    tenantB = await createTestTenant(adminPool);
    a = await seedTenant(tenantA);
    b = await seedTenant(tenantB);
  });

  describe("parentItemId on database creation", () => {
    it("rejects foreign, random, soft-deleted and malformed ids identically and writes nothing", async () => {
      const before = await databaseCount();
      const errors = await runInTenant(tenantA, async () => {
        const out: ValidationError[] = [];
        for (const parentItemId of [b.itemId, randomUUID(), a.deletedItemId, "not-a-uuid"]) {
          out.push(await validationError(() => chokePoint.createDatabase({ name: "Child", parentItemId })));
        }
        return out;
      });
      const first = expectIdentical(errors);
      expect(first.message).toBe("'parentItemId' does not reference an existing item");
      expect(first.details).toEqual({ field: "parentItemId" });
      expect(await databaseCount()).toBe(before);
    });

    it("accepts a live item of the tenant", async () => {
      const database = await runInTenant(tenantA, () =>
        chokePoint.createDatabase({ name: "Child", parentItemId: a.itemId }),
      );
      expect(database.parentItemId).toBe(a.itemId);
    });
  });

  describe("onItemEvent heartbeat rules", () => {
    const rule = (databaseId: string) => ({ kind: "onItemEvent", databaseId, event: "create" });
    const create = (client: Parameters<typeof createHeartbeat>[0], ruleInput: unknown) =>
      createHeartbeat(client, { projectItemId: randomUUID(), name: "hb", rule: ruleInput, actionId: "semprec.tick" });

    it("rejects createHeartbeat for a foreign or random database identically and writes no row", async () => {
      const errors = await runInTenant(tenantA, async () => {
        const out: ValidationError[] = [];
        for (const databaseId of [b.databaseId, randomUUID()]) {
          out.push(
            await validationError(() => withTransaction(dataPool, (client) => create(client, rule(databaseId)))),
          );
        }
        return out;
      });
      const first = expectIdentical(errors);
      expect(first.message).toBe("'rule.databaseId' does not reference an existing database");
      expect(first.details).toEqual({ field: "rule.databaseId" });
      const { rows } = await adminPool.query<{ count: string }>("SELECT count(*) FROM project_heartbeats");
      expect(rows[0]!.count).toBe("0");
    });

    it("rejects updateHeartbeatRule for a foreign or random database and leaves the rule unchanged", async () => {
      const { heartbeatId, original } = await runInTenant(tenantA, async () => {
        const heartbeat = await withTransaction(dataPool, (client) => create(client, rule(a.databaseId)));
        return { heartbeatId: heartbeat.id, original: heartbeat.rule };
      });
      const errors = await runInTenant(tenantA, async () => {
        const out: ValidationError[] = [];
        for (const databaseId of [b.databaseId, randomUUID()]) {
          out.push(
            await validationError(() =>
              withTransaction(dataPool, (client) => updateHeartbeatRule(client, heartbeatId, rule(databaseId))),
            ),
          );
        }
        return out;
      });
      expect(expectIdentical(errors).details).toEqual({ field: "rule.databaseId" });
      const after = await runInTenant(tenantA, () =>
        withTransaction(dataPool, (client) => getHeartbeat(client, heartbeatId)),
      );
      expect(after?.rule).toEqual(original);
    });

    it("accepts the tenant's own database and leaves other rule kinds unaffected", async () => {
      await runInTenant(tenantA, async () => {
        const own = await withTransaction(dataPool, (client) => create(client, rule(a.databaseId)));
        expect(own.rule).toMatchObject({ kind: "onItemEvent", databaseId: a.databaseId });
        const updated = await withTransaction(dataPool, (client) =>
          updateHeartbeatRule(client, own.id, rule(a.databaseId)),
        );
        expect(updated.rule).toMatchObject({ databaseId: a.databaseId });
        const interval = await withTransaction(dataPool, (client) => create(client, { kind: "interval", minutes: 5 }));
        expect(interval.rule).toEqual({ kind: "interval", minutes: 5 });
      });
    });
  });

  describe("view-type configs", () => {
    interface Case {
      type: string;
      field: string;
      kind: "database" | "item";
      config: (value: string, own: TenantFixture) => Record<string, unknown>;
    }
    const mailbox = (field: string, kind: "database" | "item"): Case => ({
      type: MAILBOX_CLIENT_VIEW_TYPE,
      field,
      kind,
      config: (value, own) => ({
        foldersDatabaseId: own.databaseId,
        mailboxesDatabaseId: own.databaseId,
        mailboxItemId: own.itemId,
        [field]: value,
      }),
    });
    const journal = (field: string, kind: "database" | "item"): Case => ({
      type: JOURNAL_INBOX_VIEW_TYPE,
      field,
      kind,
      config: (value, own) => ({ inboxDatabaseId: own.databaseId, journalDayItemId: own.itemId, [field]: value }),
    });
    const cases: Case[] = [
      mailbox("foldersDatabaseId", "database"),
      mailbox("mailboxesDatabaseId", "database"),
      mailbox("mailboxItemId", "item"),
      journal("inboxDatabaseId", "database"),
      journal("journalDayItemId", "item"),
    ];

    for (const c of cases) {
      it(`rejects a foreign or random ${c.type} ${c.field} on create and patch identically`, async () => {
        const foreign = c.kind === "database" ? b.databaseId : b.itemId;
        const view = await runInTenant(tenantA, () =>
          chokePoint.createView({
            databaseId: a.databaseId,
            type: c.type,
            name: "v",
            config: c.config(c.kind === "database" ? a.databaseId : a.itemId, a),
          }),
        );
        const errors = await runInTenant(tenantA, async () => {
          const out: ValidationError[] = [];
          for (const value of [foreign, randomUUID()]) {
            out.push(
              await validationError(() =>
                chokePoint.createView({
                  databaseId: a.databaseId,
                  type: c.type,
                  name: "v2",
                  config: c.config(value, a),
                }),
              ),
            );
            out.push(
              await validationError(() =>
                chokePoint.patchView({ id: view.id, actor: { type: "user" }, config: { [c.field]: value } }),
              ),
            );
          }
          return out;
        });
        const first = expectIdentical(errors);
        expect(first.message).toBe(
          `Invalid config for view type '${c.type}': '${c.field}' does not reference an existing ${c.kind}`,
        );
        expect(first.details).toEqual({ field: `config.${c.field}` });
      });
    }

    it("accepts the tenant's own ids on create and patch", async () => {
      await runInTenant(tenantA, async () => {
        for (const c of [mailbox("mailboxItemId", "item"), journal("inboxDatabaseId", "database")]) {
          const value = c.kind === "database" ? a.databaseId : a.itemId;
          const view = await chokePoint.createView({
            databaseId: a.databaseId,
            type: c.type,
            name: "own",
            config: c.config(value, a),
          });
          const patched = await chokePoint.patchView({
            id: view.id,
            actor: { type: "user" },
            config: { [c.field]: value },
          });
          expect(patched.config).toMatchObject({ [c.field]: value });
        }
      });
    });

    it("still reports the existing service check before the reference checks", async () => {
      await runInTenant(tenantA, async () => {
        await expect(
          chokePoint.createView({
            databaseId: a.databaseId,
            type: MAILBOX_CLIENT_VIEW_TYPE,
            name: "v",
            config: { foldersDatabaseId: a.databaseId, mailboxItemId: randomUUID() },
          }),
        ).rejects.toThrow(/mailboxItemId requires mailboxesDatabaseId/);
      });
    });
  });
});
