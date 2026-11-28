import type { Pool, PoolClient } from "pg";
import type { ModuleRegistry } from "@alldots/module-registry";
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

/** owner: 'system' says who may NOT write; an empty/unknown owner_process means nothing fills it. */
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
  | "viaDoesNotLeadToOtherDatabase"
  | "missingValueFilterProperty"
  | "valueFilterNotRelation";

export interface InvalidLinkRuleReference {
  ruleKey: string;
  moduleId: string;
  reason: InvalidLinkRuleReasonKind;
  /** `databaseKey.propertyKey`. */
  property: string;
}

/**
 * Checks every active link rule against the seeded schema: properties exist, `via` is a relation
 * leading to the rule's other database, and `valueFilter.omit` names a relation. Reports every
 * problem; one rule can appear more than once.
 */
export async function findInvalidLinkRuleReferences(
  client: PoolClient,
  registry: ModuleRegistry,
): Promise<InvalidLinkRuleReference[]> {
  const rules = await registry.getLinkRules();
  if (rules.length === 0) return [];

  const { rows: allRows } = await client.query<{
    database_id: string;
    database_key: string | null;
    owner_module_id: string | null;
    system: boolean;
    key: string;
    type: string;
    target_database_id: string | null;
  }>(
    `SELECT d.id AS database_id, d.key AS database_key, d.owner_module_id, d.system, p.key, p.type,
            p.config->>'targetDatabaseId' AS target_database_id
     FROM properties p JOIN databases d ON d.id = p.database_id AND d.tenant_id = p.tenant_id
     WHERE p.tenant_id = app_tenant_default() AND d.tenant_id = app_tenant_default()
       AND (d.key IS NOT NULL OR (d.system AND d.owner_module_id IS NOT NULL))`,
  );
  const rows = allRows.filter((row) => row.database_key !== null);
  const propertyByName = new Map(rows.map((row) => [`${row.database_key}.${row.key}`, row]));
  const databaseIdByKey = new Map(rows.map((row) => [row.database_key, row.database_id]));
  // A value filter names a system database by its owner module id, as `resolveValueFilter` reads it.
  const valueFilterPropertyByName = new Map(
    allRows
      .filter((row) => row.system && row.owner_module_id !== null)
      .map((row) => [`${row.owner_module_id}.${row.key}`, row]),
  );

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
    if (rule.valueFilter) {
      const omitName = `${rule.valueFilter.omit.databaseKey}.${rule.valueFilter.omit.propertyKey}`;
      const omit = valueFilterPropertyByName.get(omitName);
      if (!omit) report("missingValueFilterProperty", omitName);
      else if (omit.type !== "relation") report("valueFilterNotRelation", omitName);
    }
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
  /** When given, the check also confirms every touched name resolves against the catalogs. */
  moduleRegistry?: ModuleRegistry;
  /**
   * Ignored without `moduleRegistry`. Omitted (production), the tenant user's locale is read on
   * every run, `en` when there is no user; pass one only to pin it, e.g. in a test.
   */
  locale?: ManifestLocale;
}

/**
 * Reports via `manifest_drift_findings`, never silently. Only the mechanical half
 * (owner_process orphans) runs here; comparing the manifest with `agents` text needs an LLM.
 */
export function createDriftCheckAction(pool: Pool, options: CreateDriftCheckActionOptions = {}): ActionHandler {
  return async (_actionConfig: Record<string, unknown>, context: ActionContext) => {
    // Atomic, so a failure between detection and the INSERT cannot drop the report.
    await withTransaction(pool, async (client) => {
      // Read fresh each run so a locale change applies on the next tick; only when it will be used.
      const locale =
        options.locale ??
        (options.moduleRegistry ? toManifestLocale((await getTenantUserLocale(client)) ?? "en") : undefined);

      // Only confirms the schema is resolvable; the manifest content itself is not consumed yet.
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
