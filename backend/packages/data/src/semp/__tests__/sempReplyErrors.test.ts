import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runInTenant } from "@semprec/shared";
import { AGENT_RUN_ERROR_CODES, AgentRunError, AiBudgetExceededError } from "../../agentRuns/agentRunErrorCodes.js";
import { createUser } from "../../auth/usersStore.js";
import { withTransaction } from "../../db/pool.js";
import { listSempThreadMessages, sendSempMessage } from "../../sempThreads/sempThreadsStore.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { claimSempMessage, finishSempMessageTurn } from "../sempMessagesStore.js";
import { classifySempTurnFailure, renderSempReplyFailure } from "../sempReplyErrors.js";
import { buildSempReplySummary } from "../sempReplySummary.js";
import {
  assistantEvent,
  playTurn,
  turnEndEvent,
  turnStartEvent,
  userMessageEvent,
  type EventSpec,
  type PlayedTurn,
  type TurnSetup,
} from "./sempReplyTestSupport.js";

const SERVER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REGISTRATION = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const RAW_TOOL_TEXT = "RAW-TOOL-MESSAGE: calendar says meeting 'Salary review' could not be loaded";
const SIGNAL = { aborted: false, reason: undefined };

let setup: TurnSetup;
let czechTenant: string;
let englishTenant: string;
let foreignTenant: string;

const mcpIdentity = {
  toolRegistrationId: REGISTRATION,
  serverItemId: SERVER,
  serverName: "Calendar",
  toolName: "events",
};

/** A call of an MCP tool and its failed result, as `agentSessionComposition` stores them (issue #1444). */
function failedMcpCall(failure: Record<string, unknown>): EventSpec[] {
  return [
    {
      kind: "tool_use",
      atMs: 100,
      payload: {
        kind: "tool_use",
        toolCallId: "mcp-1",
        name: "mcp_events_aaaaaaaa",
        arguments: { query: "meeting" },
        mcp: mcpIdentity,
      },
    },
    {
      kind: "tool_result",
      atMs: 400,
      payload: {
        kind: "tool_result",
        toolCallId: "mcp-1",
        name: "mcp_events_aaaaaaaa",
        mcp: mcpIdentity,
        result: {
          content: [{ type: "text", text: RAW_TOOL_TEXT }],
          details: { error: true, ...failure, connectorName: "Calendar" },
        },
        isError: false,
      },
    },
  ];
}

const TIMEOUT = { failureKind: "timeout", mcpServerItemId: SERVER, timeoutMs: 60000 };

/** Plays a turn of `tenant` whose events are `toolEvents` and returns it, still running. */
function playIn(tenant: string, toolEvents: EventSpec[], finalText?: string): Promise<PlayedTurn> {
  return playTurn({ ...setup, tenant }, [
    userMessageEvent(),
    turnStartEvent(10),
    ...toolEvents,
    ...(finalText === undefined ? [] : [assistantEvent(finalText, 900)]),
    turnEndEvent(1000),
  ]);
}

/** Closes a played turn as the turn handler does after a failure: summary read first, then the classified error. */
async function failPlayedTurn(tenant: string, turn: PlayedTurn, error: unknown): Promise<void> {
  await runInTenant(tenant, () =>
    withTransaction(setup.runtime, async (client) => {
      const summary = await buildSempReplySummary(client, {
        messageId: turn.messageId,
        agentRunId: turn.runId,
        firstEventId: turn.eventIds[0] ?? "0",
        lastEventId: null,
      });
      const { errorCode, errorParams } = classifySempTurnFailure({ error, signal: SIGNAL, steps: summary.steps });
      expect(
        await finishSempMessageTurn(client, turn.messageId, { status: "error", errorCode, errorParams, summary }),
      ).toBe(true);
    }),
  );
}

function readMessages(tenant: string, threadId: string) {
  return runInTenant(tenant, () =>
    withTransaction(setup.runtime, (client) => listSempThreadMessages(client, threadId, 50, null)),
  );
}

async function readMessage(tenant: string, turn: PlayedTurn) {
  const row = (await readMessages(tenant, turn.threadId)).rows.find((candidate) => candidate.id === turn.messageId);
  if (!row) throw new Error("The message is missing from the list");
  return row;
}

interface StoredError {
  status: string;
  text: string | null;
  error_code: string | null;
  error_params: unknown;
  steps: unknown;
}

async function readStoredError(messageId: string): Promise<StoredError> {
  const { rows } = await setup.admin.query<StoredError>(
    "SELECT status, text, error_code, error_params, steps FROM semp_messages WHERE id = $1",
    [messageId],
  );
  const row = rows[0];
  if (!row) throw new Error("The message is missing");
  return row;
}

describe("why a Semp reply failed (issue #1907)", () => {
  beforeAll(async () => {
    const admin = getTestPool();
    await resetDatabase(admin);
    const runtime = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    czechTenant = await createTestTenant(admin);
    englishTenant = await createTestTenant(admin);
    foreignTenant = await createTestTenant(admin);
    for (const [tenantId, locale] of [
      [czechTenant, "cs"],
      [englishTenant, "en"],
      [foreignTenant, "en"],
    ] as const) {
      await createUser(admin, { tenantId, email: `${randomUUID()}@example.test`, passwordHash: "unused", locale });
    }
    setup = { admin, runtime, tenant: czechTenant };
  });

  afterAll(async () => {
    await setup?.runtime.end();
    await setup?.admin.end();
  });

  describe("the constraints of the migration", () => {
    it("are validated by a migration of their own, so that the scan does not run under the lock of the ALTER TABLE", async () => {
      const read = (file: string) =>
        readFile(fileURLToPath(new URL(`../../db/migrations/${file}`, import.meta.url)), "utf8");
      const statements = (sql: string) =>
        sql
          .split("\n")
          .filter((line) => !line.startsWith("--"))
          .join("\n");
      // Every migration runs in one transaction: a VALIDATE CONSTRAINT in the file of the ADD CONSTRAINT would hold
      // the ACCESS EXCLUSIVE lock of the ALTER TABLE through the scan.
      expect(statements(await read("0160_semp_messages_error.sql"))).not.toMatch(/VALIDATE\s+CONSTRAINT/i);
      const validation = statements(await read("0161_validate_semp_messages_error.sql"));
      expect(validation).toMatch(/VALIDATE\s+CONSTRAINT\s+semp_messages_error_code_check/i);
      expect(validation).toMatch(/VALIDATE\s+CONSTRAINT\s+semp_messages_error_params_check/i);
      const { rows } = await setup.admin.query<{ conname: string; convalidated: boolean }>(
        `SELECT conname, convalidated FROM pg_constraint
          WHERE conrelid = 'semp_messages'::regclass
            AND conname IN ('semp_messages_error_code_check', 'semp_messages_error_params_check')
          ORDER BY conname`,
      );
      expect(rows).toEqual([
        { conname: "semp_messages_error_code_check", convalidated: true },
        { conname: "semp_messages_error_params_check", convalidated: true },
      ]);
    });

    it("allow exactly the closed set of run error codes (generated from the exported constant)", async () => {
      const { rows } = await setup.admin.query<{ definition: string }>(
        `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
          WHERE conname = 'semp_messages_error_code_check' AND conrelid = 'semp_messages'::regclass`,
      );
      const literals = [...(rows[0]?.definition.matchAll(/'([A-Za-z]+)'::text/g) ?? [])].map((match) => match[1]);
      expect(literals.sort()).toEqual([...AGENT_RUN_ERROR_CODES].sort());
    });

    it("refuse an unknown code and a params value that is not an object, and accept every known code and NULL", async () => {
      const turn = await playIn(czechTenant, []);
      // A raw UPDATE: the writer is typed and cannot produce an unknown code, which is what the constraint is for.
      const update = (column: "error_code" | "error_params", value: string | null) =>
        runInTenant(czechTenant, () =>
          setup.runtime.query(`UPDATE semp_messages SET ${column} = $1 WHERE id = $2`, [value, turn.messageId]),
        );
      await expect(update("error_code", "notACode")).rejects.toMatchObject({ code: "23514" });
      await expect(update("error_params", '["a"]')).rejects.toMatchObject({ code: "23514" });
      for (const code of [...AGENT_RUN_ERROR_CODES, null]) await update("error_code", code);
      await update("error_params", '{"timeoutMs":1}');
      await update("error_params", null);
    });
  });

  describe("the writer", () => {
    it("stores the code, the params and the summary of a failed turn with its status in one statement", async () => {
      const turn = await playIn(czechTenant, failedMcpCall(TIMEOUT));
      await failPlayedTurn(czechTenant, turn, new AiBudgetExceededError());

      const stored = await readStoredError(turn.messageId);

      expect(stored).toMatchObject({
        status: "error",
        text: null,
        error_code: "budgetExceeded",
        error_params: {
          connectorName: "Calendar",
          timeoutMs: 60000,
          failedStep: { key: "agentStep.title.namedTool", params: { toolName: "events" } },
        },
      });
      expect(stored.steps).toEqual([expect.objectContaining({ status: "error", errorCode: "timeout" })]);
    });

    it("does not store the text of the error or of the failed tool anywhere on the message", async () => {
      const turn = await playIn(czechTenant, failedMcpCall(TIMEOUT));
      await failPlayedTurn(czechTenant, turn, new Error("RAW-EXCEPTION-TEXT with the meeting 'Salary review'"));

      const { rows } = await setup.admin.query<{ whole: string }>(
        "SELECT to_jsonb(m)::text AS whole FROM semp_messages m WHERE id = $1",
        [turn.messageId],
      );

      expect(rows[0]?.whole).toContain('"error_code": "internal"');
      expect(rows[0]?.whole).not.toContain("RAW-EXCEPTION-TEXT");
      expect(rows[0]?.whole).not.toContain("RAW-TOOL-MESSAGE");
      expect(rows[0]?.whole).not.toContain("Salary review");
    });

    it("stores empty params for a failure with no failed step, and no code or params for a done reply", async () => {
      const failed = await playIn(czechTenant, []);
      await failPlayedTurn(czechTenant, failed, new AgentRunError("modelError", "the model failed"));
      expect(await readStoredError(failed.messageId)).toMatchObject({
        status: "error",
        error_code: "modelError",
        error_params: {},
      });

      const done = await playIn(czechTenant, [], "All done.");
      await runInTenant(czechTenant, () =>
        withTransaction(setup.runtime, async (client) => {
          const lastEventId = done.eventIds.at(-1) ?? "0";
          expect(
            await finishSempMessageTurn(client, done.messageId, { status: "done", text: "All done.", lastEventId }),
          ).toBe(true);
        }),
      );
      expect(await readStoredError(done.messageId)).toMatchObject({
        status: "done",
        error_code: null,
        error_params: null,
      });
    });

    it("leaves the columns NULL for an error stored with no classification, and does not overwrite a finished message", async () => {
      const turn = await playIn(czechTenant, []);
      await runInTenant(czechTenant, () =>
        withTransaction(setup.runtime, async (client) => {
          expect(await finishSempMessageTurn(client, turn.messageId, { status: "error" })).toBe(true);
          expect(
            await finishSempMessageTurn(client, turn.messageId, {
              status: "error",
              errorCode: "cancelled",
              errorParams: { timeoutMs: 1 },
            }),
          ).toBe(false);
        }),
      );
      expect(await readStoredError(turn.messageId)).toMatchObject({
        status: "error",
        error_code: null,
        error_params: null,
      });
    });
  });

  describe("the message list", () => {
    it.each([
      { tenant: () => czechTenant, locale: "cs" },
      { tenant: () => englishTenant, locale: "en" },
    ])(
      "returns the error of a failed reply with its text in the user's language ($locale)",
      async ({ tenant, locale }) => {
        const turn = await playIn(tenant(), failedMcpCall(TIMEOUT));
        await failPlayedTurn(tenant(), turn, new AiBudgetExceededError());

        const row = await readMessage(tenant(), turn);

        expect(row.status).toBe("error");
        expect(row.error).toEqual({
          code: "budgetExceeded",
          message: await renderSempReplyFailure("budgetExceeded", {}, locale),
        });
        expect(row.error?.message).toBe(
          locale === "cs"
            ? "Odpověď se nepodařila, protože je vyčerpaný limit výdajů na AI."
            : "I could not answer because the AI spending limit is used up.",
        );
      },
    );

    it("holds no user content or tool text in the message, and no raw tool message anywhere in the response", async () => {
      const turn = await playIn(englishTenant, failedMcpCall(TIMEOUT));
      await failPlayedTurn(englishTenant, turn, new Error("RAW-EXCEPTION-TEXT"));

      const page = await readMessages(englishTenant, turn.threadId);
      const row = page.rows.find((candidate) => candidate.id === turn.messageId);

      expect(row?.error).toEqual({ code: "internal", message: "I could not answer because of an internal error." });
      const wire = JSON.stringify(page);
      expect(wire).not.toContain("RAW-EXCEPTION-TEXT");
      expect(wire).not.toContain("RAW-TOOL-MESSAGE");
      expect(wire).not.toContain("Salary review");
    });

    it("returns every code a reply can fail with, each with its own text, in one page", async () => {
      const threadId = await runInTenant(englishTenant, () =>
        withTransaction(setup.runtime, async (client) => {
          const first = await sendSempMessage(client, { text: "go", context: [], hasContext: false });
          return first.threadId;
        }),
      );
      const messageIds: string[] = [];
      for (const code of AGENT_RUN_ERROR_CODES) {
        const id = await runInTenant(englishTenant, () =>
          withTransaction(setup.runtime, async (client) => {
            const sent = await sendSempMessage(client, { threadId, text: code, context: [], hasContext: false });
            expect(await claimSempMessage(client, threadId, sent.assistantMessageId)).toBe(true);
            expect(
              await finishSempMessageTurn(client, sent.assistantMessageId, { status: "error", errorCode: code }),
            ).toBe(true);
            return sent.assistantMessageId;
          }),
        );
        messageIds.push(id);
      }

      const page = await readMessages(englishTenant, threadId);
      const errors = messageIds.map((id) => page.rows.find((row) => row.id === id)?.error);

      expect(errors.map((error) => error?.code)).toEqual([...AGENT_RUN_ERROR_CODES]);
      expect(new Set(errors.map((error) => error?.message)).size).toBe(AGENT_RUN_ERROR_CODES.length);
    });

    it("reads a failed reply that stored no code as internal and gives a reply that did not fail no error", async () => {
      const failed = await playIn(englishTenant, []);
      await runInTenant(englishTenant, () =>
        withTransaction(setup.runtime, async (client) => {
          await finishSempMessageTurn(client, failed.messageId, { status: "error" });
        }),
      );
      const page = await readMessages(englishTenant, failed.threadId);

      expect(page.rows.find((row) => row.id === failed.messageId)?.error?.code).toBe("internal");
      const user = page.rows.find((row) => row.role === "user");
      expect(user).toBeDefined();
      expect(user).not.toHaveProperty("error");
    });

    it("fails the read of a message whose stored params are malformed, rather than rendering a guess", async () => {
      const turn = await playIn(englishTenant, []);
      await runInTenant(englishTenant, () =>
        withTransaction(setup.runtime, async (client) => {
          await finishSempMessageTurn(client, turn.messageId, { status: "error", errorCode: "internal" });
        }),
      );
      // The writer is typed and cannot store this; a raw UPDATE puts a value in the column that a bad writer could.
      await setup.admin.query("UPDATE semp_messages SET error_params = $2::jsonb WHERE id = $1", [
        turn.messageId,
        '{"message":"raw text"}',
      ]);

      await expect(readMessages(englishTenant, turn.threadId)).rejects.toThrow(
        "Malformed semp_messages.error_params in database row",
      );
    });

    it("does not show another tenant's failed reply", async () => {
      const turn = await playIn(englishTenant, failedMcpCall(TIMEOUT));
      await failPlayedTurn(englishTenant, turn, new AiBudgetExceededError());

      expect((await readMessages(foreignTenant, turn.threadId)).rows).toEqual([]);
    });
  });

  describe("a reply that finished after a tool failure", () => {
    it("is done, reads incomplete with the timeout reason, and shows the answer and no raw tool message", async () => {
      const turn = await playIn(czechTenant, failedMcpCall(TIMEOUT), "I could not load the meeting record.");
      await runInTenant(czechTenant, () =>
        withTransaction(setup.runtime, async (client) => {
          const lastEventId = turn.eventIds.at(-1) ?? "0";
          const summary = await buildSempReplySummary(client, {
            messageId: turn.messageId,
            agentRunId: turn.runId,
            firstEventId: turn.eventIds[0] ?? lastEventId,
            lastEventId,
          });
          await finishSempMessageTurn(client, turn.messageId, {
            status: "done",
            text: "I could not load the meeting record.",
            lastEventId,
            summary,
          });
        }),
      );

      const page = await readMessages(czechTenant, turn.threadId);
      const row = page.rows.find((candidate) => candidate.id === turn.messageId);

      expect(row).toMatchObject({
        status: "done",
        text: "I could not load the meeting record.",
        outcome: "incomplete",
        incompleteReason: "toolTimeout",
        timeoutMs: 60000,
        mcpServerItemId: SERVER,
      });
      expect(row).not.toHaveProperty("error");
      // The failed step carries the failure kind the MCP layer reported (stored as the step's errorCode).
      expect(row?.steps).toEqual([expect.objectContaining({ status: "error", errorCode: "timeout" })]);
      expect(JSON.stringify(page)).not.toContain("RAW-TOOL-MESSAGE");
    });
  });
});
