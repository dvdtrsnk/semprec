import { describe, expect, it } from "vitest";
import type { AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import { Type, fauxAssistantMessage, fauxProvider, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@semprec/agent-runtime";
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

  it("applies systemPromptOverride to the base prompt", async () => {
    const { faux, model, streamFn } = fauxModel();
    const prompts: string[] = [];
    faux.setResponses([
      (context: Context) => {
        prompts.push(context.systemPrompt ?? "");
        return fauxAssistantMessage("ok");
      },
    ]);
    const createSession = createPiAgentSessionFactory({ model, streamFn, tools: [], systemPrompt: "base" });

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
    const session = createPiAgentSessionFactory({ model, streamFn, tools: [], systemPrompt: "base" })({ task: "one" });

    await collect(session.messages());
    const followUp = await collect(session.send!("two"));

    expect(followUp.filter((message) => message.kind === "message")).toMatchObject([{ text: "second" }]);
    // user + assistant from the first turn, then the new user message.
    expect(seenMessageCounts).toEqual([1, 3]);
  });

  it("fails the session with the model's error when the model call fails", async () => {
    const { faux, model, streamFn } = fauxModel();
    faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "gateway refused: budget" })]);
    const createSession = createPiAgentSessionFactory({ model, streamFn, tools: [], systemPrompt: "base" });

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
    const createSession = createPiAgentSessionFactory({ model, streamFn, tools: [], systemPrompt: "base" });

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
    const createSession = createPiAgentSessionFactory({ model, streamFn, tools: [], systemPrompt: "base" });

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
