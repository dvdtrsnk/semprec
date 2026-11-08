import type { Pool, PoolClient } from "pg";
import { runAsSystem } from "@semprec/shared";
import { logger } from "./logger.js";

/**
 * The cross-process tenant deactivation signal
 * (docs/adr/2026-10-17-tenant-deactivation-tears-down-in-process-state.md). Its payload is the
 * JSON text `{"tenantId":"<uuid>"}`, built by Postgres.
 */
export const TENANT_STATUS_CHANNEL = "semprec_tenant_status";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Base and cap for the LISTEN-connection reconnect backoff. */
const RECONNECT_BASE_DELAY_MS = 200;
const RECONNECT_MAX_DELAY_MS = 5_000;

/**
 * Announces that `tenantId` left `active`, inside the caller's status-changing transaction. No
 * `runAfterCommit` is needed, unlike the realtime NOTIFYs: Postgres queues a NOTIFY issued inside a
 * transaction and delivers it only when that transaction commits, and discards it on rollback. A
 * listener therefore never sees the signal before the status change is visible, and a crash between
 * the commit and an after-commit callback cannot lose it.
 */
export async function publishTenantDeactivated(client: PoolClient, tenantId: string): Promise<void> {
  await client.query("SELECT pg_notify($1, json_build_object('tenantId', $2::uuid)::text)", [
    TENANT_STATUS_CHANNEL,
    tenantId,
  ]);
}

export interface TenantDeactivationListener {
  /** Stops listening, releases the LISTEN client and waits for in-flight handler calls; no handler call starts afterwards. */
  close(): Promise<void>;
}

/** Returns the tenant id of a `{ tenantId: <uuid> }` payload, or `null` for anything else. */
function parseDeactivationPayload(payload: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== "tenantId") return null;
  const { tenantId } = parsed as { tenantId: unknown };
  return typeof tenantId === "string" && UUID_PATTERN.test(tenantId) ? tenantId.toLowerCase() : null;
}

/** The fields of a `pg` notification this module reads. */
interface ListenNotification {
  channel: string;
  payload?: string;
}

/** A set-up client whose setup-time notifications are still held by `collect` in `buffered`. */
interface Connected {
  next: PoolClient;
  collect: (msg: ListenNotification) => void;
  buffered: ListenNotification[];
  deactivated: string[];
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

/**
 * Listens on `TENANT_STATUS_CHANNEL` over one dedicated client and calls `onDeactivated` for every
 * tenant that leaves `active`. NOTIFY is not persisted, so on the first connect and on every
 * reconnect the listener also reads the tenants currently `suspended` or `deleting` and calls
 * `onDeactivated` for each: consumers must treat a repeated call for the same tenant as a no-op.
 *
 * Runs in a system scope for its whole lifetime; `onDeactivated` is called in that system scope and
 * re-enters a tenant explicitly when it needs one. A handler rejection is logged and the listener
 * keeps running. A payload that is not `{ tenantId: <uuid> }` is logged and dropped. After a
 * connection error it reconnects with capped exponential backoff (200 ms to 5 s). The initial
 * connect is not retried: its failure rejects this function.
 */
export async function startTenantDeactivationListener(
  pool: Pool,
  onDeactivated: (tenantId: string) => Promise<void>,
): Promise<TenantDeactivationListener> {
  return runAsSystem("tenantDeactivationListener", async () => {
    let closed = false;
    let client: PoolClient | null = null;
    let reconnecting: Promise<void> | null = null;
    let cancelBackoff: (() => void) | null = null;
    const inFlight = new Set<Promise<void>>();

    function dispatch(tenantId: string): void {
      if (closed) return;
      const call = runAsSystem("tenantDeactivationListener", () => onDeactivated(tenantId))
        .catch((err: unknown) => {
          logger.error({ errorName: errorName(err), tenantId }, "Tenant deactivation handler failed");
        })
        .finally(() => {
          inFlight.delete(call);
        });
      inFlight.add(call);
    }

    const onNotification = (msg: ListenNotification): void => {
      if (msg.channel !== TENANT_STATUS_CHANNEL) return;
      const tenantId = msg.payload === undefined ? null : parseDeactivationPayload(msg.payload);
      if (!tenantId) {
        // Only the channel is logged: an invalid payload is arbitrary text.
        logger.warn({ channel: msg.channel }, "tenant_status_payload_invalid");
        return;
      }
      dispatch(tenantId);
    };

    const onError = (err: unknown): void => {
      logger.error({ errorName: errorName(err) }, "Tenant deactivation LISTEN connection failed");
      detach();
      if (!closed && !reconnecting) {
        reconnecting = reconnect().finally(() => {
          reconnecting = null;
        });
      }
    };

    /** Releases the current client exactly once, destroying it so its LISTEN never returns to the pool. */
    function detach(): void {
      const current = client;
      if (!current) return;
      client = null;
      current.off("notification", onNotification);
      current.off("error", onError);
      current.release(true);
    }

    /** Logs an error raised while a client is still being set up; the failing query rejects `connect()` itself. */
    const onSetupError = (err: unknown): void => {
      logger.error({ errorName: errorName(err) }, "Tenant deactivation LISTEN connection failed during setup");
    };

    /**
     * Opens a client, runs `LISTEN`, then reads the non-active tenants on that same client. The
     * resync runs after `LISTEN`, so a deactivation committed in between reaches the handler through
     * one path or the other. A notification that arrives before `attach()` (for example one whose
     * transaction committed after the resync took its snapshot) is buffered by a collector
     * registered before `LISTEN`, and `attach()` replays it. Every failure removes the collector and
     * releases the client before rethrowing.
     */
    async function connect(): Promise<Connected> {
      const next = await pool.connect();
      // Registered before the first query: a checked-out client with no 'error' listener crashes
      // the process when its connection drops.
      next.on("error", onSetupError);
      const buffered: ListenNotification[] = [];
      const collect = (msg: ListenNotification): void => {
        buffered.push(msg);
      };
      next.on("notification", collect);
      try {
        // LISTEN takes no bind parameters; the channel is this module's own constant identifier.
        await next.query(`LISTEN ${TENANT_STATUS_CHANNEL}`);
        const { rows } = await runAsSystem("tenantDeactivationResync", () =>
          next.query<{ id: string }>("SELECT id FROM tenants WHERE status IN ('suspended', 'deleting') ORDER BY id"),
        );
        return { next, collect, buffered, deactivated: rows.map((row) => row.id) };
      } catch (err) {
        next.off("notification", collect);
        next.off("error", onSetupError);
        next.release(true);
        throw err;
      }
    }

    /**
     * Swaps the setup listeners for the live ones in one synchronous step, so no notification falls
     * between them, then dispatches the resync's tenants and replays the buffered notifications.
     */
    function attach({ next, collect, buffered, deactivated }: Connected): void {
      next.off("notification", collect);
      next.off("error", onSetupError);
      if (closed) {
        // `close()` ran while this connect was in flight: release instead of attaching.
        next.release(true);
        return;
      }
      client = next;
      next.on("error", onError);
      next.on("notification", onNotification);
      for (const tenantId of deactivated) dispatch(tenantId);
      for (const msg of buffered) onNotification(msg);
    }

    function backoff(delayMs: number): Promise<void> {
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          cancelBackoff = null;
          resolve();
        }, delayMs);
        cancelBackoff = () => {
          clearTimeout(timer);
          cancelBackoff = null;
          resolve();
        };
      });
    }

    async function reconnect(): Promise<void> {
      let delay = RECONNECT_BASE_DELAY_MS;
      while (!closed) {
        let connected: Connected;
        try {
          connected = await connect();
        } catch (err) {
          logger.error({ errorName: errorName(err) }, "Tenant deactivation LISTEN reconnect failed");
          // `close()` ran while this connect was in flight; its cancelBackoff found no timer to cancel.
          if (closed) return;
          await backoff(delay);
          delay = Math.min(delay * 2, RECONNECT_MAX_DELAY_MS);
          continue;
        }
        attach(connected);
        return;
      }
    }

    attach(await connect());

    return {
      async close() {
        closed = true;
        detach();
        cancelBackoff?.();
        await reconnecting;
        await Promise.all([...inFlight]);
      },
    };
  });
}
