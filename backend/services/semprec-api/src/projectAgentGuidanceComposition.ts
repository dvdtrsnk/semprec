import type { Pool, PoolClient } from "pg";
import {
  createProjectAgentGuidanceService,
  createAgentGuidanceDriftAction,
  type ProjectAgentGuidanceService,
  type AgentGuidanceDriftActionInput,
} from "@semprec/application";
import {
  agentGuidanceDriftFindingsStore,
  createGuidanceManifestPort,
  createPoolClientTransactionRunner,
  guidanceDriftHeartbeatStore,
  guidanceReferenceStore,
  projectAgentGuidanceStore,
} from "@semprec/data";
import { createGuidanceNotificationWriter } from "@semprec/notifications";
import { createHttpAiGatewayClient } from "@semprec/ai-gateway-client";
import type { ModuleRegistry } from "@semprec/module-registry";

/** Composes the real `ProjectAgentGuidanceService` from this process's concrete `@semprec/data` stores. */
export function createProjectAgentGuidanceServiceForApi(pool: Pool): ProjectAgentGuidanceService {
  return createProjectAgentGuidanceService<PoolClient>({
    store: projectAgentGuidanceStore,
    references: guidanceReferenceStore,
    heartbeats: guidanceDriftHeartbeatStore,
    transactions: createPoolClientTransactionRunner(pool),
  });
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/**
 * Composes `core.agentGuidanceDrift` (issue #85) from this process's concrete stores and the HTTP
 * `AiGatewayClientPort` implementation (issue #215's `/internal/complete` route). Registered as the
 * `core.agentGuidanceDrift` heartbeat handler by `createApiActionRegistry`
 * (actionRegistryComposition.ts), which builds it once when `createApiQueueRuntime` composes the
 * api runtime. Throws eagerly when `AI_GATEWAY_INTERNAL_TOKEN` is unset, so `semprec-api`
 * refuses to start without it.
 */
export function createAgentGuidanceDriftActionForApi(
  pool: Pool,
  moduleRegistry?: ModuleRegistry,
): (input: AgentGuidanceDriftActionInput) => Promise<void> {
  const gateway = createHttpAiGatewayClient({
    port: Number(process.env.AI_GATEWAY_PORT ?? "3002"),
    token: requireEnv("AI_GATEWAY_INTERNAL_TOKEN"),
  });

  return createAgentGuidanceDriftAction<PoolClient>({
    transactions: createPoolClientTransactionRunner(pool),
    guidance: projectAgentGuidanceStore,
    references: guidanceReferenceStore,
    findings: agentGuidanceDriftFindingsStore,
    notifications: createGuidanceNotificationWriter(),
    manifest: createGuidanceManifestPort(moduleRegistry),
    gateway,
    clock: () => new Date(),
  });
}
