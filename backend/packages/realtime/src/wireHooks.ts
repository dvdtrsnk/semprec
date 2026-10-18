import type { Pool } from "pg";
import {
  setInvalidationHook,
  setDocUpdateHook,
  setAgentRunEventHook,
  setNotificationCreatedHook,
  setNotificationReadStateHook,
  setSessionRevokedHook,
} from "@semprec/data";
import { publishRealtimeMessage } from "./pgNotifyPublisher.js";
import { logger } from "./logger.js";

/**
 * Wires the data layer's in-process invalidation hooks (`realtimeHook.ts`) to real
 * Postgres NOTIFY publishing. Call once at process startup, in whichever process owns
 * the write path (the choke-point / doc store's pool) — a later issue may split reads
 * and writes across processes, at which point this call moves with the writer.
 */
export function wireRealtimeHooks(pool: Pool): void {
  const agentRunPublishTails = new Map<string, { promise: Promise<void> }>();

  function enqueueAgentRunEvent(event: { agentRunId: string; eventId: string }): void {
    const entry = { promise: Promise.resolve() };
    const preceding = agentRunPublishTails.get(event.agentRunId)?.promise ?? Promise.resolve();
    entry.promise = preceding
      .then(() => publishRealtimeMessage(pool, { type: "agent_run_event", ...event }))
      .catch((err: unknown) => {
        logger.error({ err }, "Failed to publish agent_run_event realtime message");
      })
      .then(() => {
        if (agentRunPublishTails.get(event.agentRunId) === entry) agentRunPublishTails.delete(event.agentRunId);
      });
    agentRunPublishTails.set(event.agentRunId, entry);
  }

  setInvalidationHook((event) => {
    // Best-effort fan-out: a failed NOTIFY must not fail (or roll back) the write that triggered it.
    publishRealtimeMessage(pool, { type: "invalidation", ...event }).catch((err: unknown) => {
      logger.error({ err }, "Failed to publish invalidation realtime message");
    });
  });
  setDocUpdateHook((event) => {
    publishRealtimeMessage(pool, { type: "doc_update", ...event }).catch((err: unknown) => {
      logger.error({ err }, "Failed to publish doc_update realtime message");
    });
  });
  setNotificationCreatedHook((event) => {
    publishRealtimeMessage(pool, { type: "notification_created", ...event }).catch((err: unknown) => {
      logger.error({ err }, "Failed to publish notification_created realtime message");
    });
  });
  setNotificationReadStateHook((event) => {
    publishRealtimeMessage(pool, { type: "notification_read_state", ...event }).catch((err: unknown) => {
      logger.error({ err }, "Failed to publish notification_read_state realtime message");
    });
  });
  setSessionRevokedHook((event) => {
    publishRealtimeMessage(pool, { type: "session_revoked", ...event }).catch((err: unknown) => {
      logger.error({ err }, "Failed to publish session_revoked realtime message");
    });
  });
  setAgentRunEventHook(enqueueAgentRunEvent);
}
