import type { Pool, PoolClient } from "pg";
import type { ModuleRegistry } from "@semprec/module-registry";
import { withTransaction } from "../db/pool.js";
import type { ActionContext, ActionHandler } from "../scheduler/actions.js";
import { getTenantUserLocale } from "../auth/usersStore.js";
import { generatePermissionManifest, type ManifestLocale } from "./permissionManifest.js";
import { toManifestLocale } from "./catalogResolution.js";

export interface OrphanedOwnerProcessProperty {
  propertyId: string;
  databaseId: string;
  key: string;
  ownerProcess: string | null;
}

/** owner: 'system' says who may NOT write, not who does — an empty/unknown owner_process means nothing actually fills it. */
export async function findOrphanedOwnerProcessProperties(
  client: PoolClient,
  activeProcessIds?: ReadonlySet<string>,
): Promise<OrphanedOwnerProcessProperty[]> {
  const { rows } = await client.query<{ id: string; database_id: string; key: string; owner_process: string | null }>(
    `SELECT id, database_id, key, owner_process FROM properties
      WHERE tenant_id = app_tenant_default() AND owner = 'system'`,
  );
  return rows
    .filter((row) => !row.owner_process || (activeProcessIds && !activeProcessIds.has(row.owner_process)))
    .map((row) => ({ propertyId: row.id, databaseId: row.database_id, key: row.key, ownerProcess: row.owner_process }));
}

export const LINK_RULE_SCHEMA_DRIFT_FINDING_KIND = "link_rule_schema_drift";

export type InvalidLinkRuleReasonKind =
  | "missingSourceProperty"
  | "missingTargetProperty"
  | "missingViaProperty"
  | "viaNotRelation"
  | "viaDoesNotLeadToOtherDatabase";

export interface InvalidLinkRuleReference {
  ruleKey: string;
  moduleId: string;
  reason: InvalidLinkRuleReasonKind;
  /** The `databaseKey.propertyKey` the reason is about. */
  property: string;
}

/**
 * Checks every link rule of an active module against the tenant's seeded schema: its source,
 * target and `via` relation properties must exist in the named databases, the `via` property
 * must be a relation, and that relation (its `config.targetDatabaseId`) must lead to the other
 * database of the rule. Reports every problem; one rule can appear more than once.
 */
export async function findInvalidLinkRuleReferences(
  client: PoolClient,
  registry: ModuleRegistry,
): Promise<InvalidLinkRuleReference[]> {
  const rules = await registry.getLinkRules();
  if (rules.length === 0) return [];

  const { rows } = await client.query<{
    database_id: string;
    database_key: string;
    key: string;
    type: string;
    target_database_id: string | null;
  }>(
    `SELECT d.id AS database_id, d.key AS database_key, p.key, p.type, p.config->>'targetDatabaseId' AS target_database_id
     FROM properties p JOIN databases d ON d.id = p.database_id AND d.tenant_id = p.tenant_id
     WHERE p.tenant_id = app_tenant_default() AND d.tenant_id = app_tenant_default() AND d.key IS NOT NULL`,
  );
  const propertyByName = new Map(rows.map((row) => [`${row.database_key}.${row.key}`, row]));
  const databaseIdByKey = new Map(rows.map((row) => [row.database_key, row.database_id]));

  const findings: InvalidLinkRuleReference[] = [];
  for (const rule of rules) {
    const report = (reason: InvalidLinkRuleReasonKind, property: string): void => {
      findings.push({ ruleKey: rule.key, moduleId: rule.moduleId, reason, property });
    };
    const sourceName = `${rule.source.databaseKey}.${rule.source.propertyKey}`;
    const targetName = `${rule.target.databaseKey}.${rule.target.propertyKey}`;
    const viaName = `${rule.via.databaseKey}.${rule.via.relationKey}`;
    if (!propertyByName.has(sourceName)) report("missingSourceProperty", sourceName);
    if (!propertyByName.has(targetName)) report("missingTargetProperty", targetName);
    const via = propertyByName.get(viaName);
    if (!via) {
      report("missingViaProperty", viaName);
      continue;
    }
    if (via.type !== "relation") {
      report("viaNotRelation", viaName);
      continue;
    }
    const otherDatabaseKey =
      rule.via.databaseKey === rule.target.databaseKey ? rule.source.databaseKey : rule.target.databaseKey;
    if (via.target_database_id !== databaseIdByKey.get(otherDatabaseKey)) {
      report("viaDoesNotLeadToOtherDatabase", viaName);
    }
  }
  return findings;
}

export interface CreateDriftCheckActionOptions {
  activeProcessIds?: ReadonlySet<string>;
  /**
   * Threaded straight through to `generatePermissionManifest` (issue #147) so this check also
   * confirms every database/property/option name it touches actually resolves against the
   * loaded catalogs — not just that the query shape is valid. Confirming resolvability without a
   * `moduleRegistry` (the pre-#147 behavior) is still a meaningful check on its own, so this
   * remains optional.
   */
  moduleRegistry?: ModuleRegistry;
  /**
   * Overrides the locale `generatePermissionManifest` resolves against. Ignored unless
   * `moduleRegistry` is also given. Omit this to use the scope's tenant user's
   * `users.locale`, or `en` when that tenant has no user, live on every run (see
   * `createDriftCheckAction` below) — the production behavior. Pass an explicit value only
   * to pin the check to one locale regardless of what's stored, e.g. in a test.
   */
  locale?: ManifestLocale;
}

/**
 * Registers as a heartbeat action; reports via `manifest_drift_findings`, never stays silent
 * about a mismatch. Only the mechanically-checkable half (owner_process orphans) runs
 * here — the manifest <-> `agents` text comparison is a semantic-judgment task that
 * genuinely needs an LLM call through the AI gateway, out of scope for this issue
 * (running an AI agent is a later issue). That comparator plugs in as a later
 * extension to this action, once the agent-orchestration issue exists to supply it.
 */
export function createDriftCheckAction(pool: Pool, options: CreateDriftCheckActionOptions = {}): ActionHandler {
  return async (_actionConfig: Record<string, unknown>, context: ActionContext) => {
    // The orphan check and the notification it produces must be atomic: without a
    // transaction, a crash (or the INSERT throwing) between the SELECT and the INSERT
    // would drop the drift report for this cycle with no trace it was ever detected.
    await withTransaction(pool, async (client) => {
      // Resolved fresh from the scope's tenant user on every run (issue #147 AC #9/#10),
      // falling back to en when the tenant has no user. A locale change is picked up on
      // the very next heartbeat tick, with no persisted manifest to go stale. Looked up
      // only when it'll actually be used — `generatePermissionManifest` ignores `locale`
      // without a `moduleRegistry` — and only when the caller hasn't pinned one explicitly.
      const locale =
        options.locale ??
        (options.moduleRegistry ? toManifestLocale((await getTenantUserLocale(client)) ?? "en") : undefined);

      // Confirms the schema this drift check reports against is actually resolvable;
      // the manifest's content is only consumed once the text comparator (above) exists.
      await generatePermissionManifest(client, context.projectItemId, {
        moduleRegistry: options.moduleRegistry,
        locale,
      });

      const orphaned = await findOrphanedOwnerProcessProperties(client, options.activeProcessIds);
      if (orphaned.length > 0) {
        await client.query(
          `INSERT INTO manifest_drift_findings (kind, payload) VALUES ('agent_manifest_drift', $1::jsonb)`,
          [JSON.stringify({ projectItemId: context.projectItemId, orphanedOwnerProcess: orphaned })],
        );
      }

      if (options.moduleRegistry) {
        const invalidLinkRules = await findInvalidLinkRuleReferences(client, options.moduleRegistry);
        if (invalidLinkRules.length > 0) {
          await client.query(`INSERT INTO manifest_drift_findings (kind, payload) VALUES ($1, $2::jsonb)`, [
            LINK_RULE_SCHEMA_DRIFT_FINDING_KIND,
            JSON.stringify({ projectItemId: context.projectItemId, invalidLinkRules }),
          ]);
        }
      }
    });
  };
}

export const DRIFT_CHECK_ACTION_ID = "core.driftCheck";
