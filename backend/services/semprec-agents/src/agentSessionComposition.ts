import { createCollectionMetadataResolver } from "@semprec/data";
import type { Pool } from "pg";
import type { AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import {
  createApprovalGatedMcpInvokeTool,
  createGenericOperationAgentTools,
  createProjectAgentGuidanceSystemPromptOverride,
  listGrantedGenericOperationAgentTools,
  type CreateAgentSession,
  type ToolEventMetadata,
} from "@semprec/agent-runtime";
import {
  createPoolClientTransactionRunner,
  getTenantUserLocale,
  getSempThread,
  getSempMessageTurn,
  generateSchemaProjection,
  toManifestLocale,
  withTransaction,
  APPROVAL_REQUEST_REASON_MAX_LENGTH,
  listMcpToolGrantsForProject,
  projectAgentGuidanceStore,
  withClient,
  resolveModuleAgentToolsForRun,
  resolveModuleRuleKinds,
  type AgentRunRow,
} from "@semprec/data";
import type { ModuleRegistry } from "@semprec/module-registry";
import {
  GENERIC_OPERATION_NAMES,
  OPERATION_METADATA,
  operationInputJsonSchema,
  type GenericOperationName,
} from "@semprec/shared";
import type { GatewayModel } from "./modelComposition.js";
import { createPiAgentSessionFactory } from "./piAgentSession.js";
import { logger } from "./logger.js";

const LANGUAGE_INSTRUCTIONS: Readonly<Record<"cs" | "en", string>> = {
  cs: "Answer and write all user-visible text in Czech.",
  en: "Answer and write all user-visible text in English.",
};

function languageInstruction(locale: string | null): string | undefined {
  return locale === "cs" || locale === "en" ? LANGUAGE_INSTRUCTIONS[locale] : undefined;
}

const AGENT_BASE_SYSTEM_PROMPT = [
  "You are an agent inside Semprec, a personal life-organization system.",
  "You are given one task. Complete it using only the tools you are offered, then reply with a short",
  "plain-text summary of what you did. A tool that reports it needs human approval has not run yet:",
  "say so in your summary instead of retrying it.",
].join(" ");

const ITEM_THREAD_OPERATIONS = [
  "database.list",
  "database.get",
  "property.list",
  "property.get",
  "property.getByKey",
  "view.list",
  "view.get",
  "view.query",
  "item.get",
  "database.query",
] as const satisfies readonly GenericOperationName[];

/** The header `semprec-ai-gateway`'s pi-messages route attributes its `ai_gateway_calls` row by. */
const AGENT_RUN_ID_HEADER = "x-semprec-agent-run-id";
const SEMP_MESSAGE_ID_HEADER = "x-semprec-semp-message-id";

/**
 * Accepts any JSON object as tool arguments: an MCP tool's synchronized schema is validated by
 * `resolveMcpInvocation` against the registration itself, on every call.
 */
const MCP_TOOL_PARAMETERS = Type.Object({}, { additionalProperties: true });

/** Same, for an approval-gated MCP tool: the free-form arguments plus the reserved optional reason (issue #1420). */
const APPROVAL_GATED_MCP_TOOL_PARAMETERS = Type.Object(
  { semprecReason: Type.Optional(Type.String({ maxLength: APPROVAL_REQUEST_REASON_MAX_LENGTH })) },
  { additionalProperties: true },
);

/** The optional argument an approval-gated generic operation's tool schema adds; it never reaches the operation input. */
const GENERIC_OPERATION_REASON_KEY = "reason";

/**
 * The tool schema for one generic operation: the operation's own strict input schema, plus the
 * optional agent-only `reason` when the operation is approval-gated (issue #1420).
 */
function genericOperationToolSchema(operation: GenericOperationName): Record<string, unknown> {
  const schema =
    operation === "database.query" || operation === "view.query"
      ? operationInputJsonSchema(operation, "agent-query-compact")
      : operationInputJsonSchema(operation);
  if (!OPERATION_METADATA[operation].requiresApproval) return schema;
  const properties = isArgumentsObject(schema.properties) ? schema.properties : {};
  return {
    ...schema,
    properties: {
      ...properties,
      [GENERIC_OPERATION_REASON_KEY]: { type: "string", maxLength: APPROVAL_REQUEST_REASON_MAX_LENGTH },
    },
  };
}

type ReasonSplit = { ok: true; args: unknown; reason?: string } | { ok: false; error: string };

/** Removes the agent-only `reason` from an approval-gated operation's arguments before the operation validates them. */
function splitGenericOperationReason(operation: GenericOperationName, params: unknown): ReasonSplit {
  if (!OPERATION_METADATA[operation].requiresApproval || !isArgumentsObject(params)) return { ok: true, args: params };
  if (!(GENERIC_OPERATION_REASON_KEY in params)) return { ok: true, args: params };
  const { [GENERIC_OPERATION_REASON_KEY]: raw, ...args } = params;
  if (raw === undefined || raw === null) return { ok: true, args };
  if (typeof raw !== "string" || Array.from(raw).length > APPROVAL_REQUEST_REASON_MAX_LENGTH) {
    return {
      ok: false,
      error: `Invalid argument 'reason': it must be a string of at most ${APPROVAL_REQUEST_REASON_MAX_LENGTH} characters.`,
    };
  }
  return { ok: true, args, reason: raw };
}

/**
 * Model providers accept only `[A-Za-z0-9_-]{1,64}` as a tool name, so a generic operation's dotted
 * name (`item.create`) and an MCP server's free-form tool name are both mapped onto that alphabet.
 */
function toModelToolName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
}

/**
 * Model-facing name of an MCP tool: `mcp_<tool>_<first 8 hex of the server item id>`. The immutable
 * server id (not its renameable name) keeps the name stable and separates servers that expose the
 * same tool name; the tool part is sanitized and cut so the whole name stays within 64 characters.
 */
export function mcpModelToolName(toolName: string, mcpServerItemId: string): string {
  const suffix = mcpServerItemId
    .replace(/-/g, "")
    .toLowerCase()
    .slice(0, 8)
    .replace(/[^a-z0-9_]/g, "_");
  const tool = toolName.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64 - "mcp_".length - 1 - 8);
  return `mcp_${tool}_${suffix}`;
}

function isArgumentsObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type ComposedAgentTool = AgentTool & { toolEventMetadata?: ToolEventMetadata };

async function createModuleTools(
  pool: Pool,
  registry: ModuleRegistry,
  runId: string,
  projectItemId: string,
): Promise<ComposedAgentTool[]> {
  const definitions = await resolveModuleAgentToolsForRun(pool, registry, runId, projectItemId);
  return definitions.map(
    (definition) =>
      ({
        name: toModelToolName(definition.name),
        label: definition.name,
        description: `Semprec module tool '${definition.name}'.`,
        parameters: Type.Unsafe(definition.argumentSchema),
        async execute(_toolCallId, params) {
          if (!definition.acceptsArguments(params))
            return { content: [{ type: "text", text: "Invalid tool arguments." }], details: { error: true } };
          try {
            const result = await definition.invoke(params);
            return { content: [{ type: "text", text: result.result }], details: { error: result.error } };
          } catch {
            logger.warn({ toolName: definition.name }, "Module tool execution failed");
            return { content: [{ type: "text", text: "Module tool failed." }], details: { error: true } };
          }
        },
      }) satisfies ComposedAgentTool,
  );
}

async function createGenericOperationTools(
  pool: Pool,
  moduleRegistry: ModuleRegistry,
  runId: string,
): Promise<ComposedAgentTool[]> {
  const resolver = await createCollectionMetadataResolver(moduleRegistry);
  const operations = await listGrantedGenericOperationAgentTools(pool, moduleRegistry, runId, resolver);
  const implementations = createGenericOperationAgentTools(pool, moduleRegistry, resolver);
  return operations.map((operation) => ({
    name: toModelToolName(operation),
    label: operation,
    toolEventMetadata: { operation },
    description: `Semprec generic operation '${operation}'.`,
    parameters: Type.Unsafe(genericOperationToolSchema(operation)),
    async execute(toolCallId, params) {
      const split = splitGenericOperationReason(operation, params);
      if (!split.ok) {
        return { content: [{ type: "text", text: split.error }], details: { error: true } };
      }
      const result = await implementations[operation](runId, split.args, {
        ...(split.reason === undefined ? {} : { reason: split.reason }),
        toolCallId,
      });
      return {
        content: [{ type: "text", text: result.result }],
        details: {
          error: result.error,
          ...(result.approvalRequestId !== undefined ? { approvalRequestId: result.approvalRequestId } : {}),
          ...(result.changes !== undefined ? { changes: result.changes } : {}),
        },
      };
    },
  }));
}

async function createMcpTools(pool: Pool, runId: string, projectItemId: string): Promise<ComposedAgentTool[]> {
  // The agent never shows `displayLabel` to a person, so the locale only picks the (unused) label fallback.
  const grants = await withClient(pool, (client) => listMcpToolGrantsForProject(client, projectItemId, "en"));
  // The listing keeps tools of switched-off servers for the settings screen; a run only offers tools that can run.
  return grants
    .filter((grant) => grant.granted && grant.mcpServerOnline)
    .map((grant) => {
      const invoke = createApprovalGatedMcpInvokeTool(
        pool,
        runId,
        projectItemId,
        grant.mcpToolRegistrationId,
        {},
        grant.mcpServerItemId,
      );
      return {
        name: mcpModelToolName(grant.toolName, grant.mcpServerItemId),
        label: `${grant.mcpServerName}: ${grant.toolName}`,
        toolEventMetadata: {
          mcp: {
            toolRegistrationId: grant.mcpToolRegistrationId,
            serverItemId: grant.mcpServerItemId,
            serverName: grant.mcpServerName,
            toolName: grant.toolName,
          },
        },
        description: grant.description ?? `MCP tool '${grant.toolName}' on '${grant.mcpServerName}'.`,
        parameters: grant.requiresApproval ? APPROVAL_GATED_MCP_TOOL_PARAMETERS : MCP_TOOL_PARAMETERS,
        async execute(toolCallId, params, signal) {
          if (!isArgumentsObject(params)) {
            return {
              content: [{ type: "text", text: "Tool arguments must be a JSON object." }],
              details: { error: true },
            };
          }
          const result = await invoke(params, signal, { toolCallId });
          return {
            content: [{ type: "text", text: result.result }],
            details: {
              error: result.error,
              ...(result.approvalRequestId !== undefined ? { approvalRequestId: result.approvalRequestId } : {}),
              ...(result.failure
                ? {
                    failureKind: result.failure.failureKind,
                    ...(result.failure.mcpServerItemId !== undefined
                      ? { mcpServerItemId: result.failure.mcpServerItemId }
                      : {}),
                    connectorName: grant.mcpServerName,
                    ...(result.failure.failureKind === "timeout" ? { timeoutMs: result.failure.timeoutMs } : {}),
                  }
                : {}),
            },
          };
        },
      } satisfies ComposedAgentTool;
    });
}

/**
 * Two granted MCP servers can expose the same tool name, and a model can only address one of
 * them: the first keeps the name, and every later one is left out of this run's catalog, logged.
 */
export function withUniqueNames<T extends AgentTool>(tools: T[]): T[] {
  const seen = new Set<string>();
  return tools.filter((tool) => {
    if (!seen.has(tool.name)) {
      seen.add(tool.name);
      return true;
    }
    logger.warn({ toolName: tool.name }, "Agent tool name collides with an earlier tool; skipped");
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
  currentSempMessage?: { current: string | null },
): Promise<CreateAgentSession> {
  if (!ITEM_THREAD_OPERATIONS.every((name) => GENERIC_OPERATION_NAMES.includes(name)))
    throw new Error("Unknown item-thread generic operation");
  const allGenericTools = await createGenericOperationTools(pool, moduleRegistry, run.id);
  const locale = await getTenantUserLocale(pool);
  const threadId = run.threadId;
  const threadContext = threadId
    ? await withTransaction(pool, async (client) => {
        const thread = await getSempThread(client, threadId, await resolveModuleRuleKinds(moduleRegistry));
        if (!thread) throw new Error("Semp thread not found for run");
        const schema = await generateSchemaProjection(client, moduleRegistry, {
          locale: toManifestLocale(locale ?? "en"),
        });
        const turn =
          thread.kind === "tick" && currentSempMessage?.current
            ? await getSempMessageTurn(client, threadId, currentSempMessage.current)
            : null;
        return {
          kind: thread.kind,
          databases: schema.databases,
          missingHeartbeat: thread.kind === "tick" && !!currentSempMessage?.current && !turn?.projectItemId,
        };
      })
    : null;
  const tools =
    threadContext?.kind === "item"
      ? allGenericTools.filter((tool) => ITEM_THREAD_OPERATIONS.some((name) => name === tool.label))
      : allGenericTools;
  let moduleTools: typeof tools = [];
  // Read once per run: a locale change applies from the next run, a running one keeps its prompt.
  const instruction = languageInstruction(locale);
  const basePrompt = threadContext
    ? [
        "You are Semp, the user's assistant for tasks, calendar, notes and other data.",
        "Answer in the user's language. A tool requiring approval has not run yet.",
        "Deleting an item moves it to trash for 30 days; item.restore restores it.",
        "Link items as semprec://items/<id>.",
        `Data schema: ${JSON.stringify(threadContext.databases)}`,
      ].join("\n")
    : AGENT_BASE_SYSTEM_PROMPT;
  let systemPrompt = instruction ? `${basePrompt}\n${instruction}` : basePrompt;

  if (run.projectItemId) {
    if (threadContext?.kind !== "item") {
      tools.push(...(await createMcpTools(pool, run.id, run.projectItemId)));
      moduleTools = await createModuleTools(pool, moduleRegistry, run.id, run.projectItemId);
      if (threadContext?.missingHeartbeat)
        moduleTools = moduleTools.filter((tool) => !tool.label.startsWith("heartbeat."));
      tools.push(...moduleTools);
    }
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

  const streamFn: StreamFn = (model, context, options) => {
    const headers: Record<string, string> = { ...options?.headers, [AGENT_RUN_ID_HEADER]: run.id };
    delete headers[SEMP_MESSAGE_ID_HEADER];
    if (currentSempMessage?.current) headers[SEMP_MESSAGE_ID_HEADER] = currentSempMessage.current;
    return gateway.streamFn(model, context, { ...options, headers });
  };

  const uniqueTools = withUniqueNames(tools);
  const toolEventMetadata = new Map(
    uniqueTools.flatMap((tool) => (tool.toolEventMetadata ? [[tool.name, tool.toolEventMetadata] as const] : [])),
  );
  return createPiAgentSessionFactory({
    model: gateway.model,
    streamFn,
    tools: uniqueTools,
    moduleToolNames: new Set(uniqueTools.filter((tool) => moduleTools.includes(tool)).map((tool) => tool.name)),
    toolEventMetadata,
    systemPrompt,
    isBudgetRefusal: gateway.isBudgetRefusal,
  });
}
