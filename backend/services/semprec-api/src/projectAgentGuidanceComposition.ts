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
  createGuidanceProblemWriter,
  createPoolClientTransactionRunner,
  guidanceDriftHeartbeatStore,
  guidanceReferenceStore,
  projectAgentGuidanceStore,
  projectToolCallUsageStore,
} from "@semprec/data";
import { createGuidanceNotificationWriter } from "@semprec/notifications";
import { createHttpAiGatewayClient } from "@semprec/ai-gateway-client";
import type { AiGatewayClientPort } from "@semprec/shared";
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
 * The HTTP `AiGatewayClientPort` for this process (issue #215's `/internal/complete` route).
 * Throws when `AI_GATEWAY_INTERNAL_TOKEN` is unset, so `semprec-api` refuses to start without it.
 * `createApiActionRegistry` builds it once and shares it between the actions that call the gateway.
 */
export function createAiGatewayClientForApi(): AiGatewayClientPort {
  return createHttpAiGatewayClient({
    port: Number(process.env.AI_GATEWAY_PORT ?? "3002"),
    token: requireEnv("AI_GATEWAY_INTERNAL_TOKEN"),
  });
}

/**
 * Composes `core.agentGuidanceDrift` (issue #85) from this process's concrete stores and the given
 * gateway client. Registered as the `core.agentGuidanceDrift` heartbeat handler by
 * `createApiActionRegistry` (actionRegistryComposition.ts), which builds it once when
 * `createApiQueueRuntime` composes the api runtime.
 */
export function createAgentGuidanceDriftActionForApi(
  pool: Pool,
  gateway: AiGatewayClientPort,
  moduleRegistry?: ModuleRegistry,
): (input: AgentGuidanceDriftActionInput) => Promise<void> {
  return createAgentGuidanceDriftAction<PoolClient>({
    transactions: createPoolClientTransactionRunner(pool),
    guidance: projectAgentGuidanceStore,
    toolCallUsage: projectToolCallUsageStore,
    references: guidanceReferenceStore,
    findings: agentGuidanceDriftFindingsStore,
    notifications: createGuidanceNotificationWriter(),
    problems: createGuidanceProblemWriter(),
    manifest: createGuidanceManifestPort(moduleRegistry),
    gateway,
    clock: () => new Date(),
  });
}
