import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  createRuntimeRolePool,
  createTenantZeroUser,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "@semprec/data/testSupport";
import {
  createAgentRun,
  createChokePoint,
  createSempChatThread,
  createViewTypeRegistry,
  getAgentRun,
  getDatabaseByModuleId,
  listAgentRunEvents,
  seedSystem,
  withTransaction,
  type ChokePoint,
  type DatabaseRow,
} from "@semprec/data";
import { runInTenant } from "@semprec/shared";
import type { CompactionAdapter } from "../compaction.js";
import { persistCompaction, reconstructConversationHistory } from "../conversationReconstruction.js";
import { runAgentSessionForRun, runAgentTurn, runAgentTurnWithStoredForm } from "../lifecycleAdapter.js";
import { logger } from "../logger.js";
import type { AgentMessage, ConversationEntry, ToolCallTarget } from "../types.js";

const SEEDING_TIMEOUT_MS = 120_000;
const MARKER = "[redacted: sensitive]";
const READ_VALUE = "Private diagnosis";
const WRITTEN_VALUE = "Written secret value";
const QUOTED_VALUE = "Quoted bedtime 23:15";
const ALL_VALUES = [READ_VALUE, WRITTEN_VALUE, QUOTED_VALUE];

let admin: Pool;
let runtime: Pool;
let chokePoint: ChokePoint;
let health: DatabaseRow;
let open: DatabaseRow;
let healthItemId: string;
let openItemId: string;

function inTenant<T>(fn: () => Promise<T>): Promise<T> {
  return runInTenant(getTenantZeroId(), fn);
}

const neverCompact: CompactionAdapter = {
  estimateContextTokens: (messages) => messages.length,
  shouldCompact: () => false,
  prepareCompaction: (entries) => entries,
  compact: () => {
    throw new Error("unexpected compaction");
  },
  contextWindow: 1_000_000,
  settings: {},
};

/** A compaction whose summary is the whole serialized history it was handed, so any value it saw would be in the checkpoint. */
function summarizingCompaction(seen: ConversationEntry[][]): CompactionAdapter {
  return {
    estimateContextTokens: (messages) => messages.length,
    shouldCompact: () => true,
    prepareCompaction: (entries) => {
      seen.push(entries);
      return entries;
    },
    compact: (prepared) => [
      {
        id: "summary",
        parentId: null,
        seq: 0,
        timestamp: 0,
        message: { kind: "message", role: "assistant", text: `summary ${JSON.stringify(prepared)}` },
      },
    ],
    contextWindow: 10,
    settings: {},
  };
}

function toolUse(
  toolCallId: string,
  operation: string,
  args: Record<string, unknown>,
  targets: Record<string, unknown> = {},
): AgentMessage {
  return {
    kind: "tool_use",
    toolCallId,
    name: operation.replace(".", "_"),
    operation,
    arguments: args,
    ...targets,
  };
}

function toolResult(
  toolCallId: string,
  operation: string,
  text: string,
  details: Record<string, unknown> = { error: false },
): AgentMessage {
  return {
    kind: "tool_result",
    toolCallId,
    name: operation.replace(".", "_"),
    operation,
    result: { content: [{ type: "text", text }], details },
    isError: false,
  };
}

function assistant(
  text: string,
  toolCalls: { id: string; name: string; args: Record<string, unknown> }[] = [],
  toolCallTargets: ToolCallTarget[] = [],
) {
  return {
    kind: "message",
    role: "assistant",
    text,
    content: [
      { type: "thinking", thinking: `thinking about ${text}` },
      { type: "text", text },
      ...toolCalls.map((call) => ({ type: "toolCall", id: call.id, name: call.name, arguments: call.args })),
    ],
    stopReason: toolCalls.length > 0 ? "toolUse" : "stop",
    ...(toolCallTargets.length > 0 ? { toolCallTargets } : {}),
  } satisfies AgentMessage;
}

/** Reads a health record: the tool marks the answer, so the stored result becomes the marker (issue #1827). */
function sensitiveRead(toolCallId: string): AgentMessage[] {
  return [
    toolUse(toolCallId, "item.get", { itemId: healthItemId }, { targetItemId: healthItemId }),
    toolResult(toolCallId, "item.get", JSON.stringify({ id: healthItemId, properties: { name: READ_VALUE } }), {
      error: false,
      sensitive: true,
    }),
  ];
}

describe("redaction of tool call arguments, assistant text and compaction checkpoints (issue #2001)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    await resetDatabase(admin);
    await seedSystem(admin, createViewTypeRegistry());
    await createTenantZeroUser(admin);
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    chokePoint = createChokePoint(runtime);
    await inTenant(async () => {
      const found = await withTransaction(runtime, (client) => getDatabaseByModuleId(client, "healthRecords"));
      if (!found) throw new Error("healthRecords was not seeded");
      health = found;
      open = await chokePoint.createDatabase({ name: "Open notes" });
      await chokePoint.createProperty({ databaseId: open.id, key: "name", name: "Name", type: "title" });
      healthItemId = (await chokePoint.createItem({ databaseId: health.id, properties: { name: READ_VALUE } })).id;
      openItemId = (await chokePoint.createItem({ databaseId: open.id, properties: { name: "Open note" } })).id;
    });
    expect([health.sensitive, open.sensitive]).toEqual([true, false]);
  }, SEEDING_TIMEOUT_MS);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end();
  });

  function spyLogs() {
    const error = vi.spyOn(logger, "error");
    return { error, quiet: [vi.spyOn(logger, "warn"), vi.spyOn(logger, "info"), vi.spyOn(logger, "debug")] };
  }

  async function newRun() {
    return inTenant(() =>
      withTransaction(runtime, async (client) => {
        const threadId = await createSempChatThread(client);
        const run = await createAgentRun(client, { threadId, triggeredBy: "user", unit: "session", task: "records" });
        return { threadId, runId: run.id };
      }),
    );
  }

  /** One `runAgentTurn` call on a run, as the application drives it; returns what the live consumer saw. */
  async function playTurn(runId: string, messages: AgentMessage[]) {
    const seen: AgentMessage[] = [];
    const last = await inTenant(() =>
      runAgentTurn(
        runtime,
        runId,
        (async function* () {
          yield* messages;
        })(),
        (message) => seen.push(message),
      ),
    );
    return { seen, last };
  }

  async function runTurn(messages: AgentMessage[]) {
    const fixture = await newRun();
    return { ...fixture, ...(await playTurn(fixture.runId, messages)) };
  }

  const stored = (runId: string, kind: string) =>
    inTenant(async () => (await listAgentRunEvents(runtime, runId)).filter((event) => event.kind === kind));

  const storedAll = (runId: string) => inTenant(async () => JSON.stringify(await listAgentRunEvents(runtime, runId)));

  const patchOf = (itemId: string, value = WRITTEN_VALUE) =>
    toolUse("call-patch", "item.patch", { itemId, properties: { name: value } }, { targetItemId: itemId });

  describe("tool call arguments", () => {
    it("stores an item.patch to a health record with the marker as arguments, keeps its identity and pairs it with its result", async () => {
      const { runId, seen } = await runTurn([
        patchOf(healthItemId),
        toolResult("call-patch", "item.patch", JSON.stringify({ id: healthItemId }), {
          error: false,
          sensitive: true,
          changes: [{ key: "name", before: READ_VALUE, after: WRITTEN_VALUE }],
        }),
      ]);
      const calls = await stored(runId, "tool_use");
      expect(calls.map((event) => event.payload)).toEqual([
        {
          kind: "tool_use",
          toolCallId: "call-patch",
          name: "item_patch",
          operation: "item.patch",
          targetItemId: healthItemId,
          arguments: MARKER,
        },
      ]);
      const results = await stored(runId, "tool_result");
      expect(results.map((event) => (event.payload as { toolCallId: string }).toolCallId)).toEqual(["call-patch"]);
      expect(await storedAll(runId)).not.toContain(WRITTEN_VALUE);
      expect(await storedAll(runId)).not.toContain(READ_VALUE);
      expect(seen[0]).toEqual(patchOf(healthItemId));
    });

    it("stores an item.create into a sensitive database with the marker as arguments", async () => {
      const { runId } = await runTurn([
        toolUse(
          "call-create",
          "item.create",
          { databaseId: health.id, properties: { name: WRITTEN_VALUE } },
          { targetDatabaseId: health.id },
        ),
        toolResult("call-create", "item.create", "{}", { error: true }),
      ]);
      const [call] = await stored(runId, "tool_use");
      expect(call?.payload).toMatchObject({ toolCallId: "call-create", operation: "item.create", arguments: MARKER });
      expect(await storedAll(runId)).not.toContain(WRITTEN_VALUE);
    });

    it.each([
      [
        "an item.patch to a non-sensitive item",
        toolUse(
          "call-open",
          "item.patch",
          { itemId: "OPEN_ITEM", properties: { name: "Open value" } },
          {
            targetItemId: "OPEN_ITEM",
          },
        ),
      ],
      [
        "an item.create into a non-sensitive database",
        toolUse(
          "call-open",
          "item.create",
          { databaseId: "OPEN_DB", properties: { name: "Open value" } },
          {
            targetDatabaseId: "OPEN_DB",
          },
        ),
      ],
    ])("stores %s in a turn without a sensitive read in full", async (_name, call) => {
      const withTargets = JSON.parse(
        JSON.stringify(call).replaceAll("OPEN_ITEM", openItemId).replaceAll("OPEN_DB", open.id),
      ) as AgentMessage;
      const { runId } = await runTurn([withTargets, toolResult("call-open", String(call.operation), "{}")]);
      const [stored1] = await stored(runId, "tool_use");
      expect(stored1?.payload).toEqual(withTargets);
    });

    it("stores a call that is not a content-bearing write in full, a read of a sensitive item before any marked result included", async () => {
      const { runId } = await runTurn([
        toolUse("call-read", "item.get", { itemId: healthItemId }, { targetItemId: healthItemId }),
        toolResult("call-read", "item.get", "{}", { error: false, sensitive: true }),
        { kind: "turn_start" },
      ]);
      const [call] = await stored(runId, "tool_use");
      expect(call?.payload).toMatchObject({ arguments: { itemId: healthItemId } });
    });

    it("stores the arguments of a write to a sensitive target as the marker whichever of its two targets is the sensitive one", async () => {
      const { runId } = await runTurn([
        toolUse(
          "call-mixed",
          "item.patch",
          { itemId: openItemId, databaseId: health.id, properties: { name: WRITTEN_VALUE } },
          { targetItemId: openItemId, targetDatabaseId: health.id },
        ),
        toolResult("call-mixed", "item.patch", "{}", { error: true }),
      ]);
      const [call] = await stored(runId, "tool_use");
      expect(call?.payload).toMatchObject({ arguments: MARKER });
    });

    it.each([
      ["an item that does not exist", { targetItemId: randomUUID() }],
      ["a database that does not exist", { targetDatabaseId: randomUUID() }],
      ["no target at all", {}],
    ])("stores the arguments of an item.patch naming %s as the marker", async (_name, targets) => {
      const { runId } = await runTurn([
        toolUse("call-unresolved", "item.patch", { properties: { name: WRITTEN_VALUE } }, targets),
        toolResult("call-unresolved", "item.patch", "{}", { error: true }),
      ]);
      const [call] = await stored(runId, "tool_use");
      expect(call?.payload).toMatchObject({ toolCallId: "call-unresolved", arguments: MARKER });
      expect(await storedAll(runId)).not.toContain(WRITTEN_VALUE);
    });

    it("stores the arguments as the marker when the flag cannot be read and logs the operation, the run and the error class only", async () => {
      const { error, quiet } = spyLogs();
      const { runId } = await runTurn([
        toolUse(
          "call-failing",
          "item.create",
          { databaseId: "not-a-uuid", properties: { name: WRITTEN_VALUE } },
          { targetDatabaseId: "not-a-uuid" },
        ),
        toolResult("call-failing", "item.create", "{}", { error: true }),
      ]);
      const [call] = await stored(runId, "tool_use");
      expect(call?.payload).toMatchObject({ arguments: MARKER });
      expect(error).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith(
        { operation: "item.create", agentRunId: runId, errorName: expect.any(String) },
        expect.stringContaining("treating it as sensitive"),
      );
      expect(JSON.stringify(error.mock.calls)).not.toContain(WRITTEN_VALUE);
      for (const log of quiet) expect(log).not.toHaveBeenCalled();
    });

    it("stores the arguments of a content-bearing write as the marker when the run handle is a pool client with no choke point to read the flag through, and a read in full", async () => {
      const { runId } = await newRun();
      await inTenant(() =>
        withTransaction(runtime, (client) =>
          runAgentTurn(
            client,
            runId,
            (async function* () {
              yield toolUse(
                "call-open",
                "item.patch",
                { itemId: openItemId, properties: { name: "Open value" } },
                { targetItemId: openItemId },
              );
              yield toolResult("call-open", "item.patch", "{}");
              yield toolUse("call-get", "item.get", { itemId: openItemId }, { targetItemId: openItemId });
              yield toolResult("call-get", "item.get", "{}");
            })(),
          ),
        ),
      );
      const calls = await stored(runId, "tool_use");
      expect(calls.map((event) => (event.payload as { arguments: unknown }).arguments)).toEqual([
        MARKER,
        { itemId: openItemId },
      ]);
    });

    it("stores the arguments of every call that follows a marked result in the turn as the marker, and pairs each with its result", async () => {
      const { runId } = await runTurn([
        toolUse("call-before", "item.get", { itemId: openItemId }, { targetItemId: openItemId }),
        toolResult("call-before", "item.get", "{}"),
        ...sensitiveRead("call-sensitive"),
        toolUse("call-after", "item.get", { itemId: openItemId, note: QUOTED_VALUE }, { targetItemId: openItemId }),
        toolResult("call-after", "item.get", JSON.stringify({ id: openItemId })),
      ]);
      const calls = (await stored(runId, "tool_use")).map((event) => event.payload as Record<string, unknown>);
      expect(calls.map((call) => [call.toolCallId, call.arguments])).toEqual([
        ["call-before", { itemId: openItemId }],
        ["call-sensitive", { itemId: healthItemId }],
        ["call-after", MARKER],
      ]);
      expect(calls[2]).toMatchObject({ name: "item_get", operation: "item.get", targetItemId: openItemId });
      const results = (await stored(runId, "tool_result")).map((event) => event.payload as Record<string, unknown>);
      expect(results.map((result) => result.toolCallId)).toEqual(["call-before", "call-sensitive", "call-after"]);
      expect(await storedAll(runId)).not.toContain(QUOTED_VALUE);
    });

    it("starts every call of runAgentTurn without a marked result, so a later turn of the same run stores its calls in full", async () => {
      const { runId } = await runTurn([...sensitiveRead("call-sensitive")]);
      await playTurn(runId, [
        toolUse("call-next", "item.get", { itemId: openItemId }, { targetItemId: openItemId }),
        toolResult("call-next", "item.get", "{}"),
      ]);
      const calls = (await stored(runId, "tool_use")).map((event) => event.payload as Record<string, unknown>);
      expect(calls.map((call) => call.arguments)).toEqual([{ itemId: healthItemId }, { itemId: openItemId }]);
    });

    describe("the assistant message that precedes a call", () => {
      const WRITE_BLOCK = (id: string, args: Record<string, unknown>) => ({ id, name: "item_patch", args });

      it("stores the toolCall block of the first sensitive write of a turn with the marker as arguments, before any result is marked", async () => {
        const args = { itemId: healthItemId, properties: { name: WRITTEN_VALUE } };
        const message = assistant(
          "",
          [WRITE_BLOCK("call-patch", args)],
          [{ toolCallId: "call-patch", operation: "item.patch", targetItemId: healthItemId }],
        );
        const { runId, seen } = await runTurn([
          { kind: "turn_start" },
          message,
          patchOf(healthItemId),
          toolResult("call-patch", "item.patch", JSON.stringify({ id: healthItemId }), {
            error: false,
            sensitive: true,
          }),
        ]);
        const [storedMessage] = await stored(runId, "message");
        expect(storedMessage?.payload).toEqual({
          kind: "message",
          role: "assistant",
          text: "",
          content: [
            { type: "thinking", thinking: "thinking about " },
            { type: "text", text: "" },
            { type: "toolCall", id: "call-patch", name: "item_patch", arguments: { redacted: MARKER } },
          ],
          stopReason: "toolUse",
        });
        expect(await storedAll(runId)).not.toContain(WRITTEN_VALUE);
        expect(seen).toContainEqual(message);
      });

      it("stores the toolCall block of an item.create into a sensitive database with the marker as arguments", async () => {
        const { runId } = await runTurn([
          assistant(
            "",
            [{ id: "call-create", name: "item_create", args: { databaseId: health.id, name: WRITTEN_VALUE } }],
            [{ toolCallId: "call-create", operation: "item.create", targetDatabaseId: health.id }],
          ),
        ]);
        const [storedMessage] = await stored(runId, "message");
        expect(JSON.stringify(storedMessage?.payload)).toContain(MARKER);
        expect(await storedAll(runId)).not.toContain(WRITTEN_VALUE);
      });

      it("redacts only the sensitive block of a message that holds a sensitive and a non-sensitive write", async () => {
        const openArgs = { itemId: openItemId, properties: { name: "Open value" } };
        const { runId } = await runTurn([
          assistant(
            "",
            [
              WRITE_BLOCK("call-health", { itemId: healthItemId, properties: { name: WRITTEN_VALUE } }),
              WRITE_BLOCK("call-open", openArgs),
            ],
            [
              { toolCallId: "call-health", operation: "item.patch", targetItemId: healthItemId },
              { toolCallId: "call-open", operation: "item.patch", targetItemId: openItemId },
            ],
          ),
        ]);
        const [storedMessage] = await stored(runId, "message");
        const blocks = (storedMessage?.payload as { content: { type: string; id?: string; arguments?: unknown }[] })
          .content;
        expect(blocks.filter((block) => block.type === "toolCall").map((block) => [block.id, block.arguments])).toEqual(
          [
            ["call-health", { redacted: MARKER }],
            ["call-open", openArgs],
          ],
        );
      });

      it("stores the block of a write with no resolvable target, and of any write on a pool client, as the marker", async () => {
        const unresolved = assistant(
          "",
          [WRITE_BLOCK("call-none", { properties: { name: WRITTEN_VALUE } })],
          [{ toolCallId: "call-none", operation: "item.patch" }],
        );
        const missing = assistant(
          "",
          [WRITE_BLOCK("call-missing", { itemId: "x", properties: { name: WRITTEN_VALUE } })],
          [{ toolCallId: "call-missing", operation: "item.patch", targetItemId: randomUUID() }],
        );
        const { runId } = await runTurn([unresolved, missing]);
        expect(await storedAll(runId)).not.toContain(WRITTEN_VALUE);

        const poolClientRun = await newRun();
        await inTenant(() =>
          withTransaction(runtime, (client) =>
            runAgentTurn(
              client,
              poolClientRun.runId,
              (async function* () {
                yield assistant(
                  "",
                  [WRITE_BLOCK("call-open", { itemId: openItemId, properties: { name: WRITTEN_VALUE } })],
                  [{ toolCallId: "call-open", operation: "item.patch", targetItemId: openItemId }],
                );
              })(),
            ),
          ),
        );
        expect(await storedAll(poolClientRun.runId)).not.toContain(WRITTEN_VALUE);
      });

      it("stores the block as the marker and logs the operation, the run and the error class only when the flag cannot be read", async () => {
        const { error } = spyLogs();
        const { runId } = await runTurn([
          assistant(
            "",
            [{ id: "call-bad", name: "item_create", args: { databaseId: "not-a-uuid", name: WRITTEN_VALUE } }],
            [{ toolCallId: "call-bad", operation: "item.create", targetDatabaseId: "not-a-uuid" }],
          ),
        ]);
        expect(await storedAll(runId)).not.toContain(WRITTEN_VALUE);
        expect(error).toHaveBeenCalledTimes(1);
        expect(error).toHaveBeenCalledWith(
          { operation: "item.create", agentRunId: runId, errorName: expect.any(String) },
          expect.stringContaining("treating it as sensitive"),
        );
        expect(JSON.stringify(error.mock.calls)).not.toContain(WRITTEN_VALUE);
      });

      it("stores the blocks of a non-sensitive write and of a read in full and never stores the steering targets", async () => {
        const openArgs = { itemId: openItemId, properties: { name: "Open value" } };
        const message = assistant(
          "",
          [WRITE_BLOCK("call-open", openArgs), { id: "call-read", name: "item_get", args: { itemId: healthItemId } }],
          [
            { toolCallId: "call-open", operation: "item.patch", targetItemId: openItemId },
            { toolCallId: "call-read", operation: "item.get", targetItemId: healthItemId },
          ],
        );
        const { runId } = await runTurn([message]);
        const { toolCallTargets: _steering, ...withoutTargets } = message;
        const [storedMessage] = await stored(runId, "message");
        expect(storedMessage?.payload).toEqual(withoutTargets);
        expect(JSON.stringify(storedMessage?.payload)).not.toContain("toolCallTargets");
      });

      it("stores a block of a message that carries no targets as it is, and ignores a malformed target entry", async () => {
        const plain = assistant("", [WRITE_BLOCK("call-a", { itemId: openItemId })]);
        const malformed: AgentMessage = {
          ...assistant("", [WRITE_BLOCK("call-b", { itemId: openItemId })]),
          toolCallTargets: [null, { toolCallId: 1, operation: "item.patch" }, "item.patch", { toolCallId: "call-b" }],
        };
        const { runId } = await runTurn([plain, malformed]);
        const { toolCallTargets: _ignored, ...malformedStored } = malformed;
        expect((await stored(runId, "message")).map((event) => event.payload)).toEqual([plain, malformedStored]);
      });
    });
  });

  describe("assistant text", () => {
    it("stores the reply that follows a sensitive read as the marker while the live reply and the returned message are unchanged", async () => {
      const reply = assistant(`Your record says ${READ_VALUE} and ${QUOTED_VALUE}`, [
        { id: "call-later", name: "item_get", args: { itemId: openItemId, note: QUOTED_VALUE } },
      ]);
      const { runId, seen, last } = await runTurn([
        { kind: "turn_start" },
        ...sensitiveRead("call-sensitive"),
        reply,
        { kind: "turn_end" },
      ]);
      const [message] = await stored(runId, "message");
      expect(message?.payload).toEqual({
        kind: "message",
        role: "assistant",
        text: MARKER,
        content: [
          { type: "text", text: MARKER },
          { type: "toolCall", id: "call-later", name: "item_get", arguments: { redacted: MARKER } },
        ],
        stopReason: "toolUse",
      });
      expect(await storedAll(runId)).not.toContain(QUOTED_VALUE);
      expect(seen).toContainEqual(reply);
      expect(last).toEqual(reply);
    });

    it("stores a reply that precedes the sensitive read of the same turn in full", async () => {
      const early = assistant("Let me look at your records");
      const { runId } = await runTurn([early, ...sensitiveRead("call-sensitive"), assistant(QUOTED_VALUE)]);
      const messages = (await stored(runId, "message")).map((event) => event.payload);
      expect(messages).toEqual([early, expect.objectContaining({ text: MARKER })]);
    });

    it("stores the reply of a turn that read no sensitive item, and its tool calls, in full", async () => {
      const reply = assistant(`The open note says ${QUOTED_VALUE}`, [
        { id: "call-open", name: "item_get", args: { itemId: openItemId } },
      ]);
      const call = toolUse("call-open", "item.get", { itemId: openItemId }, { targetItemId: openItemId });
      const { runId } = await runTurn([
        reply,
        call,
        toolResult("call-open", "item.get", JSON.stringify({ id: openItemId, properties: { name: QUOTED_VALUE } })),
        assistant(QUOTED_VALUE),
      ]);
      expect((await stored(runId, "message")).map((event) => (event.payload as { text: string }).text)).toEqual([
        reply.text,
        QUOTED_VALUE,
      ]);
      expect((await stored(runId, "tool_use"))[0]?.payload).toEqual(call);
    });

    it("keeps a reply of a later runAgentTurn call on the same run in full when that call read nothing sensitive", async () => {
      const { runId } = await runTurn([...sensitiveRead("call-sensitive"), assistant(READ_VALUE)]);
      await playTurn(runId, [assistant("A plain follow-up")]);
      const texts = (await stored(runId, "message")).map((event) => (event.payload as { text: string }).text);
      expect(texts).toEqual([MARKER, "A plain follow-up"]);
    });
  });

  describe("the result of the run row", () => {
    const quoting = (): AgentMessage[] => [
      { kind: "turn_start" },
      ...sensitiveRead("call-sensitive"),
      assistant(`Your record says ${READ_VALUE}, ${QUOTED_VALUE}`),
      { kind: "turn_end" },
    ];

    it("hands out the stored form of the last message next to the live one", async () => {
      const { runId } = await newRun();
      const outcome = await inTenant(() =>
        runAgentTurnWithStoredForm(
          runtime,
          runId,
          (async function* () {
            yield* quoting();
          })(),
        ),
      );
      expect(outcome.lastMessage).toMatchObject({ text: `Your record says ${READ_VALUE}, ${QUOTED_VALUE}` });
      expect(outcome.storedLastMessage).toMatchObject({ text: MARKER });
      expect(JSON.stringify(outcome.storedLastMessage)).not.toContain(READ_VALUE);
    });

    it("has no stored last message for a turn without a message", async () => {
      const { runId } = await newRun();
      const outcome = await inTenant(() =>
        runAgentTurnWithStoredForm(
          runtime,
          runId,
          (async function* () {
            yield { kind: "turn_start" } satisfies AgentMessage;
          })(),
        ),
      );
      expect(outcome).toEqual({ lastMessage: null, storedLastMessage: null });
    });

    async function closeRun(messages: AgentMessage[]) {
      const { runId } = await newRun();
      const seen: AgentMessage[] = [];
      const row = await inTenant(async () => {
        const run = await getAgentRun(runtime, runId);
        if (!run) throw new Error("run missing");
        return runAgentSessionForRun(runtime, run, {
          createAgentSession: () => ({
            async *messages() {
              yield* messages;
            },
          }),
          onEvent: (message) => seen.push(message),
        });
      });
      return { row, seen };
    }

    it("closes a run that read sensitive data with the marker as its result while the live reply is unchanged", async () => {
      const { row, seen } = await closeRun(quoting());
      expect(row.status).toBe("done");
      expect(row.result).toBe(MARKER);
      expect(seen).toContainEqual(expect.objectContaining({ text: `Your record says ${READ_VALUE}, ${QUOTED_VALUE}` }));
    });

    it("closes a run that read nothing sensitive with its last message in full", async () => {
      const { row } = await closeRun([{ kind: "turn_start" }, assistant(`The open note says ${QUOTED_VALUE}`)]);
      expect(row.result).toBe(`The open note says ${QUOTED_VALUE}`);
    });
  });

  describe("logs", () => {
    it("writes no log line while it redacts a sensitive turn", async () => {
      const { error, quiet } = spyLogs();
      await runTurn([
        patchOf(healthItemId),
        toolResult("call-patch", "item.patch", "{}", { error: false, sensitive: true }),
        assistant(READ_VALUE),
      ]);
      for (const log of [error, ...quiet]) expect(log).not.toHaveBeenCalled();
    });
  });

  describe("compaction and resume", () => {
    /** The turn of the issue: read a health record, write a value into it, quote it in the reply. */
    function sensitiveTurn(): AgentMessage[] {
      return [
        { kind: "user_message", text: "update my record", context: [] },
        { kind: "turn_start" },
        // The assistant message of a call is stored before the call starts, so its block still holds the arguments.
        assistant("", [{ id: "call-patch", name: "item_patch", args: { itemId: healthItemId, name: WRITTEN_VALUE } }]),
        patchOf(healthItemId),
        toolResult("call-patch", "item.patch", JSON.stringify({ id: healthItemId }), { error: false, sensitive: true }),
        ...sensitiveRead("call-read"),
        assistant(`Done, your record now says ${WRITTEN_VALUE}, was ${READ_VALUE}, at ${QUOTED_VALUE}`),
        { kind: "turn_end" },
      ];
    }

    it("builds a compaction of a sensitive turn from the redacted history, and the stored checkpoint holds no value", async () => {
      const { threadId, runId } = await runTurn(sensitiveTurn());
      const filter = { threadId, triggeredBy: "user", parentRunId: null } as const;
      const handedToCompaction: ConversationEntry[][] = [];
      const history = await inTenant(() =>
        reconstructConversationHistory(runtime, filter, summarizingCompaction(handedToCompaction)),
      );
      if (!history) throw new Error("expected a history");
      expect(history.compacted).toBe(true);
      expect(JSON.stringify(handedToCompaction)).not.toContain(WRITTEN_VALUE);
      for (const value of ALL_VALUES) expect(JSON.stringify(handedToCompaction)).not.toContain(value);
      expect(JSON.stringify(handedToCompaction)).toContain(MARKER);

      await inTenant(() => persistCompaction(runtime, runId, history.entries, filter));
      const [checkpoint] = await stored(runId, "compaction");
      expect(checkpoint).toBeDefined();
      for (const value of ALL_VALUES) expect(JSON.stringify(checkpoint?.payload)).not.toContain(value);
      expect(JSON.stringify(checkpoint?.payload)).toContain(MARKER);
    });

    it("resumes from the markers: the reconstructed history keeps every call paired with its result and holds no value", async () => {
      const { threadId } = await runTurn(sensitiveTurn());
      const history = await inTenant(() =>
        reconstructConversationHistory(runtime, { threadId, triggeredBy: "user", parentRunId: null }, neverCompact),
      );
      if (!history) throw new Error("expected a history");
      const messages = history.entries.map((entry) => entry.message);
      const callIds = messages.filter((m) => m.kind === "tool_use").map((m) => m.toolCallId);
      expect(callIds).toEqual(["call-patch", "call-read"]);
      expect(messages.filter((m) => m.kind === "tool_result").map((m) => m.toolCallId)).toEqual(callIds);
      const replayed = JSON.stringify(history.entries);
      for (const value of ALL_VALUES) expect(replayed).not.toContain(value);
      const assistants = messages.filter((m) => m.kind === "message");
      expect(assistants.map((m) => m.text)).toEqual(["", MARKER]);
      expect(assistants[0]?.content).toEqual([
        { type: "thinking", thinking: "thinking about " },
        { type: "text", text: "" },
        { type: "toolCall", id: "call-patch", name: "item_patch", arguments: { redacted: MARKER } },
      ]);
    });
  });
});
