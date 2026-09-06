import type { ModuleManifest } from "@semprec/module-registry";
import type { JobHelpers } from "graphile-worker";

/** The other half of the e2e cross-module scenario — see alphaModule.ts's header comment. */
export const manifest: ModuleManifest = {
  id: "e2e-beta",
  version: "1.0.0",
  name: "E2E Beta",
  removable: true,
  systemProject: false,
  databases: [{ key: "e2eBetaItems", name: "E2E Beta Items" }],
  capabilities: [],
  agentTools: [],
  heartbeatRuleKinds: [{ kind: "e2eBeta.onTick", schemaExport: "betaTickRuleSchema", nextFireAtExport: "computeBetaTickNextFireAt" }],
  taskNames: [{ name: "e2eBeta.relay", payloadSchemaExport: "relayPayloadSchema", handlerExport: "handleRelay" }],
  migrations: ["0001_e2e_beta_marker.sql"],
};

export interface RelayPayload {
  betaDatabaseId: string;
  sourceItemId: string;
}

export const relayPayloadSchema = {
  parse(raw: unknown): RelayPayload {
    const value = raw as Partial<RelayPayload> | null;
    if (!value || typeof value.betaDatabaseId !== "string" || typeof value.sourceItemId !== "string") {
      throw new Error("e2eBeta.relay payload must have betaDatabaseId and sourceItemId strings");
    }
    return { betaDatabaseId: value.betaDatabaseId, sourceItemId: value.sourceItemId };
  },
};

/** Records the linked item alpha's task relayed to it — proof the cross-module hop actually landed. */
export async function handleRelay(payload: RelayPayload, helpers: JobHelpers): Promise<void> {
  await helpers.withPgClient((client) =>
    client.query(`INSERT INTO items (database_id, properties) VALUES ($1, $2::jsonb)`, [
      payload.betaDatabaseId,
      JSON.stringify({ sourceItemId: payload.sourceItemId }),
    ]),
  );
}

export const betaTickRuleSchema = {
  safeParse(raw: unknown): { success: boolean; data?: unknown; error?: { message: string } } {
    const value = raw as { kind?: unknown } | null;
    if (value && value.kind === "e2eBeta.onTick") return { success: true, data: value };
    return { success: false, error: { message: "not an e2eBeta.onTick rule" } };
  },
};

export function computeBetaTickNextFireAt(_rule: unknown, _timezone: string, after: Date): Date {
  return new Date(after.getTime() + 120_000);
}
