import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createPool } from "../../db/pool.js";
import { runTenantCutoverMigrations } from "../../db/tenantCutoverMigrations.js";
import { runNewEmailDraftCutoverMigration } from "../../mail/newEmailDraftCutoverMigration.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createTestTenant, getTenantZeroId, getTestPool, resetDatabase } from "../../testSupport/testDb.js";

let admin: Pool;
let data: Pool;
let fresh: string;
let old: string;

async function heartbeat(tenant: string) {
  return runInTenant(tenant, async () => {
    const result = await data.query<{ id: string; action_config: unknown; origin: string }>(
      "SELECT id, action_config, origin FROM project_heartbeats WHERE name = 'newEmail'",
    );
    expect(result.rows).toHaveLength(1);
    return result.rows[0]!;
  });
}

/** Raw SQL: the pre-cutover action config cannot be produced by the current seed. */
async function setActionConfig(tenant: string, id: string, expression: string): Promise<void> {
  const changed = await admin.query(
    `UPDATE project_heartbeats SET action_config = ${expression} WHERE tenant_id = $1 AND id = $2`,
    [tenant, id],
  );
  expect(changed.rowCount).toBe(1);
}

describe("newEmail draft tenant cutover (issue gh-1941)", () => {
  beforeAll(() => {
    admin = getTestPool();
    data = createPool(process.env.TEST_DATABASE_URL ?? "", { role: "semprec_data" });
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    fresh = getTenantZeroId();
    old = await createTestTenant(admin);
    for (const tenant of [fresh, old]) await runInTenant(tenant, () => seedSystem(data));
  });

  afterAll(async () => {
    await data.end();
    await admin.end();
  });

  it("gives a populated tenant both keys once, through the registered tenant cutovers, and matches a fresh seed", async () => {
    const freshBefore = await heartbeat(fresh);
    const oldBefore = await heartbeat(old);
    expect(oldBefore.action_config).toMatchObject({
      answerExpectedFilter: {},
      runProject: { resolver: "mailThreadProject" },
    });
    await setActionConfig(old, oldBefore.id, "action_config - 'answerExpectedFilter' - 'runProject'");
    expect((await heartbeat(old)).action_config).not.toHaveProperty("runProject");
    const run = () => runAsSystem("newEmail draft cutover test", () => runTenantCutoverMigrations(data));

    await run();
    const first = await heartbeat(old);
    expect(first.action_config).toEqual(oldBefore.action_config);
    expect(await heartbeat(fresh)).toEqual(freshBefore);

    await run();
    expect(await heartbeat(old)).toEqual(first);
    expect(await heartbeat(fresh)).toEqual(freshBefore);
  });

  it("adds only the key that is missing and leaves the other one as it is", async () => {
    const before = await heartbeat(old);
    await setActionConfig(
      old,
      before.id,
      `(action_config - 'answerExpectedFilter') || '{"runProject": {"resolver": "mailThreadProject", "kept": true}}'::jsonb`,
    );

    await runInTenant(old, () => runNewEmailDraftCutoverMigration(data));

    expect((await heartbeat(old)).action_config).toMatchObject({
      answerExpectedFilter: {},
      runProject: { resolver: "mailThreadProject", kept: true },
    });

    await setActionConfig(
      old,
      before.id,
      `(action_config - 'runProject') || '{"answerExpectedFilter": {"kept": true}}'::jsonb`,
    );

    await runInTenant(old, () => runNewEmailDraftCutoverMigration(data));

    expect((await heartbeat(old)).action_config).toMatchObject({
      answerExpectedFilter: { kept: true },
      runProject: { resolver: "mailThreadProject" },
    });
  });

  it("leaves a heartbeat named newEmail that a person created, and the other tenant's heartbeat, alone", async () => {
    const before = await heartbeat(old);
    await setActionConfig(old, before.id, "action_config - 'answerExpectedFilter' - 'runProject'");
    // Raw SQL: no API changes the origin of a system heartbeat.
    await admin.query("UPDATE project_heartbeats SET origin = 'user' WHERE tenant_id = $1 AND id = $2", [
      old,
      before.id,
    ]);
    const freshBefore = await heartbeat(fresh);
    await setActionConfig(fresh, freshBefore.id, "action_config - 'answerExpectedFilter'");

    await runInTenant(old, () => runNewEmailDraftCutoverMigration(data));

    expect((await heartbeat(old)).action_config).not.toHaveProperty("runProject");
    expect((await heartbeat(old)).action_config).not.toHaveProperty("answerExpectedFilter");
    // The run was scoped to `old`; `fresh` keeps the state it was left in.
    expect((await heartbeat(fresh)).action_config).not.toHaveProperty("answerExpectedFilter");
  });
});
