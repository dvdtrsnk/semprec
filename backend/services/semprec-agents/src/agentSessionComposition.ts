import type { Pool } from "pg";
import type { AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import {
  createApprovalGatedMcpInvokeTool,
  createGenericOperationAgentTools,
  createProjectAgentGuidanceSystemPromptOverride,
  listGrantedGenericOperationAgentTools,
  type CreateAgentSession,
} from "@semprec/agent-runtime";
import {
  createPoolClientTransactionRunner,
  listMcpToolGrantsForProject,
  projectAgentGuidanceStore,
  withClient,
  type AgentRunRow,
} from "@semprec/data";
import type { ModuleRegistry } from "@semprec/module-registry";
import { operationInputJsonSchema } from "@semprec/shared";
import type { GatewayModel } from "./modelComposition.js";
import { createPiAgentSessionFactory } from "./piAgentSession.js";
import { logger } from "./logger.js";

const AGENT_BASE_SYSTEM_PROMPT = [
  "You are an agent inside Semprec, a personal life-organization system.",
  "You are given one task. Complete it using only the tools you are offered, then reply with a short",
  "plain-text summary of what you did. A tool that reports it needs human approval has not run yet:",
  "say so in your summary instead of retrying it.",
].join(" ");

/** The header `semprec-ai-gateway`'s pi-messages route attributes its `ai_gateway_calls` row by. */
const AGENT_RUN_ID_HEADER = "x-semprec-agent-run-id";

/**
 * Accepts any JSON object as tool arguments: an MCP tool's synchronized schema is validated by
 * `resolveMcpInvocation` against the registration itself, on every call.
 */
const MCP_TOOL_PARAMETERS = Type.Object({}, { additionalProperties: true });

/**
 * Model providers accept only `[A-Za-z0-9_-]{1,64}` as a tool name, so a generic operation's dotted
 * name (`item.create`) and an MCP server's free-form tool name are both mapped onto that alphabet.
 */
function toModelToolName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
}

function isArgumentsObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function createGenericOperationTools(
  pool: Pool,
  moduleRegistry: ModuleRegistry,
  runId: string,
): Promise<AgentTool[]> {
  const operations = await listGrantedGenericOperationAgentTools(pool, moduleRegistry, runId);
  const implementations = createGenericOperationAgentTools(pool, moduleRegistry);
  return operations.map((operation) => ({
    name: toModelToolName(operation),
    label: operation,
    description: `Semprec generic operation '${operation}'.`,
    parameters: Type.Unsafe(operationInputJsonSchema(operation)),
    async execute(_toolCallId, params) {
      const result = await implementations[operation](runId, params);
      return { content: [{ type: "text", text: result.result }], details: { error: result.error } };
    },
  }));
}

async function createMcpTools(pool: Pool, runId: string, projectItemId: string): Promise<AgentTool[]> {
  const grants = await withClient(pool, (client) => listMcpToolGrantsForProject(client, projectItemId));
  return grants
    .filter((grant) => grant.granted)
    .map((grant) => {
      const invoke = createApprovalGatedMcpInvokeTool(pool, runId, projectItemId, grant.mcpToolRegistrationId);
      return {
        name: toModelToolName(`mcp_${grant.toolName}`),
        label: `${grant.mcpServerName}: ${grant.toolName}`,
        description: grant.description ?? `MCP tool '${grant.toolName}' on '${grant.mcpServerName}'.`,
        parameters: MCP_TOOL_PARAMETERS,
        async execute(_toolCallId, params) {
          if (!isArgumentsObject(params)) {
            return {
              content: [{ type: "text", text: "Tool arguments must be a JSON object." }],
              details: { error: true },
            };
          }
          const result = await invoke(params);
          return { content: [{ type: "text", text: result.result }], details: { error: result.error } };
        },
      } satisfies AgentTool;
    });
}

/**
 * Two granted MCP servers can expose the same tool name, and a model can only address one of
 * them: the first keeps the name, and every later one is left out of this run's catalog, logged.
 */
function withUniqueNames(tools: AgentTool[]): AgentTool[] {
  const seen = new Set<string>();
  return tools.filter((tool) => {
    if (!seen.has(tool.name)) {
      seen.add(tool.name);
      return true;
    }
    logger.warn({ toolName: tool.name, label: tool.label }, "Agent tool name collides with an earlier tool; skipped");
    return false;
  });
}

/**
 * Composes one run's `CreateAgentSession` (issue #647): the generic-operation tools the run's
 * project is granted, plus — for a run with a project — one tool per granted MCP registration
 * (each approval-gated), the project's own guidance appended to the base system prompt, and a
 * `streamFn` that tags every gateway request with this run's id.
 */
export async function createAgentSessionFactoryForRun(
  pool: Pool,
  moduleRegistry: ModuleRegistry,
  gateway: GatewayModel,
  run: AgentRunRow,
): Promise<CreateAgentSession> {
  const tools = await createGenericOperationTools(pool, moduleRegistry, run.id);
  let systemPrompt = AGENT_BASE_SYSTEM_PROMPT;

  if (run.projectItemId) {
    tools.push(...(await createMcpTools(pool, run.id, run.projectItemId)));
    const transactions = createPoolClientTransactionRunner(pool);
    const override = await createProjectAgentGuidanceSystemPromptOverride(
      (projectItemId) =>
        transactions.withTransaction({ isolation: "repeatable_read" }, (tx) =>
          projectAgentGuidanceStore.load(tx, projectItemId),
        ),
      run.projectItemId,
    );
    systemPrompt = override(systemPrompt);
  }

  const streamFn: StreamFn = (model, context, options) =>
    gateway.streamFn(model, context, { ...options, headers: { ...options?.headers, [AGENT_RUN_ID_HEADER]: run.id } });

  return createPiAgentSessionFactory({ model: gateway.model, streamFn, tools: withUniqueNames(tools), systemPrompt });
}
