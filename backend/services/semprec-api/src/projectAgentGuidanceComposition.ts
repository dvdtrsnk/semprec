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
 * Throws when `AI_GATEWAY_INTERNAL_TOKEN` is unset, so `semprec-api` refuses to start without it.
 */
export function createAiGatewayClientForApi(): AiGatewayClientPort {
  return createHttpAiGatewayClient({
    port: Number(process.env.AI_GATEWAY_PORT ?? "3002"),
    token: requireEnv("AI_GATEWAY_INTERNAL_TOKEN"),
  });
}

/** Registered as the `core.agentGuidanceDrift` heartbeat handler by `createApiActionRegistry`. */
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
