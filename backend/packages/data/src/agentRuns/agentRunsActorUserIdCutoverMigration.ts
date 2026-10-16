import type { Pool } from "pg";
import { withTransaction } from "../db/pool.js";

/**
 * One-time populated-upgrade cutover for issue #220's `agent_runs.actor_user_id` column
 * (0042_agent_runs_actor_user_id.sql adds it nullable; this finishes the job). A delegated run's
 * actor has to be resolved by walking its `parent_run_id` chain up to a root run, which SQL can
 * express directly (`agentRunsStore.ts`'s own runtime resolution instead reads one parent at a
 * time, following `docs/adr/2026-09-11-iterative-parent-chain-traversal-in-choke-point.md`'s
 * "no recursive CTE" convention) — this backfill does the same, iteratively, rather than as plain
 * DDL, so it runs as application code immediately after `runMigrations`, per
 * `docs/adr/2026-09-10-app-code-post-migration-steps.md` (see `docHistoryCutoverMigration.ts` for
 * the identical lock/idempotency-check/backfill/tighten shape this mirrors).
 *
 * Each remaining root run (one with no resolvable parent chain) is attributed to the user bound to
 * its own tenant (`users.tenant_id`). This runs as the table owner, so row-level security does not
 * hide any tenant's rows, and `users` has no row-level security. Throws when a root run's tenant has
 * no user to attribute it to; the transaction then rolls back, so the column stays nullable.
 */
export async function runAgentRunsActorUserIdCutoverMigration(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    // Excludes concurrent agent_runs inserts for the duration of the cutover, so no row can be
    // left with `actor_user_id` still null after this transaction commits.
    await client.query(`LOCK TABLE agent_runs IN EXCLUSIVE MODE`);

    const { rows: columnRows } = await client.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'agent_runs' AND column_name = 'actor_user_id'`,
    );
    if (columnRows[0]?.is_nullable === "NO") return; // already migrated

    // Iteratively propagate a resolved actor down the parent chain until a full pass changes
    // nothing — a delegated run's actor is its ultimate root ancestor's.
    for (;;) {
      const { rowCount } = await client.query(
        `UPDATE agent_runs AS child
            SET actor_user_id = parent.actor_user_id
           FROM agent_runs AS parent
          WHERE child.parent_run_id = parent.id
            AND child.actor_user_id IS NULL
            AND parent.actor_user_id IS NOT NULL`,
      );
      if (!rowCount) break;
    }

    // Each root run takes the user bound to its own tenant. `users.tenant_id` is unique, so the
    // join matches at most one user per run.
    await client.query(
      `UPDATE agent_runs AS r
          SET actor_user_id = u.id
         FROM users u
        WHERE u.tenant_id = r.tenant_id
          AND r.actor_user_id IS NULL`,
    );

    const { rows: remaining } = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM agent_runs WHERE actor_user_id IS NULL`,
    );
    if (Number(remaining[0]!.count) > 0) {
      throw new Error("Cannot backfill agent_runs.actor_user_id: rows exist whose tenant has no user");
    }

    await client.query(`ALTER TABLE agent_runs ALTER COLUMN actor_user_id SET NOT NULL`);
  });
}
