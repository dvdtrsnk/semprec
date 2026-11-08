import type { Pool } from "pg";
import type { WebSocket } from "ws";
import {
  getAgentRun,
  getAgentRunEventById,
  getSempVoiceDelivery,
  listAgentRunEventsAfter,
  type AgentRunEventRow,
} from "@semprec/data";
import { runInTenant } from "@semprec/shared";
import type { AgentStreamMessage } from "./pgNotifyPublisher.js";
import { isAgentRunEventId, isUuid, type AgentDeltaChunk, type OutboundFrame } from "./protocolV1.js";
import { sendWithBackpressure } from "./backpressure.js";
import { VoiceDeltaBufferError, VoiceRunDeltaBuffer } from "./voiceRunDeltaBuffer.js";

export type VoiceRunFrame = { type: "event"; event: AgentRunEventRow } | { type: "delta"; message: AgentStreamMessage };

export interface VoiceRunWatchInput {
  tenantId: string;
  userId: string;
  runId: string;
  threadId: string;
  sempMessageId: string;
  afterEventId: string;
  signal?: AbortSignal;
  onFrame(frame: VoiceRunFrame): boolean;
  onFailure(error: unknown, cause?: "overloaded" | "unavailable"): void;
}

interface VoiceWatcher {
  input: VoiceRunWatchInput;
  lastEventId: string;
  replaying: boolean;
  draining: boolean;
  queuedEventIds: Set<string>;
  staleAnchors: Set<string>;
  active: boolean;
  abort: () => void;
  live: VoiceRunDeltaBuffer;
  timer: ReturnType<typeof setTimeout> | undefined;
  drainPromise: Promise<void> | undefined;
  drainFailure: { error: unknown } | undefined;
}

const MAX_VOICE_PENDING_EVENTS = 256;

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
  subscribeVoice(input: VoiceRunWatchInput): Promise<() => Promise<void>>;
  closeTenant(tenantId: string): void;
  resetVoice(): void;
  close(): void;
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
  const voiceByRun = new Map<string, Set<VoiceWatcher>>();
  const tenantGenerations = new Map<string, number>();
  let voiceClosed = false;
  let voiceGeneration = 0;

  function removeVoice(watcher: VoiceWatcher): void {
    if (!watcher.active) return;
    watcher.active = false;
    watcher.input.signal?.removeEventListener("abort", watcher.abort);
    const watchers = voiceByRun.get(watcher.input.runId);
    watchers?.delete(watcher);
    if (watchers?.size === 0) voiceByRun.delete(watcher.input.runId);
    watcher.queuedEventIds.clear();
    watcher.staleAnchors.clear();
    if (watcher.timer) clearTimeout(watcher.timer);
    watcher.live.clear();
  }

  function failVoice(watcher: VoiceWatcher, error: unknown, cause?: "overloaded" | "unavailable"): void {
    if (!watcher.active) return;
    removeVoice(watcher);
    watcher.input.onFailure(error, cause);
  }

  function reportVoiceFailure(watcher: VoiceWatcher, error: unknown, cause?: "overloaded" | "unavailable"): void {
    try {
      failVoice(watcher, error, cause);
    } catch (callbackError) {
      watcher.drainFailure = {
        error: new AggregateError([error, callbackError], "Voice failure callback failed", { cause: error }),
      };
    }
  }

  function deliverVoice(watcher: VoiceWatcher, frame: VoiceRunFrame): void {
    if (!watcher.active) return;
    try {
      if (!watcher.input.onFrame(frame)) reportVoiceFailure(watcher, new Error("Voice run watch sink closed"));
    } catch (error) {
      reportVoiceFailure(watcher, error);
    }
  }

  function deliverVoiceEvent(watcher: VoiceWatcher, event: AgentRunEventRow): void {
    if (!watcher.active || !isLater(event.id, watcher.lastEventId)) return;
    const anchor = watcher.live.nextAnchor;
    if (anchor && isLater(anchor, watcher.lastEventId) && isLater(event.id, anchor))
      throw new Error("Voice delta anchor unavailable");
    deliverVoice(watcher, { type: "event", event });
    if (watcher.active) {
      watcher.lastEventId = event.id;
      watcher.live.advance(event.id);
    }
  }

  function releaseVoiceDeltas(watcher: VoiceWatcher): void {
    watcher.live.expire(performance.now());
    while (watcher.active && watcher.live.peek()?.afterEventId === watcher.lastEventId) {
      const message = watcher.live.shift();
      if (message) deliverVoice(watcher, { type: "delta", message });
    }
  }

  function scheduleVoice(watcher: VoiceWatcher): void {
    if (watcher.timer) clearTimeout(watcher.timer);
    watcher.timer = undefined;
    const deadline = watcher.live.deadline;
    if (!watcher.active || deadline === undefined) return;
    watcher.timer = setTimeout(
      () => {
        watcher.timer = undefined;
        watcher.live.expire(performance.now());
        if (!watcher.replaying) void startVoiceDrain(watcher);
        scheduleVoice(watcher);
      },
      Math.max(0, deadline - performance.now()),
    );
  }

  async function drainVoice(watcher: VoiceWatcher): Promise<void> {
    if (watcher.draining || watcher.replaying || !watcher.active) return;
    watcher.draining = true;
    try {
      while (watcher.active) {
        const staleAnchor = watcher.staleAnchors.values().next().value;
        if (staleAnchor !== undefined) {
          watcher.staleAnchors.delete(staleAnchor);
          const anchor = await runInTenant(watcher.input.tenantId, () =>
            getAgentRunEventById(pool, watcher.input.runId, staleAnchor, {
              threadId: watcher.input.threadId,
              sempMessageId: watcher.input.sempMessageId,
            }),
          );
          if (!watcher.active) return;
          if (!anchor) throw new Error("Voice delta anchor unavailable");
          continue;
        }
        releaseVoiceDeltas(watcher);
        for (const id of watcher.queuedEventIds)
          if (!isLater(id, watcher.lastEventId)) watcher.queuedEventIds.delete(id);
        const liveAnchor = watcher.live.nextAnchor;
        const candidates = [
          ...watcher.queuedEventIds,
          ...(liveAnchor && isLater(liveAnchor, watcher.lastEventId) ? [liveAnchor] : []),
        ];
        candidates.sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
        const target = candidates[0];
        if (!target) break;
        const rows = await runInTenant(watcher.input.tenantId, () =>
          listAgentRunEventsAfter(pool, watcher.input.runId, watcher.lastEventId, 257, {
            threadId: watcher.input.threadId,
            sempMessageId: watcher.input.sempMessageId,
            throughEventId: target,
          }),
        );
        if (!watcher.active) return;
        if (rows.length > 256) throw new VoiceDeltaBufferError("overloaded");
        for (const event of rows) {
          releaseVoiceDeltas(watcher);
          deliverVoiceEvent(watcher, event);
        }
        if (isLater(target, watcher.lastEventId)) {
          if (watcher.live.nextAnchor === target) throw new Error("Voice delta anchor unavailable");
          watcher.queuedEventIds.delete(target);
        }
      }
    } catch (error) {
      reportVoiceFailure(watcher, error, error instanceof VoiceDeltaBufferError ? error.causeCode : "unavailable");
    } finally {
      watcher.draining = false;
      scheduleVoice(watcher);
    }
  }

  function startVoiceDrain(watcher: VoiceWatcher): Promise<void> {
    if (watcher.drainPromise) return watcher.drainPromise;
    const task = drainVoice(watcher)
      .catch((error: unknown) => {
        watcher.drainFailure = { error };
        reportVoiceFailure(watcher, error, "unavailable");
      })
      .finally(() => {
        if (watcher.drainPromise === task) {
          watcher.drainPromise = undefined;
          if (
            watcher.active &&
            !watcher.replaying &&
            (watcher.queuedEventIds.size || watcher.staleAnchors.size || watcher.live.peek())
          )
            void startVoiceDrain(watcher);
        }
      });
    watcher.drainPromise = task;
    return task;
  }

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
    async subscribeVoice(input) {
      input.signal?.throwIfAborted();
      if (
        !isUuid(input.tenantId) ||
        !isUuid(input.userId) ||
        !isUuid(input.runId) ||
        !isUuid(input.threadId) ||
        !isUuid(input.sempMessageId) ||
        !isAgentRunEventId(input.afterEventId)
      )
        throw new Error("Voice run watch unavailable");
      if (voiceClosed) throw new Error("Voice run watch unavailable");
      const generation = tenantGenerations.get(input.tenantId) ?? 0;
      const connectionGeneration = voiceGeneration;
      const run = await runInTenant(input.tenantId, () => getAgentRun(pool, input.runId));
      const delivery = await runInTenant(input.tenantId, () =>
        getSempVoiceDelivery(pool, input.threadId, input.sempMessageId),
      );
      input.signal?.throwIfAborted();
      if (
        voiceClosed ||
        connectionGeneration !== voiceGeneration ||
        generation !== (tenantGenerations.get(input.tenantId) ?? 0)
      )
        throw new Error("Voice run watch unavailable");
      if (
        !run ||
        run.actorUserId !== input.userId ||
        !delivery ||
        delivery.runId !== input.runId ||
        !delivery.firstEventId ||
        (delivery.status !== "running" &&
          !((delivery.status === "done" || delivery.status === "error") && delivery.lastEventId))
      )
        throw new Error("Voice run watch unavailable");
      const watcher: VoiceWatcher = {
        input,
        lastEventId: input.afterEventId,
        replaying: true,
        draining: false,
        queuedEventIds: new Set(),
        staleAnchors: new Set(),
        active: true,
        abort: () => {},
        live: new VoiceRunDeltaBuffer(input.afterEventId),
        timer: undefined,
        drainPromise: undefined,
        drainFailure: undefined,
      };
      watcher.abort = () => removeVoice(watcher);
      input.signal?.addEventListener("abort", watcher.abort, { once: true });
      if (input.signal?.aborted) {
        removeVoice(watcher);
        input.signal.throwIfAborted();
      }
      let watchers = voiceByRun.get(input.runId);
      if (!watchers) {
        watchers = new Set();
        voiceByRun.set(input.runId, watchers);
      }
      watchers.add(watcher);
      try {
        if (input.afterEventId !== "0") {
          const cursor = await runInTenant(input.tenantId, () =>
            getAgentRunEventById(pool, input.runId, input.afterEventId, {
              threadId: input.threadId,
              sempMessageId: input.sempMessageId,
            }),
          );
          if (!watcher.active || !cursor) throw new Error("Voice run cursor unavailable");
        }
        const replay = await runInTenant(input.tenantId, () =>
          listAgentRunEventsAfter(pool, input.runId, input.afterEventId, 257, {
            threadId: input.threadId,
            sempMessageId: input.sempMessageId,
          }),
        );
        if (!watcher.active) {
          if (watcher.drainFailure) throw watcher.drainFailure.error;
          input.signal?.throwIfAborted();
          throw new Error("Voice run watch unavailable");
        }
        if (replay.length > 256) {
          const error = new VoiceDeltaBufferError("overloaded", "Voice run replay exceeds event limit");
          reportVoiceFailure(watcher, error, "overloaded");
          if (watcher.drainFailure) throw watcher.drainFailure.error;
          throw error;
        }
        for (const event of replay) {
          releaseVoiceDeltas(watcher);
          deliverVoiceEvent(watcher, event);
        }
        if (!watcher.active) {
          if (watcher.drainFailure) throw watcher.drainFailure.error;
          input.signal?.throwIfAborted();
          throw new Error("Voice run watch unavailable");
        }
        watcher.replaying = false;
        await startVoiceDrain(watcher);
        if (!watcher.active) {
          if (watcher.drainFailure) throw watcher.drainFailure.error;
          throw new Error("Voice run watch unavailable");
        }
        return async () => {
          removeVoice(watcher);
          await watcher.drainPromise;
          if (watcher.drainFailure) throw watcher.drainFailure.error;
        };
      } catch (error) {
        removeVoice(watcher);
        throw error;
      }
    },
    closeTenant(tenantId) {
      tenantGenerations.set(tenantId, (tenantGenerations.get(tenantId) ?? 0) + 1);
      for (const watchers of voiceByRun.values())
        for (const watcher of [...watchers])
          if (watcher.input.tenantId === tenantId) reportVoiceFailure(watcher, new Error("Voice tenant closed"));
    },
    resetVoice() {
      voiceGeneration++;
      for (const watchers of voiceByRun.values())
        for (const watcher of [...watchers]) reportVoiceFailure(watcher, new Error("Voice run watch unavailable"));
    },
    close() {
      voiceClosed = true;
      voiceGeneration++;
      for (const watchers of voiceByRun.values())
        for (const watcher of [...watchers]) reportVoiceFailure(watcher, new Error("Voice run watch unavailable"));
    },
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
      const watchers = watchersByRun.get(runId) ?? new Set<Watcher>();
      const voices = [...(voiceByRun.get(runId) ?? [])].filter(
        (watcher) => watcher.active && watcher.input.tenantId === tenantId,
      );
      for (const watcher of voices) {
        watcher.queuedEventIds.add(eventId);
        if (watcher.queuedEventIds.size > MAX_VOICE_PENDING_EVENTS)
          reportVoiceFailure(watcher, new Error("Voice run watch overflow"), "overloaded");
        else if (!watcher.replaying) void startVoiceDrain(watcher);
      }
      if (watchers.size === 0 && voices.length === 0) return;

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
      const voices = voiceByRun.get(message.agentRunId);
      if (voices)
        for (const watcher of voices)
          if (
            watcher.active &&
            watcher.input.tenantId === tenantId &&
            message.sempMessageId === watcher.input.sempMessageId &&
            message.afterEventId !== undefined &&
            message.deltaSequence !== undefined
          ) {
            try {
              if (isLater(watcher.lastEventId, message.afterEventId)) {
                watcher.staleAnchors.add(message.afterEventId);
                if (watcher.staleAnchors.size > MAX_VOICE_PENDING_EVENTS) throw new VoiceDeltaBufferError("overloaded");
                if (!watcher.replaying) void startVoiceDrain(watcher);
                continue;
              }
              watcher.live.admit(
                {
                  ...message,
                  sempMessageId: message.sempMessageId,
                  afterEventId: message.afterEventId,
                  deltaSequence: message.deltaSequence,
                },
                performance.now(),
              );
              scheduleVoice(watcher);
              if (!watcher.replaying) void startVoiceDrain(watcher);
            } catch (error) {
              reportVoiceFailure(
                watcher,
                error,
                error instanceof VoiceDeltaBufferError ? error.causeCode : "unavailable",
              );
            }
          }
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
