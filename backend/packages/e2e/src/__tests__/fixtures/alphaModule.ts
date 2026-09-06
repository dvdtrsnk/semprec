import type { ModuleManifest } from "@semprec/module-registry";
import type { JobHelpers } from "graphile-worker";

/**
 * One half of the e2e cross-module scenario (module-contract issue #114): declares its own
 * database, a task, a data migration, and a heartbeat rule kind, then hands off to the "beta"
 * module's task by name only (never by importing beta's fixture file) once its own work is
 * done — exactly the boundary `@semprec/module-boundaries` (issue #113) enforces for real
 * modules.
 */
export const manifest: ModuleManifest = {
  id: "e2e-alpha",
  version: "1.0.0",
  name: "E2E Alpha",
  removable: true,
  systemProject: false,
  databases: [{ key: "e2eAlphaItems", name: "E2E Alpha Items" }],
  capabilities: [],
  agentTools: [],
  heartbeatRuleKinds: [{ kind: "e2eAlpha.onTick", schemaExport: "alphaTickRuleSchema", nextFireAtExport: "computeAlphaTickNextFireAt" }],
  taskNames: [{ name: "e2eAlpha.ingest", payloadSchemaExport: "ingestPayloadSchema", handlerExport: "handleIngest" }],
  migrations: ["0001_e2e_alpha_marker.sql"],
  dataMigrations: [{ databaseKey: "e2eAlphaItems", fromVersion: "1.0.0", toVersion: "2.0.0", converterExport: "convertAlphaItem" }],
};

export interface IngestPayload {
  alphaDatabaseId: string;
  betaDatabaseId: string;
  value: string;
}

export const ingestPayloadSchema = {
  parse(raw: unknown): IngestPayload {
    const value = raw as Partial<IngestPayload> | null;
    if (!value || typeof value.alphaDatabaseId !== "string" || typeof value.betaDatabaseId !== "string" || typeof value.value !== "string") {
      throw new Error("e2eAlpha.ingest payload must have alphaDatabaseId, betaDatabaseId, and value strings");
    }
    return { alphaDatabaseId: value.alphaDatabaseId, betaDatabaseId: value.betaDatabaseId, value: value.value };
  },
};

/** Records its own item, then relays to beta's task via the queue — the scenario's cross-module hop. */
export async function handleIngest(payload: IngestPayload, helpers: JobHelpers): Promise<void> {
  const itemId = await helpers.withPgClient(async (client) => {
    const { rows } = await client.query<{ id: string }>(`INSERT INTO items (database_id, properties) VALUES ($1, $2::jsonb) RETURNING id`, [
      payload.alphaDatabaseId,
      JSON.stringify({ value: payload.value }),
    ]);
    return rows[0].id;
  });

  await helpers.addJob("e2eBeta.relay", { betaDatabaseId: payload.betaDatabaseId, sourceItemId: itemId });
}

export const alphaTickRuleSchema = {
  safeParse(raw: unknown): { success: boolean; data?: unknown; error?: { message: string } } {
    const value = raw as { kind?: unknown } | null;
    if (value && value.kind === "e2eAlpha.onTick") return { success: true, data: value };
    return { success: false, error: { message: "not an e2eAlpha.onTick rule" } };
  },
};

export function computeAlphaTickNextFireAt(_rule: unknown, _timezone: string, after: Date): Date {
  return new Date(after.getTime() + 60_000);
}

export function convertAlphaItem(properties: Record<string, unknown>): Record<string, unknown> {
  return { ...properties, migrated: true };
}
