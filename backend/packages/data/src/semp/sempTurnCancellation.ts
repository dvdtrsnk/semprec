import type { Pool, PoolClient } from "pg";
import { runAsSystem } from "@alldots/shared";
import { logger } from "./logger.js";

/**
 * Cross-process request to cancel one running Semp turn; payload
 * `{"tenantId":"<uuid>","assistantMessageId":"<uuid>"}`, built by Postgres.
 */
export const SEMP_TURN_CANCEL_CHANNEL = "semp_turn_cancel";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Base and cap for the LISTEN-connection reconnect backoff. */
const RECONNECT_BASE_DELAY_MS = 200;
const RECONNECT_MAX_DELAY_MS = 5_000;

export interface SempTurnCancelRequest {
  tenantId: string;
  assistantMessageId: string;
}

/**
 * Asks the process running the turn to cancel it via a Postgres notification: no answer, nothing recorded.
 * Inside a transaction it is delivered on commit.
 */
export async function requestSempTurnCancel(client: Pool | PoolClient, request: SempTurnCancelRequest): Promise<void> {
  await client.query(
    "SELECT pg_notify($1, json_build_object('tenantId', $2::uuid, 'assistantMessageId', $3::uuid)::text)",
    [SEMP_TURN_CANCEL_CHANNEL, request.tenantId, request.assistantMessageId],
  );
}

/** Oldest first, in the current tenant scope. */
export async function listRunningSempTurnIds(client: Pool | PoolClient, threadId: string): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(
    "SELECT id FROM semp_messages WHERE thread_id = $1 AND role = 'assistant' AND status = 'running' ORDER BY created_at, id",
    [threadId],
  );
  return rows.map((row) => row.id);
}

function parseCancelPayload(payload: string): SempTurnCancelRequest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const keys = Object.keys(parsed).sort();
  if (keys.length !== 2 || keys[0] !== "assistantMessageId" || keys[1] !== "tenantId") return null;
  const tenantId = "tenantId" in parsed ? parsed.tenantId : undefined;
  const assistantMessageId = "assistantMessageId" in parsed ? parsed.assistantMessageId : undefined;
  if (typeof tenantId !== "string" || !UUID_PATTERN.test(tenantId)) return null;
  if (typeof assistantMessageId !== "string" || !UUID_PATTERN.test(assistantMessageId)) return null;
  return { tenantId: tenantId.toLowerCase(), assistantMessageId: assistantMessageId.toLowerCase() };
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

export interface SempTurnCancelListener {
  /** Stops listening and releases the LISTEN client; the handler is not called afterwards. */
  close(): Promise<void>;
}

/**
 * Calls the synchronous `onCancel` for every well-formed request on one dedicated client. Requests are not
 * persisted: one sent while reconnecting, or for a turn this process does not run, is lost, and the user can
 * repeat the command. Invalid payloads and throwing handlers are logged and do not stop the listener. Connection
 * errors reconnect with capped exponential backoff; the initial connect is not retried.
 */
export async function startSempTurnCancelListener(
  pool: Pool,
  onCancel: (request: SempTurnCancelRequest) => void,
): Promise<SempTurnCancelListener> {
  return runAsSystem("sempTurnCancelListener", async () => {
    let closed = false;
    let active: { client: PoolClient; onError: (err: unknown) => void } | null = null;
    let reconnecting: Promise<void> | null = null;
    let cancelBackoff: (() => void) | null = null;

    const onNotification = (msg: { payload?: string }): void => {
      const request = parseCancelPayload(msg.payload ?? "");
      if (!request) {
        // Only the channel is logged: an invalid payload is arbitrary text.
        logger.warn({ channel: SEMP_TURN_CANCEL_CHANNEL }, "semp_turn_cancel_payload_invalid");
        return;
      }
      try {
        onCancel(request);
      } catch (err) {
        logger.error({ errorName: errorName(err) }, "Semp turn cancel handler failed");
      }
    };

    /** Releases the current client exactly once, destroying it so its LISTEN never returns to the pool. */
    function detach(): void {
      const current = active;
      if (!current) return;
      active = null;
      current.client.off("notification", onNotification);
      current.client.off("error", current.onError);
      current.client.release(true);
    }

    /**
     * Every failure releases the client before rethrowing. An error before LISTEN completed is the query's own
     * rejection, so only an error of the kept client starts a reconnect.
     */
    async function connect(): Promise<void> {
      const next = await pool.connect();
      const onError = (err: unknown): void => {
        logger.error({ errorName: errorName(err) }, "Semp turn cancel LISTEN connection failed");
        if (active?.client !== next) return;
        detach();
        if (!closed && !reconnecting) {
          reconnecting = reconnect().finally(() => {
            reconnecting = null;
          });
        }
      };
      // Registered before the first query: a checked-out client with no 'error' listener crashes the process when
      // its connection drops.
      next.on("error", onError);
      next.on("notification", onNotification);
      try {
        // LISTEN takes no bind parameters; the channel is this module's own constant identifier.
        await next.query(`LISTEN ${SEMP_TURN_CANCEL_CHANNEL}`);
      } catch (err) {
        next.off("notification", onNotification);
        next.off("error", onError);
        next.release(true);
        throw err;
      }
      active = { client: next, onError };
      // `close()` ran while this connect was in flight: release instead of keeping the client.
      if (closed) detach();
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
        try {
          await connect();
          return;
        } catch (err) {
          logger.error({ errorName: errorName(err) }, "Semp turn cancel LISTEN reconnect failed");
          if (closed) return;
          await backoff(delay);
          delay = Math.min(delay * 2, RECONNECT_MAX_DELAY_MS);
        }
      }
    }

    await connect();

    return {
      async close() {
        closed = true;
        detach();
        cancelBackoff?.();
        await reconnecting;
      },
    };
  });
}
