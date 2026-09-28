import { Agent, type AgentEvent, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { AgentMessage, AgentSession, CreateAgentSession } from "@semprec/agent-runtime";
import { logger } from "./logger.js";
import { toPiMessages } from "./piConversationHistory.js";

export interface PiAgentSessionFactoryOptions {
  model: Model<Api>;
  streamFn: StreamFn;
  tools: AgentTool[];
  /** The default prompt a session's `systemPromptOverride` receives, and the one used without it. */
  systemPrompt: string;
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
 * Maps one pi-agent-core `AgentEvent` onto the runtime's `AgentMessage` vocabulary, or `null` for
 * an event the run log does not record: agent/message start markers, a tool's partial progress,
 * and every non-assistant `message_end` — the prompt is already `agent_runs.task`, and a tool
 * result message duplicates the `tool_result` its `tool_execution_end` produced.
 */
function toAgentMessage(event: AgentEvent): AgentMessage | null {
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
      return {
        kind: "message",
        role: message.role,
        text: assistantText(message),
        content: message.content,
        stopReason: message.stopReason,
        errorMessage: message.errorMessage,
      };
    }
    case "tool_execution_start":
      return { kind: "tool_use", toolCallId: event.toolCallId, name: event.toolName, arguments: event.args };
    case "tool_execution_end":
      return {
        kind: "tool_result",
        toolCallId: event.toolCallId,
        name: event.toolName,
        result: event.result,
        isError: event.isError,
      };
    default:
      return null;
  }
}

/**
 * pi reports a failed or aborted model call as a final assistant message rather than a rejected
 * `prompt()`; turn that into a thrown error so the caller closes the run as `error`.
 */
function assertModelSucceeded(agent: Agent): void {
  const last = agent.state.messages.at(-1);
  if (!isAssistantMessage(last)) return;
  if (last.stopReason === "error" || last.stopReason === "aborted") {
    throw new Error(last.errorMessage ?? `model call ended with stopReason '${last.stopReason}'`);
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
  toolFailure: { error: Error | undefined },
): AsyncGenerator<AgentMessage> {
  const queue: AgentMessage[] = [];
  let wake: (() => void) | null = null;
  let settled = false;
  const notify = (): void => {
    wake?.();
    wake = null;
  };

  const unsubscribe = agent.subscribe((event) => {
    const message = toAgentMessage(event);
    if (!message) return;
    queue.push(message);
    notify();
  });
  const prompt = agent.prompt(task).finally(() => {
    settled = true;
    notify();
  });

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
    unsubscribe();
    if (!settled) {
      agent.abort();
      try {
        await prompt;
      } catch (err) {
        // The consumer's own failure is what propagates; this one is only evidence.
        logger.error({ err }, "pi agent prompt failed after its consumer stopped reading");
      }
    }
  }

  if (toolFailure.error) throw toolFailure.error;
  assertModelSucceeded(agent);
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
      initialState: {
        systemPrompt: sessionOptions.systemPromptOverride?.(options.systemPrompt) ?? options.systemPrompt,
        model: options.model,
        tools,
        messages: initialMessages,
      },
    });

    // Each prompt starts with no recorded tool failure; only one runs at a time (pi refuses a
    // second `prompt()` while one is active).
    const prompt = (task: string): AsyncIterable<AgentMessage> => {
      toolFailure.error = undefined;
      return promptMessages(piAgent, task, toolFailure);
    };
    const session: AgentSession = {
      messages: () => prompt(sessionOptions.task),
      send: prompt,
    };
    return session;
  };
}
