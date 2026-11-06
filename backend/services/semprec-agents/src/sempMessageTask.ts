import type { Pool } from "pg";
import { z } from "zod";
import { SempConversation, type SempThread, type SempTurnStart } from "@semprec/agent-runtime";
import { currentTenantScope, labeledSempMessageRefSchema } from "@semprec/shared";
import {
  claimSempMessage, enqueueSempThreadTitleIfFirst, finishSempMessageTurn, getDatabaseByModuleId, getHeartbeatForProject,
  getSempMessageFrontier, getSempMessageToken, getSempMessageTurn, getSystemTimezone,
  listAgentRunEventsAfter, listAgentRunsByHeartbeat, publishSempThreadInvalidation,
  startSempMessageTurn, withTransaction, type AgentQueueTaskHandler,
} from "@semprec/data";
import type { ModuleRegistry } from "@semprec/module-registry";
import { createAgentSessionFactoryForRun } from "./agentSessionComposition.js";
import { withInFlightRegistration } from "./agentRunTasks.js";
import type { InFlightAgentRuns } from "./inFlightAgentRuns.js";
import type { GatewayModel } from "./modelComposition.js";
import { createSempHistoryReconstruction } from "./sempHistoryReconstruction.js";
import { logger } from "./logger.js";

const payloadSchema = z.object({ threadId: z.string().uuid(), assistantMessageId: z.string().uuid() });

export function createSempMessageTask(
  pool: Pool, registry: ModuleRegistry, gateway: GatewayModel, inFlight: InFlightAgentRuns,
): AgentQueueTaskHandler {
  const conversation = new SempConversation(pool, {
    resolveProjectItemId: () => withTransaction(pool, async (client) => {
      const inbox = await getDatabaseByModuleId(client, "inbox");
      if (!inbox?.ownerProjectItemId) throw new Error("Missing Semprec project");
      return inbox.ownerProjectItemId;
    }),
    createAgentSessionForRun: (run, current) => createAgentSessionFactoryForRun(pool, registry, gateway, run, current),
    reconstructHistory: createSempHistoryReconstruction(),
  });

  return (payload) => inFlight.trackSemp(() => withInFlightRegistration(pool, inFlight, async (signal) => {
    const { threadId, assistantMessageId } = payloadSchema.parse(payload);
    const scope = currentTenantScope();
    if (scope?.kind !== "tenant") throw new Error("Semp message task requires tenant scope");
    const claimed = await withTransaction(pool, async (client) => {
      if (!(await claimSempMessage(client, threadId, assistantMessageId))) return null;
      const turn = await getSempMessageTurn(client, threadId, assistantMessageId);
      const frontier = turn ? await getSempMessageFrontier(client, threadId, turn.sourceId, assistantMessageId) : null;
      return { turn, frontier };
    });
    if (!claimed) {
      logger.info({ threadId, assistantMessageId }, "Skipping Semp message that is not queued");
      return;
    }
    const turnState: { start?: SempTurnStart } = {};
    try {
      const turn = claimed.turn;
      if (!turn || turn.text === null) throw new Error("Semp source message is unavailable");
      const context = labeledSempMessageRefSchema.array().parse(turn.context);
      await conversation.ensureFresh(threadId, claimed.frontier);
      let thread: SempThread;
      if (turn.kind === "tick" && turn.projectItemId) thread = { kind: "tick", threadId, projectItemId: turn.projectItemId };
      else thread = { kind: turn.kind === "item" ? "item" : "chat", threadId };
      const prefix = await withTransaction(pool, async (client) => {
        const zone = await getSystemTimezone(client);
        const now = new Intl.DateTimeFormat("en-CA", { timeZone: zone, dateStyle: "full", timeStyle: "long" }).format(new Date());
        let tick = "";
        if (turn.kind === "tick" && turn.heartbeatId && turn.projectItemId) {
          const heartbeat = await getHeartbeatForProject(client, turn.projectItemId, turn.heartbeatId);
          if (heartbeat) {
            const runs = await listAgentRunsByHeartbeat(client, heartbeat.id, 5);
            const rule = JSON.stringify(heartbeat.rule);
            tick = `\nAutomation: ${JSON.stringify({ name: heartbeat.name.slice(0, 500), rule: rule.length <= 2000 ? heartbeat.rule : rule.slice(0, 2000), task: typeof heartbeat.actionConfig.task === "string" ? heartbeat.actionConfig.task.slice(0, 1000) : null, enabled: heartbeat.enabled, runs: runs.map((run) => ({ status: run.status, startedAt: run.startedAt, finishedAt: run.finishedAt, result: run.result?.slice(0, 500) ?? null })) })}`;
          }
        }
        return `Current date and time: ${now}; timezone: ${zone}.${tick}`;
      });
      const result = await conversation.send(turn.text, thread, {
        context, signal, modelPrefix: prefix, messageId: assistantMessageId,
        onTurnStart: async (value) => {
          turnState.start = value;
          await withTransaction(pool, (client) => startSempMessageTurn(client, assistantMessageId, value.agentRunId, value.firstEventId));
        },
      });
      const start = turnState.start;
      if (!result.ok || !start) throw new Error("Semp turn did not complete");
      const events = await listAgentRunEventsAfter(pool, start.agentRunId, start.firstEventId);
      const texts = events.flatMap((event) => {
        if (event.kind !== "message") return [];
        const value = z.object({ text: z.string() }).parse(event.payload);
        return [value.text];
      });
      const lastEventId = events.at(-1)?.id ?? start.firstEventId;
      const token = await withTransaction(pool, async (client) => {
        if (!(await finishSempMessageTurn(client, assistantMessageId, { status: "done", text: texts.join("\n"), lastEventId }))) {
          throw new Error("Semp message could not be completed");
        }
        await enqueueSempThreadTitleIfFirst(client, threadId, assistantMessageId);
        publishSempThreadInvalidation(client, scope.tenantId, threadId);
        return getSempMessageToken(client, assistantMessageId);
      });
      if (!token) throw new Error("Completed Semp message disappeared");
      conversation.markCompleted(threadId, token);
    } catch (error) {
      try {
        await withTransaction(pool, async (client) => {
          if (!(await finishSempMessageTurn(client, assistantMessageId, { status: "error", interrupted: signal.aborted && signal.reason === "shutdown" }))) {
            throw new Error("Semp message error state could not be stored");
          }
          publishSempThreadInvalidation(client, scope.tenantId, threadId);
        });
      } catch (persistenceError) {
        throw new AggregateError([error, persistenceError], "Semp turn and error persistence failed", { cause: error });
      }
      logger.warn({ threadId, assistantMessageId }, "Semp turn failed");
    }
  }, true));
}
