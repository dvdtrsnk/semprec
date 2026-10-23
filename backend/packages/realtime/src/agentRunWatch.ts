import type { Pool } from "pg";
import type { WebSocket } from "ws";
import { getAgentRun, getAgentRunEventById, listAgentRunEventsAfter, type AgentRunEventRow } from "@semprec/data";
import { runInTenant } from "@semprec/shared";
import type { AgentStreamMessage } from "./pgNotifyPublisher.js";
import type { AgentDeltaChunk, OutboundFrame } from "./protocolV1.js";
import { sendWithBackpressure } from "./backpressure.js";

interface Watcher {
  ws: WebSocket;
  tenantId: string;
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
  /** A socket of `tenantId` watches `runId`; authorization and replay resolve inside that tenant. */
  watch(ws: WebSocket, tenantId: string, userId: string, runId: string, afterEventId: string): Promise<void>;
  unwatch(ws: WebSocket, runId: string): void;
  handleSocketClosed(ws: WebSocket): void;
  /** Delivers one durable event reference from `tenantId`'s NOTIFY to that tenant's watchers of `runId` only. */
  forwardEvent(tenantId: string, runId: string, eventId: string): Promise<void>;
  /** Delivers an ephemeral delta from `tenantId`'s stream to that tenant's watchers of its run only. */
  forwardDelta(tenantId: string, message: AgentStreamMessage): void;
}

function isLater(left: string, right: string): boolean {
  return BigInt(left) > BigInt(right);
}

function send(ws: WebSocket, frame: OutboundFrame): void {
  sendWithBackpressure(ws, JSON.stringify(frame));
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
  // A replacement replays alongside the current watcher. It is not made active until replay has
  // succeeded, so a transient replay failure cannot silently drop an established subscription.
  const replacementsBySocket = new WeakMap<WebSocket, Map<string, Watcher>>();
  // A watch awaits authorization before it can register. Keep only those in-flight intents so an
  // `agent:unwatch` (or a newer watch for the same run) cannot be overtaken by the older await.
  const pendingWatchesBySocket = new WeakMap<WebSocket, Map<string, symbol>>();

  function isCurrent(watcher: Watcher): boolean {
    return (
      watchersBySocket.get(watcher.ws)?.get(watcher.runId) === watcher ||
      replacementsBySocket.get(watcher.ws)?.get(watcher.runId) === watcher
    );
  }

  function remove(watcher: Watcher): void {
    const watchers = watchersByRun.get(watcher.runId);
    watchers?.delete(watcher);
    if (watchers?.size === 0) watchersByRun.delete(watcher.runId);
    const byRun = watchersBySocket.get(watcher.ws);
    if (byRun?.get(watcher.runId) === watcher) byRun.delete(watcher.runId);
    const replacements = replacementsBySocket.get(watcher.ws);
    if (replacements?.get(watcher.runId) === watcher) replacements.delete(watcher.runId);
  }

  function addReplacement(watcher: Watcher): void {
    let replacements = replacementsBySocket.get(watcher.ws);
    if (!replacements) {
      replacements = new Map();
      replacementsBySocket.set(watcher.ws, replacements);
    }
    replacements.set(watcher.runId, watcher);
    let watchers = watchersByRun.get(watcher.runId);
    if (!watchers) {
      watchers = new Set();
      watchersByRun.set(watcher.runId, watchers);
    }
    watchers.add(watcher);
  }

  function promoteReplacement(watcher: Watcher): void {
    const existing = watchersBySocket.get(watcher.ws)?.get(watcher.runId);
    if (existing && existing !== watcher) remove(existing);
    let byRun = watchersBySocket.get(watcher.ws);
    if (!byRun) {
      byRun = new Map();
      watchersBySocket.set(watcher.ws, byRun);
    }
    byRun.set(watcher.runId, watcher);
    const replacements = replacementsBySocket.get(watcher.ws);
    if (replacements?.get(watcher.runId) === watcher) replacements.delete(watcher.runId);
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

  function deliver(watcher: Watcher, event: AgentRunEventRow): void {
    if (!isCurrent(watcher) || !isLater(event.id, watcher.lastEventId)) return;
    send(watcher.ws, eventFrame(event));
    watcher.lastEventId = event.id;
  }

  return {
    async watch(ws, tenantId, userId, runId, afterEventId) {
      const pendingToken = beginWatch(ws, runId);

      // agent_runs.actor_user_id is NOT NULL after migration 0042's cutover: every row carries the
      // user its writes are attributed to (the session user for a user-triggered root run, the
      // setup owner for heartbeat/system runs, the parent's actor for a delegated run). That
      // column is the authorized watcher, with no fallback. A different authenticated user gets
      // neither a replay nor a live subscription, and an unknown run is indistinguishable from it.
      let run: Awaited<ReturnType<typeof getAgentRun>>;
      try {
        // Resolved inside the socket's tenant: another tenant's run is invisible under RLS and takes
        // the same silent path as an unknown id.
        run = await runInTenant(tenantId, () => getAgentRun(pool, runId));
      } catch (err) {
        finishPendingWatch(ws, runId, pendingToken);
        throw err;
      }
      if (!isPendingWatch(ws, runId, pendingToken) || !run || run.actorUserId !== userId || ws.readyState !== ws.OPEN) {
        finishPendingWatch(ws, runId, pendingToken);
        return;
      }
      finishPendingWatch(ws, runId, pendingToken);

      // Keep an already-authorized watcher live until this replacement watch has replayed.
      // A transient database failure must not silently turn a valid subscription into an
      // unwatched socket.
      const formerReplacement = replacementsBySocket.get(ws)?.get(runId);
      if (formerReplacement) remove(formerReplacement);
      const watcher: Watcher = {
        ws,
        runId,
        tenantId,
        lastEventId: afterEventId,
        replaying: true,
        queuedEventIds: new Set(),
      };
      // Register synchronously before awaiting the cursor query. Notifications received while it
      // runs are held in `queuedEventIds`, closing the replay/live handoff gap.
      // Keep the old watcher active until this replay completes. The candidate is still in the
      // per-run set, so it records every NOTIFY that arrives during its replay window.
      addReplacement(watcher);

      try {
        const replay = await runInTenant(tenantId, () => listAgentRunEventsAfter(pool, runId, afterEventId));
        if (!isCurrent(watcher)) return;
        for (const event of replay) deliver(watcher, event);
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
            const event = await runInTenant(tenantId, () => getAgentRunEventById(pool, runId, eventId));
            if (event) deliver(watcher, event);
          }
        }
        if (!isCurrent(watcher)) return;
        // The existing watcher has been forwarding the same socket while this candidate replayed.
        // Its cursor is therefore the lower bound for future candidate delivery at promotion.
        const existing = watchersBySocket.get(ws)?.get(runId);
        if (existing && isLater(existing.lastEventId, watcher.lastEventId)) watcher.lastEventId = existing.lastEventId;
        watcher.replaying = false;
        promoteReplacement(watcher);
      } catch (err) {
        remove(watcher);
        throw err;
      }
    },

    unwatch(ws, runId) {
      pendingWatchesBySocket.get(ws)?.delete(runId);
      const watcher = watchersBySocket.get(ws)?.get(runId);
      if (watcher) remove(watcher);
      const replacement = replacementsBySocket.get(ws)?.get(runId);
      if (replacement) remove(replacement);
    },

    handleSocketClosed(ws) {
      pendingWatchesBySocket.delete(ws);
      const replacements = replacementsBySocket.get(ws);
      if (replacements) {
        for (const watcher of [...replacements.values()]) remove(watcher);
      }
      const watchers = watchersBySocket.get(ws);
      if (!watchers) return;
      for (const watcher of [...watchers.values()]) remove(watcher);
    },

    async forwardEvent(tenantId, runId, eventId) {
      const watchers = watchersByRun.get(runId);
      if (!watchers || watchers.size === 0) return;

      // Only the publisher's tenant's watchers may hold or receive this reference; a watcher of
      // another tenant that shares the run id is left alone.
      const tenantWatchers = [...watchers].filter((watcher) => watcher.tenantId === tenantId);
      for (const watcher of tenantWatchers) {
        if (watcher.replaying) watcher.queuedEventIds.add(eventId);
      }

      const liveWatchers = tenantWatchers.filter((watcher) => !watcher.replaying && isCurrent(watcher));
      if (liveWatchers.length === 0) return;
      // The reference must resolve to this exact run inside the tenant; a malformed/tampered NOTIFY
      // cannot make a watcher receive a row merely because it guessed an event id.
      const event = await runInTenant(tenantId, () => getAgentRunEventById(pool, runId, eventId));
      if (!event) return;
      for (const watcher of liveWatchers) deliver(watcher, event);
    },

    forwardDelta(tenantId, message) {
      const watchers = watchersByRun.get(message.agentRunId);
      if (!watchers) return;
      const frame = deltaFrame(message);
      for (const watcher of watchers) {
        // A watcher only arrives here after authorization and its replay is complete. Deltas are
        // deliberately not replayed, but they are never sent to a client that did not watch, nor
        // to a watcher of another tenant that happens to share the run id.
        if (watcher.tenantId === tenantId && !watcher.replaying && isCurrent(watcher)) send(watcher.ws, frame);
      }
    },
  };
}
