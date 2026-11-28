import type { Pool, PoolClient } from "pg";
import { runAsSystem } from "@alldots/shared";
import { logger } from "./logger.js";

/** Cross-process tenant deactivation signal; payload `{"tenantId":"<uuid>"}`, built by Postgres. */
export const TENANT_STATUS_CHANNEL = "alldots_tenant_status";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Reconnect backoff base and cap. */
const RECONNECT_BASE_DELAY_MS = 200;
const RECONNECT_MAX_DELAY_MS = 5_000;

/** In the caller's transaction: Postgres delivers a NOTIFY only on commit, so no `runAfterCommit` is needed. */
export async function publishTenantDeactivated(client: PoolClient, tenantId: string): Promise<void> {
  await client.query("SELECT pg_notify($1, json_build_object('tenantId', $2::uuid)::text)", [
    TENANT_STATUS_CHANNEL,
    tenantId,
  ]);
}

export interface TenantDeactivationListener {
  /** Stops, releases the LISTEN client and waits for in-flight handlers; no handler starts afterwards. */
  close(): Promise<void>;
}

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

interface ListenNotification {
  channel: string;
  payload?: string;
}

/** A set-up client whose setup-time notifications are still buffered by `collect`. */
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
 * Calls `onDeactivated` for each tenant leaving `active`. NOTIFY is not persisted, so every (re)connect also
 * replays the tenants now `suspended`/`deleting`: handlers must be idempotent. Reconnects with backoff (200 ms
 * to 5 s); the initial connect is not retried.
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

    /** Exactly once, destroying the client so its LISTEN never returns to the pool. */
    function detach(): void {
      const current = client;
      if (!current) return;
      client = null;
      current.off("notification", onNotification);
      current.off("error", onError);
      current.release(true);
    }

    /** The failing query itself rejects `connect()`; this only logs. */
    const onSetupError = (err: unknown): void => {
      logger.error({ errorName: errorName(err) }, "Tenant deactivation LISTEN connection failed during setup");
    };

    /** `LISTEN` before the resync, with a collector buffering until `attach()`, so no deactivation is missed. */
    async function connect(): Promise<Connected> {
      const next = await pool.connect();
      // Before the first query: a checked-out client without an 'error' listener crashes the process on drop.
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

    /** Swaps setup listeners for live ones synchronously, so none is missed, then dispatches the resync and the buffer. */
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
