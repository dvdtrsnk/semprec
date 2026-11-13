import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Agent, type AgentEvent, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import {
  Type,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type AssistantMessage,
  type Context,
} from "@earendil-works/pi-ai";
import type { AgentMessage, ToolEventMetadata } from "@semprec/agent-runtime";
import { AiBudgetExceededError, agentRunErrorCodeOf } from "@semprec/data";
import { toPiMessages } from "../piConversationHistory.js";
import { createPiAgentSessionFactory } from "../piAgentSession.js";
import { logger } from "../logger.js";

function fauxModel() {
  const faux = fauxProvider();
  const streamFn: StreamFn = (model, context, options) => faux.provider.streamSimple(model, context, options);
  return { faux, model: faux.getModel(), streamFn };
}

function echoTool(calls: unknown[], fail?: Error): AgentTool {
  return {
    name: "echo",
    label: "echo",
    description: "Echoes its value.",
    parameters: Type.Object({ value: Type.String() }),
    execute: (_toolCallId, params) => {
      calls.push(params);
      if (fail) return Promise.reject(fail);
      return Promise.resolve({ content: [{ type: "text", text: "echoed" }], details: {} });
    },
  };
}

async function collect(messages: AsyncIterable<AgentMessage>): Promise<AgentMessage[]> {
  const collected: AgentMessage[] = [];
  for await (const message of messages) collected.push(message);
  return collected;
}

describe("createPiAgentSessionFactory (issue #647)", () => {
  it.each([
    ["module error", true, true, true],
    ["module success", true, false, false],
    ["other tool error", false, true, false],
  ])("keeps native and model result flags for %s", async (_label, module, returnedError, expectedError) => {
    const { faux, model, streamFn } = fauxModel();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("echo", { value: "hi" }, { id: "call-result" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("continued"),
    ]);
    const contexts: Context[] = [];
    const nativeEvents: AgentEvent[] = [];
    // Preserve the real subscription with its session receiver when observing SDK events.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const subscribe = Agent.prototype.subscribe;
    const subscription = vi.spyOn(Agent.prototype, "subscribe").mockImplementation(function (this: Agent, listener) {
      return subscribe.call(this, (event, signal) => {
        nativeEvents.push(event);
        return listener(event, signal);
      });
    });
    const observed: StreamFn = (m, context, options) => {
      contexts.push({ ...context, messages: structuredClone(context.messages) });
      return streamFn(m, context, options);
    };
    const tool: AgentTool = {
      ...echoTool([]),
      execute: async () => ({ content: [{ type: "text", text: "safe result" }], details: { error: returnedError } }),
    };
    const session = createPiAgentSessionFactory({
      model,
      streamFn: observed,
      tools: [tool],
      toolEventMetadata: new Map(),
      moduleToolNames: new Set(module ? ["echo"] : []),
      systemPrompt: "base",
    })({ task: "run" });
    let messages: AgentMessage[];
    try {
      messages = await collect(session.messages());
    } finally {
      subscription.mockRestore();
    }
    expect(messages.find((message) => message.kind === "tool_result")).toMatchObject({ isError: expectedError });
    expect(nativeEvents.find((event) => event.type === "tool_execution_end")).toMatchObject({
      isError: expectedError,
      result: { content: [{ type: "text", text: "safe result" }], details: { error: returnedError } },
    });
    const result = contexts.at(-1)?.messages.find((message) => message.role === "toolResult");
    expect(result).toMatchObject({ isError: expectedError, content: [{ type: "text", text: "safe result" }] });
    expect(messages).toContainEqual(expect.objectContaining({ kind: "message", text: "continued" }));
  });
  it("does not log prompt error content when the consumer stops reading", async () => {
    const { model, streamFn } = fauxModel();
    let listener: ((event: AgentEvent, signal: AbortSignal) => Promise<void> | void) | undefined;
    let rejectPrompt: ((error: Error) => void) | undefined;
    let markAborted: (() => void) | undefined;
    const aborted = new Promise<void>((resolve) => {
      markAborted = resolve;
    });
    const logs = vi.spyOn(logger, "error").mockImplementation(() => {});
    vi.spyOn(Agent.prototype, "subscribe").mockImplementation((callback) => {
      listener = callback;
      return () => {};
    });
    vi.spyOn(Agent.prototype, "prompt").mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectPrompt = reject;
        }),
    );
    vi.spyOn(Agent.prototype, "abort").mockImplementation(() => {
      markAborted?.();
    });
    try {
      const session = createPiAgentSessionFactory({
        model,
        streamFn,
        tools: [],
        toolEventMetadata: new Map(),
        systemPrompt: "base",
      })({ task: "message-sentinel" });
      const iterator = session.messages()[Symbol.asyncIterator]();
      expect((await iterator.next()).value).toMatchObject({ kind: "user_message" });
      const next = iterator.next();
      expect(listener).toBeDefined();
      await listener?.({ type: "turn_start" }, new AbortController().signal);
      expect((await next).value).toMatchObject({ kind: "turn_start" });
      const stopped = iterator.return?.();
      await aborted;
      rejectPrompt?.(new Error("message-sentinel-ref-sentinel"));
      await stopped;
      expect(logs).toHaveBeenCalledOnce();
      expect(logs).toHaveBeenCalledWith("pi agent prompt failed after its consumer stopped reading");
    } finally {
      vi.restoreAllMocks();
    }
  });
  it("maps a tool-calling reply onto paired tool_use/tool_result events inside ordered turns", async () => {
    const { faux, model, streamFn } = fauxModel();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("echo", { value: "hi" }, { id: "call-1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("all done"),
    ]);
    const calls: unknown[] = [];
    const createSession = createPiAgentSessionFactory({
      toolEventMetadata: new Map(),
      model,
      streamFn,
      tools: [echoTool(calls)],
      systemPrompt: "base",
    });

    const messages = await collect(createSession({ task: "echo hi" }).messages());
    const persisted = messages.filter((message) => message.kind !== "message_update");

    expect(persisted.map((message) => message.kind)).toEqual([
      "user_message",
      "turn_start",
      "message",
      "tool_use",
      "tool_result",
      "turn_end",
      "turn_start",
      "message",
      "turn_end",
    ]);
    const toolUse = persisted.find((message) => message.kind === "tool_use");
    const toolResult = persisted.find((message) => message.kind === "tool_result");
    expect(toolUse).toMatchObject({ toolCallId: "call-1", name: "echo", arguments: { value: "hi" } });
    expect(toolResult).toMatchObject({ toolCallId: "call-1", isError: false });
    expect(persisted.at(-2)).toMatchObject({ kind: "message", text: "all done" });
    expect(calls).toEqual([{ value: "hi" }]);
  });

  it("emits a user_message before the prompt for the wake turn and each follow-up, prepending system messages", async () => {
    const { faux, model, streamFn } = fauxModel();
    faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
    const seen: string[] = [];
    const wrapped: StreamFn = (m, context, options) => {
      seen.push(JSON.stringify(context.messages.at(-1)?.content));
      return streamFn(m, context, options);
    };
    const pending = [["approved: X"], []];
    const ref = { kind: "item" as const, itemId: randomUUID(), databaseId: randomUUID(), label: "Budget" };
    const session = createPiAgentSessionFactory({
      toolEventMetadata: new Map(),
      model,
      streamFn: wrapped,
      tools: [],
      systemPrompt: "base",
      pendingSystemMessages: () => pending.shift() ?? [],
    })({ task: "hello", context: [ref] });

    const first = await collect(session.messages());
    const second = await collect(session.send!("again"));

    expect(first[0]).toEqual({ kind: "user_message", text: "hello", context: [ref] });
    expect(second[0]).toEqual({ kind: "user_message", text: "again", context: [] });
    expect(seen[0]).toContain("approved: X");
    expect(seen[0]).toContain("hello");
    expect(seen[1]).toBe(JSON.stringify([{ type: "text", text: "again" }]));
  });

  it("passes ephemeral images on fresh and continuing prompts without persisting them", async () => {
    const { faux, model, streamFn } = fauxModel();
    model.input = ["text", "image"];
    faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
    const seen: Context[] = [];
    const wrapped: StreamFn = (m, context, options) => {
      seen.push(structuredClone(context));
      return streamFn(m, context, options);
    };
    const image = { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/jpeg" };
    const session = createPiAgentSessionFactory({
      toolEventMetadata: new Map(),
      model,
      streamFn: wrapped,
      tools: [],
      systemPrompt: "base",
    })({ task: "first", images: [image] });
    const first = await collect(session.messages());
    const second = await collect(session.send!("second", [], [image]));
    for (const context of seen) {
      expect(context.messages.at(-1)).toMatchObject({ role: "user", content: expect.arrayContaining([image]) });
    }
    expect(seen).toHaveLength(2);
    expect(JSON.stringify([first, second])).not.toContain(image.data);
    expect(first[0]).toEqual({ kind: "user_message", text: "first", context: [] });
    expect(second[0]).toEqual({ kind: "user_message", text: "second", context: [] });
  });

  it.each([
    ["unknown kind", { kind: "unknown", label: "x" }],
    ["invalid UUID", { kind: "item", itemId: "invalid", databaseId: randomUUID(), label: "x" }],
    ["invalid range", { kind: "transcriptSegment", itemId: randomUUID(), startsAt: 2, endsAt: 1, label: "x" }],
    ["invalid label", { kind: "block", itemId: randomUUID(), blockId: randomUUID(), label: 1 }],
    ["expanded field", { kind: "block", itemId: randomUUID(), blockId: randomUUID(), label: "x", text: "secret" }],
  ])("rejects %s before yielding or prompting", async (_name, invalid: unknown) => {
    const { model, streamFn } = fauxModel();
    const observed = vi.fn(streamFn);
    const session = createPiAgentSessionFactory({
      toolEventMetadata: new Map(),
      model,
      streamFn: observed,
      tools: [],
      systemPrompt: "base",
      // @ts-expect-error Exercise invalid input crossing the runtime boundary.
    })({ task: "secret task", context: [invalid] });
    const iterator = session.messages()[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow("Invalid user turn context");
    expect(observed).not.toHaveBeenCalled();
  });

  it("does not consume pending system messages for invalid context", async () => {
    const { faux, model, streamFn } = fauxModel();
    faux.setResponses([fauxAssistantMessage("ok")]);
    const seen: string[] = [];
    const observed: StreamFn = (m, context, options) => {
      seen.push(JSON.stringify(context.messages.at(-1)?.content));
      return streamFn(m, context, options);
    };
    const pending = vi.fn(() => ["pending outcome"]);
    const session = createPiAgentSessionFactory({
      toolEventMetadata: new Map(),
      model,
      streamFn: observed,
      tools: [],
      systemPrompt: "base",
      pendingSystemMessages: pending,
      // @ts-expect-error Exercise invalid input crossing the runtime boundary.
    })({ task: "invalid", context: null });
    await expect(collect(session.messages())).rejects.toThrow("Invalid user turn context");
    expect(pending).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
    await collect(session.send!("valid"));
    expect(pending).toHaveBeenCalledOnce();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("pending outcome");
    expect(seen[0]).toContain("valid");
  });

  it("aborts a blocked production tool directly while its async generator waits", async () => {
    const { faux, model, streamFn } = fauxModel();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("echo", { value: "hi" }, { id: "call-1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("must not run"),
    ]);
    let started!: () => void;
    const toolStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let toolAborted = false;
    const tool: AgentTool = {
      ...echoTool([]),
      execute: async (_id, _params, signal) => {
        if (!signal) throw new Error("tool requires a cancellation signal");
        await new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              toolAborted = true;
              resolve();
            },
            { once: true },
          );
          started();
        });
        return { content: [{ type: "text", text: "cancelled" }], details: {} };
      },
    };
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const session = createPiAgentSessionFactory({
      toolEventMetadata: new Map(),
      model,
      streamFn,
      tools: [tool],
      systemPrompt: "base",
    })({
      task: "t",
      signal: controller.signal,
    });
    const result = collect(session.messages()).then(
      () => null,
      (err: unknown) => err,
    );
    await toolStarted;
    controller.abort();
    expect(toolAborted).toBe(true);
    await result;
    expect(remove).toHaveBeenCalledExactlyOnceWith("abort", add.mock.calls[0]![1]);
    vi.restoreAllMocks();
  });

  it("starts no prompt when the session signal was already aborted", async () => {
    const { model, streamFn } = fauxModel();
    const stream = vi.fn(streamFn);
    const controller = new AbortController();
    controller.abort();
    const session = createPiAgentSessionFactory({
      toolEventMetadata: new Map(),
      model,
      streamFn: stream,
      tools: [],
      systemPrompt: "base",
    })({
      task: "t",
      signal: controller.signal,
    });
    await expect(collect(session.messages())).rejects.toThrow();
    expect(stream).not.toHaveBeenCalled();
  });

  it("applies systemPromptOverride to the base prompt", async () => {
    const { faux, model, streamFn } = fauxModel();
    const prompts: string[] = [];
    faux.setResponses([
      (context: Context) => {
        prompts.push(context.systemPrompt ?? "");
        return fauxAssistantMessage("ok");
      },
    ]);
    const createSession = createPiAgentSessionFactory({
      toolEventMetadata: new Map(),
      model,
      streamFn,
      tools: [],
      systemPrompt: "base",
    });

    await collect(createSession({ task: "t", systemPromptOverride: (prompt) => `${prompt}\nextra` }).messages());

    expect(prompts).toEqual(["base\nextra"]);
  });

  it("continues the same conversation on send", async () => {
    const { faux, model, streamFn } = fauxModel();
    const seenMessageCounts: number[] = [];
    faux.setResponses([
      (context: Context) => {
        seenMessageCounts.push(context.messages.length);
        return fauxAssistantMessage("first");
      },
      (context: Context) => {
        seenMessageCounts.push(context.messages.length);
        return fauxAssistantMessage("second");
      },
    ]);
    const session = createPiAgentSessionFactory({
      toolEventMetadata: new Map(),
      model,
      streamFn,
      tools: [],
      systemPrompt: "base",
    })({ task: "one" });

    await collect(session.messages());
    const followUp = await collect(session.send!("two"));

    expect(followUp.filter((message) => message.kind === "message")).toMatchObject([{ text: "second" }]);
    // user + assistant from the first turn, then the new user message.
    expect(seenMessageCounts).toEqual([1, 3]);
  });

  it("fails the session with the model's error when the model call fails", async () => {
    const { faux, model, streamFn } = fauxModel();
    faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "gateway refused: budget" })]);
    const createSession = createPiAgentSessionFactory({
      toolEventMetadata: new Map(),
      model,
      streamFn,
      tools: [],
      systemPrompt: "base",
    });

    const failure = await collect(createSession({ task: "t" }).messages()).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("gateway refused: budget");
    expect(agentRunErrorCodeOf(failure)).toBe("modelError");
  });

  it("fails the session with AiBudgetExceededError when the failed message is a budget refusal", async () => {
    const { faux, model, streamFn: fauxStreamFn } = fauxModel();
    faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "403: secret provider text" })]);
    // Marks the final message object of the call, as the gateway model does: it must still be the
    // object the agent keeps in its state.
    const refused = new WeakSet<AssistantMessage>();
    const streamFn: StreamFn = (m, context, options) => {
      const stream = fauxStreamFn(m, context, options);
      void Promise.resolve(stream).then((s) => s.result().then((message) => refused.add(message)));
      return stream;
    };
    const createSession = createPiAgentSessionFactory({
      toolEventMetadata: new Map(),
      model,
      streamFn,
      tools: [],
      systemPrompt: "base",
      isBudgetRefusal: (message) => refused.has(message),
    });

    const failure = await collect(createSession({ task: "t" }).messages()).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(AiBudgetExceededError);
    expect((failure as Error).message).toBe("AI budget exceeded");
    expect(agentRunErrorCodeOf(failure)).toBe("budgetExceeded");
  });

  it("keeps modelError when the detector does not recognize the failed message", async () => {
    const { faux, model, streamFn } = fauxModel();
    faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom" })]);
    const createSession = createPiAgentSessionFactory({
      toolEventMetadata: new Map(),
      model,
      streamFn,
      tools: [],
      systemPrompt: "base",
      isBudgetRefusal: () => false,
    });

    const failure = await collect(createSession({ task: "t" }).messages()).catch((err: unknown) => err);
    expect(agentRunErrorCodeOf(failure)).toBe("modelError");
  });

  it("fails the session with the tool's own error when a tool throws", async () => {
    const { faux, model, streamFn } = fauxModel();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("echo", { value: "hi" }, { id: "call-1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("should not be reached"),
    ]);
    const calls: unknown[] = [];
    const createSession = createPiAgentSessionFactory({
      toolEventMetadata: new Map(),
      model,
      streamFn,
      tools: [echoTool(calls, new Error("connection terminated"))],
      systemPrompt: "base",
    });

    await expect(collect(createSession({ task: "t" }).messages())).rejects.toThrow("connection terminated");
    expect(calls).toHaveLength(1);
  });

  it("resumes from reconstructed history passed as initialState.messages", async () => {
    const { faux, model, streamFn } = fauxModel();
    const seen: Context["messages"][] = [];
    faux.setResponses([
      (context: Context) => {
        seen.push(context.messages);
        return fauxAssistantMessage("resumed");
      },
    ]);
    const createSession = createPiAgentSessionFactory({
      toolEventMetadata: new Map(),
      model,
      streamFn,
      tools: [],
      systemPrompt: "base",
    });

    const messages = await collect(
      createSession({
        task: "next",
        initialState: {
          messages: [
            { id: "e1", parentId: null, seq: 0, timestamp: 1, message: { kind: "turn_start" } },
            {
              id: "e2",
              parentId: "e1",
              seq: 1,
              timestamp: 2,
              message: {
                kind: "message",
                role: "assistant",
                text: "earlier",
                content: [{ type: "text", text: "earlier" }],
                stopReason: "stop",
              },
            },
            { id: "e3", parentId: "e2", seq: 2, timestamp: 3, message: { kind: "turn_end" } },
          ],
        },
      }).messages(),
    );

    expect(messages.filter((message) => message.kind === "message")).toMatchObject([{ text: "resumed" }]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject([
      { role: "assistant", content: [{ type: "text", text: "earlier" }], stopReason: "stop" },
      { role: "user", content: [{ type: "text", text: "next" }] },
    ]);
  });

  it("refuses reconstructed history that does not convert to pi messages", () => {
    const { model, streamFn } = fauxModel();
    const createSession = createPiAgentSessionFactory({
      toolEventMetadata: new Map(),
      model,
      streamFn,
      tools: [],
      systemPrompt: "base",
    });

    expect(() =>
      createSession({
        task: "t",
        initialState: {
          messages: [{ id: "e1", parentId: null, seq: 0, timestamp: 0, message: { kind: "message", text: "x" } }],
        },
      }),
    ).toThrow("conversation entry e1 (kind 'message') is not an assistant message");
  });
});

describe("tool event metadata", () => {
  const mcp = {
    toolRegistrationId: "reg-1",
    serverItemId: "server-1",
    serverName: "Search server",
    toolName: "search",
  };

  it.each<{ name: string; metadata: ToolEventMetadata }>([
    { name: "item_patch", metadata: { operation: "item.patch" } },
    { name: "mcp_search", metadata: { mcp } },
  ])("enriches both $name events and preserves conversation reconstruction", async ({ name, metadata }) => {
    const { faux, model, streamFn } = fauxModel();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall(name, { itemId: "item-1", databaseId: "db-1" }, { id: "call-1" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("done"),
    ]);
    const tool: AgentTool = {
      ...echoTool([]),
      name,
      parameters: Type.Object({ itemId: Type.String(), databaseId: Type.String() }),
    };
    const session = createPiAgentSessionFactory({
      model,
      streamFn,
      tools: [tool],
      toolEventMetadata: new Map([[name, metadata]]),
      systemPrompt: "base",
    })({ task: "run" });
    const messages = await collect(session.messages());
    const events = messages.filter((message) => message.kind === "tool_use" || message.kind === "tool_result");
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event).toMatchObject({
        name,
        toolCallId: "call-1",
        ...metadata,
        targetItemId: "item-1",
        targetDatabaseId: "db-1",
      });
      expect(event).not.toHaveProperty("mcp" in metadata ? "operation" : "mcp");
      expect(Buffer.byteLength(JSON.stringify(event), "utf8")).toBeLessThan(1024 * 1024);
    }
    const reconstructed = toPiMessages(
      messages.map((message, seq) => ({
        id: `e${seq}`,
        parentId: seq ? `e${seq - 1}` : null,
        seq,
        timestamp: seq,
        message,
      })),
      model,
    );
    expect(reconstructed).toContainEqual(
      expect.objectContaining({ role: "toolResult", toolCallId: "call-1", toolName: name }),
    );
  });

  it("names the operation and targets of each generic-operation call on the assistant message that precedes it (issue #2001)", async () => {
    const { faux, model, streamFn } = fauxModel();
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("item_patch", { itemId: "item-1", value: "secret" }, { id: "call-patch" }),
          fauxToolCall("item_create", { databaseId: "db-1", value: "secret" }, { id: "call-create" }),
          fauxToolCall("item_patch", {}, { id: "call-bare" }),
          fauxToolCall("echo", { value: "hi", itemId: "item-2" }, { id: "call-other" }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("done"),
    ]);
    const anyTool = (name: string): AgentTool => ({
      ...echoTool([]),
      name,
      parameters: Type.Any(),
    });
    const session = createPiAgentSessionFactory({
      model,
      streamFn,
      tools: [anyTool("item_patch"), anyTool("item_create"), anyTool("echo")],
      toolEventMetadata: new Map<string, ToolEventMetadata>([
        ["item_patch", { operation: "item.patch" }],
        ["item_create", { operation: "item.create" }],
      ]),
      systemPrompt: "base",
    })({ task: "run" });
    const messages = await collect(session.messages());
    const [first, last] = messages.filter((message) => message.kind === "message");
    expect(first?.toolCallTargets).toEqual([
      { toolCallId: "call-patch", operation: "item.patch", targetItemId: "item-1" },
      { toolCallId: "call-create", operation: "item.create", targetDatabaseId: "db-1" },
      { toolCallId: "call-bare", operation: "item.patch" },
    ]);
    expect(last).not.toHaveProperty("toolCallTargets");
  });

  it("matches distinct target fields by call id and never derives ids from result text", async () => {
    const { faux, model, streamFn } = fauxModel();
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("echo", { itemId: "item-1" }, { id: "one" }),
          fauxToolCall("echo", { databaseId: "db-2" }, { id: "two" }),
          fauxToolCall("echo", {}, { id: "three" }),
          fauxToolCall("echo", { itemId: 42, databaseId: null }, { id: "four" }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("done"),
    ]);
    const tool: AgentTool = {
      ...echoTool([]),
      parameters: Type.Object({}, { additionalProperties: true }),
      execute: async () => ({
        content: [{ type: "text", text: '{"itemId":"fabricated","databaseId":"fabricated"}' }],
        details: {},
      }),
    };
    const messages = await collect(
      createPiAgentSessionFactory({
        model,
        streamFn,
        tools: [tool],
        toolEventMetadata: new Map([["echo", { operation: "item.patch" }]]),
        systemPrompt: "base",
      })({ task: "run" }).messages(),
    );
    const events = messages.filter((message) => message.kind === "tool_use" || message.kind === "tool_result");
    expect(events).toHaveLength(8);
    for (const kind of ["tool_use", "tool_result"]) {
      const targets = events
        .filter((event) => event.kind === kind)
        .map(({ toolCallId, targetItemId, targetDatabaseId }) => ({ toolCallId, targetItemId, targetDatabaseId }));
      expect(targets).toEqual([
        { toolCallId: "one", targetItemId: "item-1", targetDatabaseId: undefined },
        { toolCallId: "two", targetItemId: undefined, targetDatabaseId: "db-2" },
        { toolCallId: "three", targetItemId: undefined, targetDatabaseId: undefined },
        { toolCallId: "four", targetItemId: undefined, targetDatabaseId: undefined },
      ]);
      for (const event of events.filter(
        (event) => event.kind === kind && ["three", "four"].includes(String(event.toolCallId)),
      )) {
        expect(event).not.toHaveProperty("targetItemId");
        expect(event).not.toHaveProperty("targetDatabaseId");
      }
    }
  });

  it("keeps the exact legacy shape for a tool missing from the metadata map", async () => {
    const { faux, model, streamFn } = fauxModel();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("echo", { itemId: "item-1" }, { id: "call-1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    const tool = { ...echoTool([]), parameters: Type.Object({ itemId: Type.String() }) };
    const messages = await collect(
      createPiAgentSessionFactory({
        model,
        streamFn,
        tools: [tool],
        toolEventMetadata: new Map(),
        systemPrompt: "base",
      })({ task: "run" }).messages(),
    );
    expect(messages.find((message) => message.kind === "tool_use")).toEqual({
      kind: "tool_use",
      name: "echo",
      toolCallId: "call-1",
      arguments: { itemId: "item-1" },
    });
    expect(messages.find((message) => message.kind === "tool_result")).toEqual({
      kind: "tool_result",
      name: "echo",
      toolCallId: "call-1",
      result: { content: [{ type: "text", text: "echoed" }], details: {} },
      isError: false,
    });
  });
});
