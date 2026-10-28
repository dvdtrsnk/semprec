import { describe, expect, it, vi } from "vitest";
import type { AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import { Type, fauxAssistantMessage, fauxProvider, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import type { AgentMessage, ToolEventMetadata } from "@semprec/agent-runtime";
import { toPiMessages } from "../piConversationHistory.js";
import { createPiAgentSessionFactory } from "../piAgentSession.js";

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

    await expect(collect(createSession({ task: "t" }).messages())).rejects.toThrow("gateway refused: budget");
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
