import { Agent, type AgentEvent, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type {
  AgentImage,
  AgentMessage,
  AgentSession,
  CreateAgentSession,
  ToolCallTarget,
  ToolEventMetadata,
  UserTurnContextRef,
} from "@semprec/agent-runtime";
import { AgentRunError, AiBudgetExceededError } from "@semprec/data";
import { labeledSempMessageRefSchema } from "@semprec/shared";
import { logger } from "./logger.js";
import { toPiMessages } from "./piConversationHistory.js";

export interface PiAgentSessionFactoryOptions {
  model: Model<Api>;
  streamFn: StreamFn;
  tools: AgentTool[];
  moduleToolNames?: ReadonlySet<string>;
  toolEventMetadata: ReadonlyMap<string, ToolEventMetadata>;
  /** The default prompt a session's `systemPromptOverride` receives, and the one used without it. */
  systemPrompt: string;
  /**
   * Pending system messages of the thread since the last turn (approval outcomes), prepended to
   * the next prompt text. Called once per turn; absent means none.
   */
  pendingSystemMessages?: () => readonly string[];
  /** Whether a failed assistant message came from a call the gateway refused for the budget. */
  isBudgetRefusal?: (message: AssistantMessage) => boolean;
}

function isAssistantMessage(message: unknown): message is AssistantMessage {
  return (message as { role?: unknown } | null)?.role === "assistant";
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

/**
 * The databases and items a tool call's arguments name, as the call's events carry them. A relation operation acts
 * on its `callerItemId` (it has no `itemId`), so that is the item its events name: it survives the redaction of the
 * arguments of a later call in a turn (`sensitiveTurnRedaction.ts`), which the reply summaries read it from.
 */
function targetsOf(args: unknown): { targetDatabaseId?: string; targetItemId?: string } {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return {};
  const item = "itemId" in args && typeof args.itemId === "string" ? args.itemId : undefined;
  const caller = "callerItemId" in args && typeof args.callerItemId === "string" ? args.callerItemId : undefined;
  const itemId = item ?? caller;
  return {
    ...("databaseId" in args && typeof args.databaseId === "string" ? { targetDatabaseId: args.databaseId } : {}),
    ...(itemId !== undefined ? { targetItemId: itemId } : {}),
  };
}

/**
 * The `toolCall` blocks of an assistant message that are generic operations, with their operation and targets
 * (issue #2001): pi emits the message before it starts the calls, so the run log needs them to store a content-bearing
 * write to a sensitive database redacted in the message too. A call of any other tool is not listed.
 */
function toolCallTargetsOfContent(
  content: AssistantMessage["content"],
  toolEventMetadata: ReadonlyMap<string, ToolEventMetadata>,
): ToolCallTarget[] {
  return content.flatMap((block): ToolCallTarget[] => {
    if (block.type !== "toolCall") return [];
    const operation = toolEventMetadata.get(block.name)?.operation;
    return operation === undefined ? [] : [{ toolCallId: block.id, operation, ...targetsOf(block.arguments) }];
  });
}

/**
 * Maps one pi-agent-core `AgentEvent` onto the runtime's `AgentMessage` vocabulary, or `null` for
 * an event the run log does not record: agent/message start markers, a tool's partial progress,
 * and every non-assistant `message_end` — a user message is persisted by `promptMessages` itself, and a tool
 * result message duplicates the `tool_result` its `tool_execution_end` produced.
 */
function toAgentMessage(
  event: AgentEvent,
  toolEventMetadata: ReadonlyMap<string, ToolEventMetadata>,
  targets: Map<string, { targetDatabaseId?: string; targetItemId?: string }>,
  isBudgetRefusal: ((message: AssistantMessage) => boolean) | undefined,
): AgentMessage | null {
  switch (event.type) {
    // The turn's assistant message and tool results are already their own `message`/`tool_result`
    // events; repeating them here would only double the stored payload.
    case "turn_start":
    case "turn_end":
      return { kind: event.type };
    case "message_update": {
      const update = event.assistantMessageEvent;
      if (update.type !== "text_delta" && update.type !== "thinking_delta" && update.type !== "toolcall_delta") {
        return null;
      }
      return { kind: "message_update", type: update.type, contentIndex: update.contentIndex, delta: update.delta };
    }
    case "message_end": {
      const message = event.message;
      if (!isAssistantMessage(message)) return null;
      if (message.stopReason === "error" && isBudgetRefusal?.(message)) {
        return {
          kind: "message",
          role: message.role,
          text: "",
          content: [],
          stopReason: "error",
          errorMessage: "AI budget exceeded",
        };
      }
      const toolCallTargets = toolCallTargetsOfContent(message.content, toolEventMetadata);
      return {
        kind: "message",
        role: message.role,
        text: assistantText(message),
        content: message.content,
        stopReason: message.stopReason,
        errorMessage: message.errorMessage,
        ...(toolCallTargets.length > 0 ? { toolCallTargets } : {}),
      };
    }
    case "tool_execution_start": {
      const metadata = toolEventMetadata.get(event.toolName);
      const args: unknown = event.args;
      const target = metadata ? targetsOf(args) : {};
      if (metadata) targets.set(event.toolCallId, target);
      return {
        kind: "tool_use",
        toolCallId: event.toolCallId,
        name: event.toolName,
        arguments: event.args,
        ...metadata,
        ...target,
      };
    }
    case "tool_execution_end": {
      const target = targets.get(event.toolCallId);
      targets.delete(event.toolCallId);
      return {
        kind: "tool_result",
        toolCallId: event.toolCallId,
        name: event.toolName,
        result: event.result,
        isError: event.isError,
        ...toolEventMetadata.get(event.toolName),
        ...target,
      };
    }
    default:
      return null;
  }
}

/**
 * pi reports a failed or aborted model call as a final assistant message rather than a rejected
 * `prompt()`; turn that into a thrown error so the caller closes the run as `error`.
 */
function assertModelSucceeded(
  agent: Agent,
  isBudgetRefusal: ((message: AssistantMessage) => boolean) | undefined,
): void {
  const last = agent.state.messages.at(-1);
  if (!isAssistantMessage(last)) return;
  if (last.stopReason === "error" || last.stopReason === "aborted") {
    if (isBudgetRefusal?.(last)) throw new AiBudgetExceededError();
    throw new AgentRunError("modelError", last.errorMessage ?? `model call ended with stopReason '${last.stopReason}'`);
  }
}

/**
 * Bridges pi's push-based `subscribe` into the pull-based `AsyncIterable` the lifecycle adapter
 * consumes: every mapped event is queued and yielded in arrival order, and the iteration completes
 * once `prompt()` settles and the agent is idle (after `agent_end`). A consumer that stops early
 * (its own write failed) aborts the agent rather than leaving it running unobserved.
 */
async function* promptMessages(
  agent: Agent,
  task: string,
  context: readonly UserTurnContextRef[],
  images: readonly AgentImage[],
  pendingSystemMessages: (() => readonly string[]) | undefined,
  toolFailure: { error: Error | undefined },
  toolEventMetadata: ReadonlyMap<string, ToolEventMetadata>,
  isBudgetRefusal: ((message: AssistantMessage) => boolean) | undefined,
  signal?: AbortSignal,
): AsyncGenerator<AgentMessage> {
  signal?.throwIfAborted();
  const parsed = labeledSempMessageRefSchema.array().safeParse(context);
  if (!parsed.success) throw new Error("Invalid user turn context");
  const promptText = [...(pendingSystemMessages?.() ?? []), task].join("\n\n");
  // Yielded (and so persisted by the consumer) before the prompt is sent to the model.
  yield { kind: "user_message", text: task, context: parsed.data };
  signal?.throwIfAborted();
  const queue: AgentMessage[] = [];
  let wake: (() => void) | null = null;
  let settled = false;
  const notify = (): void => {
    wake?.();
    wake = null;
  };

  const targets = new Map<string, { targetDatabaseId?: string; targetItemId?: string }>();
  const unsubscribe = agent.subscribe((event) => {
    const message = toAgentMessage(event, toolEventMetadata, targets, isBudgetRefusal);
    if (!message) return;
    queue.push(message);
    notify();
  });
  const prompt = agent.prompt(promptText, [...images]).finally(() => {
    settled = true;
    notify();
  });

  const onAbort = (): void => agent.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();

  try {
    for (;;) {
      const next = queue.shift();
      if (next) {
        yield next;
        continue;
      }
      if (settled) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
    await prompt;
    await agent.waitForIdle();
  } finally {
    signal?.removeEventListener("abort", onAbort);
    unsubscribe();
    if (!settled) {
      agent.abort();
      try {
        await prompt;
      } catch {
        // The consumer's own failure is what propagates; this one is only evidence.
        logger.error("pi agent prompt failed after its consumer stopped reading");
      }
    }
  }

  if (toolFailure.error) throw toolFailure.error;
  assertModelSucceeded(agent, isBudgetRefusal);
}

/**
 * The pi-agent-core-backed `CreateAgentSession` (issue #647). Lives in this composition root
 * rather than `packages/agent-runtime`, which only declares the port: see the
 * `pi-only-in-agent-runtime`/`no-agent-runtime-provider-internals` rules in
 * `dependency-cruiser.rules.json`.
 *
 * A tool whose `execute` throws aborts the prompt and fails the session with that error — a
 * thrown tool is an infrastructure failure, not an answer for the model. A tool that returns an
 * error result (the generic-operation tools' `details.error`) is ordinary model input.
 *
 * A session given `initialState.messages` resumes from that reconstructed history, converted by
 * {@link toPiMessages}; history that does not convert fails the factory call.
 */
export function createPiAgentSessionFactory(options: PiAgentSessionFactoryOptions): CreateAgentSession {
  return (sessionOptions) => {
    const initialMessages = toPiMessages(sessionOptions.initialState?.messages ?? [], options.model);
    const toolFailure: { error: Error | undefined } = { error: undefined };
    const tools = options.tools.map((tool): AgentTool => ({
      ...tool,
      async execute(toolCallId, params, signal, onUpdate) {
        try {
          return await tool.execute(toolCallId, params, signal, onUpdate);
        } catch (err) {
          toolFailure.error ??= err instanceof Error ? err : new Error(String(err));
          piAgent.abort();
          throw err;
        }
      },
    }));

    const piAgent = new Agent({
      streamFn: options.streamFn,
      afterToolCall: async (context) => {
        const details: unknown = context.result.details;
        if (
          !context.isError &&
          options.moduleToolNames?.has(context.toolCall.name) &&
          typeof details === "object" &&
          details !== null &&
          "error" in details &&
          details.error === true
        ) {
          return { isError: true };
        }
        return undefined;
      },
      initialState: {
        systemPrompt: sessionOptions.systemPromptOverride?.(options.systemPrompt) ?? options.systemPrompt,
        model: options.model,
        tools,
        messages: initialMessages,
      },
    });

    // Each prompt starts with no recorded tool failure; only one runs at a time (pi refuses a
    // second `prompt()` while one is active).
    const prompt = (
      task: string,
      context: readonly UserTurnContextRef[] = [],
      images: readonly AgentImage[] = [],
    ): AsyncIterable<AgentMessage> => {
      toolFailure.error = undefined;
      return promptMessages(
        piAgent,
        task,
        context,
        images,
        options.pendingSystemMessages,
        toolFailure,
        options.toolEventMetadata,
        options.isBudgetRefusal,
        sessionOptions.signal,
      );
    };
    const session: AgentSession = {
      messages: () => prompt(sessionOptions.task, sessionOptions.context, sessionOptions.images),
      send: prompt,
    };
    return session;
  };
}
