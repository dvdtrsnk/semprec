import type { Pool } from "pg";
import { setInvalidationHook, setDocUpdateHook } from "@semprec/data";
import { publishRealtimeMessage } from "./pgNotifyPublisher.js";

/**
 * Wires the data layer's in-process invalidation hooks (`realtimeHook.ts`) to real
 * Postgres NOTIFY publishing. Call once at process startup, in whichever process owns
 * the write path (the choke-point / doc store's pool) — a later issue may split reads
 * and writes across processes, at which point this call moves with the writer.
 */
export function wireRealtimeHooks(pool: Pool): void {
  setInvalidationHook((event) => {
    // Best-effort fan-out: a failed NOTIFY must not fail (or roll back) the write that triggered it.
    publishRealtimeMessage(pool, { type: "item_invalidation", ...event }).catch((err: unknown) => {
      console.error("Failed to publish item_invalidation realtime message", err);
    });
  });
  setDocUpdateHook((event) => {
    publishRealtimeMessage(pool, { type: "doc_update", ...event }).catch((err: unknown) => {
      console.error("Failed to publish doc_update realtime message", err);
    });
  });
}
