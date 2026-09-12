import type { Pool } from "pg";
import type { WebSocket } from "ws";
import {
  getAgentRun,
  getAgentRunEventById,
  getEarliestUserId,
  listAgentRunEventsAfter,
  type AgentRunEventRow,
} from "@semprec/data";
import type { AgentStreamMessage } from "./pgNotifyPublisher.js";
import type { AgentDeltaChunk, OutboundFrame } from "./protocolV1.js";

interface Watcher {
  ws: WebSocket;
  runId: string;
  lastEventId: string;
  replaying: boolean;
  queuedEventIds: Set<string>;
}

/**
 * Per-process `agent:watch` state. Durable events are registered before their cursor query,
 * queued while replay is in flight, then drained by event id so an event committed in that
 * handoff window cannot fall between replay and the live stream. Typing deltas intentionally do
 * not queue: their completed durable message event is the recovery copy.
 */
export interface AgentRunWatchRegistry {
  watch(ws: WebSocket, userId: string, runId: string, afterEventId: string): Promise<void>;
  unwatch(ws: WebSocket, runId: string): void;
  handleSocketClosed(ws: WebSocket): void;
  forwardEvent(runId: string, eventId: string): Promise<void>;
  forwardDelta(message: AgentStreamMessage): void;
}

function isLater(left: string, right: string): boolean {
  return BigInt(left) > BigInt(right);
}

function send(ws: WebSocket, frame: OutboundFrame): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
}

function eventFrame(event: AgentRunEventRow): OutboundFrame {
  return { type: "agent:event", agentRunId: event.agentRunId, event };
}

function deltaFrame(message: AgentStreamMessage): OutboundFrame {
  const chunk: AgentDeltaChunk | undefined = "chunk" in message ? message.chunk : undefined;
  return { type: "agent:delta", agentRunId: message.agentRunId, delta: message.delta, ...(chunk ? { chunk } : {}) };
}

export function createAgentRunWatchRegistry(pool: Pool): AgentRunWatchRegistry {
  const watchersByRun = new Map<string, Set<Watcher>>();
  const watchersBySocket = new WeakMap<WebSocket, Map<string, Watcher>>();
  // A watch awaits authorization before it can register. Keep only those in-flight intents so an
  // `agent:unwatch` (or a newer watch for the same run) cannot be overtaken by the older await.
  const pendingWatchesBySocket = new WeakMap<WebSocket, Map<string, symbol>>();

  function isCurrent(watcher: Watcher): boolean {
    return watchersBySocket.get(watcher.ws)?.get(watcher.runId) === watcher;
  }

  function add(watcher: Watcher): void {
    let watchers = watchersByRun.get(watcher.runId);
    if (!watchers) {
      watchers = new Set();
      watchersByRun.set(watcher.runId, watchers);
    }
    watchers.add(watcher);

    let byRun = watchersBySocket.get(watcher.ws);
    if (!byRun) {
      byRun = new Map();
      watchersBySocket.set(watcher.ws, byRun);
    }
    byRun.set(watcher.runId, watcher);
  }

  function remove(watcher: Watcher): void {
    const watchers = watchersByRun.get(watcher.runId);
    watchers?.delete(watcher);
    if (watchers?.size === 0) watchersByRun.delete(watcher.runId);
    const byRun = watchersBySocket.get(watcher.ws);
    if (byRun?.get(watcher.runId) === watcher) byRun.delete(watcher.runId);
  }

  function beginWatch(ws: WebSocket, runId: string): symbol {
    let pending = pendingWatchesBySocket.get(ws);
    if (!pending) {
      pending = new Map();
      pendingWatchesBySocket.set(ws, pending);
    }
    const token = Symbol(runId);
    pending.set(runId, token);
    return token;
  }

  function isPendingWatch(ws: WebSocket, runId: string, token: symbol): boolean {
    return pendingWatchesBySocket.get(ws)?.get(runId) === token;
  }

  function finishPendingWatch(ws: WebSocket, runId: string, token: symbol): void {
    const pending = pendingWatchesBySocket.get(ws);
    if (pending?.get(runId) === token) pending.delete(runId);
  }

  async function deliver(watcher: Watcher, event: AgentRunEventRow): Promise<void> {
    if (!isCurrent(watcher) || !isLater(event.id, watcher.lastEventId)) return;
    send(watcher.ws, eventFrame(event));
    watcher.lastEventId = event.id;
  }

  return {
    async watch(ws, userId, runId, afterEventId) {
      const pendingToken = beginWatch(ws, runId);
      const existing = watchersBySocket.get(ws)?.get(runId);
      if (existing) remove(existing);

      // Semprec's data model is explicitly single-tenant: agent_runs has no per-row user
      // column, so the setup account is the one authorized human owner (the same rule
      // background agent-run notifications use). A different authenticated user gets neither a
      // replay nor a live subscription, and an unknown run is indistinguishable from it.
      let ownerUserId: string | null;
      let run: Awaited<ReturnType<typeof getAgentRun>>;
      try {
        [ownerUserId, run] = await Promise.all([getEarliestUserId(pool), getAgentRun(pool, runId)]);
      } catch (err) {
        finishPendingWatch(ws, runId, pendingToken);
        throw err;
      }
      if (!isPendingWatch(ws, runId, pendingToken) || ownerUserId !== userId || !run || ws.readyState !== ws.OPEN) {
        finishPendingWatch(ws, runId, pendingToken);
        return;
      }
      finishPendingWatch(ws, runId, pendingToken);

      const watcher: Watcher = {
        ws,
        runId,
        lastEventId: afterEventId,
        replaying: true,
        queuedEventIds: new Set(),
      };
      // Register synchronously before awaiting the cursor query. Notifications received while it
      // runs are held in `queuedEventIds`, closing the replay/live handoff gap.
      add(watcher);

      try {
        const replay = await listAgentRunEventsAfter(pool, runId, afterEventId);
        if (!isCurrent(watcher)) return;
        for (const event of replay) await deliver(watcher, event);
        // Keep the watcher in replay mode until every reference collected during replay has
        // drained. A NOTIFY arriving while one queued row is being fetched is collected by the
        // next loop instead of bypassing an earlier id as an ordinary live delivery.
        while (watcher.queuedEventIds.size > 0) {
          const queued = [...watcher.queuedEventIds].sort((a, b) =>
            BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0,
          );
          watcher.queuedEventIds.clear();
          for (const eventId of queued) {
            if (!isCurrent(watcher) || !isLater(eventId, watcher.lastEventId)) continue;
            const event = await getAgentRunEventById(pool, runId, eventId);
            if (event) await deliver(watcher, event);
          }
        }
        watcher.replaying = false;
      } catch (err) {
        remove(watcher);
        throw err;
      }
    },

    unwatch(ws, runId) {
      pendingWatchesBySocket.get(ws)?.delete(runId);
      const watcher = watchersBySocket.get(ws)?.get(runId);
      if (watcher) remove(watcher);
    },

    handleSocketClosed(ws) {
      pendingWatchesBySocket.delete(ws);
      const watchers = watchersBySocket.get(ws);
      if (!watchers) return;
      for (const watcher of [...watchers.values()]) remove(watcher);
    },

    async forwardEvent(runId, eventId) {
      const watchers = watchersByRun.get(runId);
      if (!watchers || watchers.size === 0) return;

      for (const watcher of watchers) {
        if (watcher.replaying) watcher.queuedEventIds.add(eventId);
      }

      const liveWatchers = [...watchers].filter((watcher) => !watcher.replaying && isCurrent(watcher));
      if (liveWatchers.length === 0) return;
      // The reference must resolve to this exact run; a malformed/tampered NOTIFY cannot make a
      // watcher of another run receive a row merely because it guessed an event id.
      const event = await getAgentRunEventById(pool, runId, eventId);
      if (!event) return;
      for (const watcher of liveWatchers) await deliver(watcher, event);
    },

    forwardDelta(message) {
      const watchers = watchersByRun.get(message.agentRunId);
      if (!watchers) return;
      const frame = deltaFrame(message);
      for (const watcher of watchers) {
        // A watcher only arrives here after authorization and its replay is complete. Deltas are
        // deliberately not replayed, but they are never sent to a client that did not watch.
        if (!watcher.replaying && isCurrent(watcher)) send(watcher.ws, frame);
      }
    },
  };
}
