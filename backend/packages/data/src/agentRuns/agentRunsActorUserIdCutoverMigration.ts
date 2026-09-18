import type { Pool } from "pg";
import { requireAffectedRows, withTransaction } from "../db/pool.js";
import { getEarliestUserId } from "../auth/usersStore.js";

/**
 * One-time populated-upgrade cutover for issue #220's `agent_runs.actor_user_id` column
 * (0041_agent_runs_actor_user_id.sql adds it nullable; this finishes the job). A delegated run's
 * actor has to be resolved by walking its `parent_run_id` chain up to a root run, which SQL can
 * express directly (`agentRunsStore.ts`'s own runtime resolution instead reads one parent at a
 * time, following `docs/adr/2026-09-11-iterative-parent-chain-traversal-in-choke-point.md`'s
 * "no recursive CTE" convention) — this backfill does the same, iteratively, rather than as plain
 * DDL, so it runs as application code immediately after `runMigrations`, per
 * `docs/adr/2026-09-10-app-code-post-migration-steps.md` (see `docHistoryCutoverMigration.ts` for
 * the identical lock/idempotency-check/backfill/tighten shape this mirrors).
 *
 * Every remaining row with no resolvable parent chain (a root run) is attributed to the sole
 * account (Semprec is single-tenant — see `permissionManifest.ts`'s note that "the
 * earliest-created account stands in for 'the' user"). Throws if `agent_runs` has rows but no
 * account exists yet to attribute them to — that combination should never arise in practice
 * (every producer of a root run already requires an authenticated session, the setup owner, or a
 * parent run), so surfacing it loudly here is preferable to silently leaving rows unattributed.
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

    const { rows: remaining } = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM agent_runs WHERE actor_user_id IS NULL`,
    );
    if (Number(remaining[0]!.count) > 0) {
      const ownerId = await getEarliestUserId(client);
      if (!ownerId) {
        throw new Error(
          "Cannot backfill agent_runs.actor_user_id: rows exist with no resolvable parent chain and no account exists",
        );
      }
      const result = await client.query(`UPDATE agent_runs SET actor_user_id = $1 WHERE actor_user_id IS NULL`, [
        ownerId,
      ]);
      requireAffectedRows(result, "agentRunsActorUserIdCutoverMigration: backfill to earliest account");
    }

    await client.query(`ALTER TABLE agent_runs ALTER COLUMN actor_user_id SET NOT NULL`);
  });
}
