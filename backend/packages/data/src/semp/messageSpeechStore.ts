import { setTimeout as delay } from "node:timers/promises";
import type { Pool, PoolClient } from "pg";
import { currentTenantScope } from "@semprec/shared";
import { createBlob, getBlob } from "../blobs/blobsStore.js";
import { requireManagedTransaction, requireSingleRow } from "../db/pool.js";
import { NotFoundError, ValidationError } from "../errors.js";
import type { BlobRow } from "../types.js";

const SPEECH_GUARD_POLL_MS = 100;
const SPEECH_OPERATION_LIMIT_MS = 5 * 60_000;
const guardAdmissions = new WeakMap<Pool, number>();

export class MessageSpeechCapacityError extends Error {
  constructor() {
    super("Speech capacity unavailable");
    this.name = "MessageSpeechCapacityError";
  }
}

/** Holds a bounded, tenant-keyed session guard without opening a transaction across I/O. */
export async function withMessageSpeechGuard<T>(
  pool: Pool,
  messageId: string,
  voice: string,
  signal: AbortSignal,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const scope = currentTenantScope();
  if (scope?.kind !== "tenant") throw new Error("Speech guard requires tenant scope");
  const limit = (pool.options.max ?? 10) - 1;
  const admitted = guardAdmissions.get(pool) ?? 0;
  if (limit < 1 || admitted >= limit) throw new MessageSpeechCapacityError();
  guardAdmissions.set(pool, admitted + 1);
  const lost = new AbortController();
  const guardedSignal = AbortSignal.any([signal, lost.signal, AbortSignal.timeout(SPEECH_OPERATION_LIMIT_MS)]);
  const key = `semp-message-speech:v1:${scope.tenantId.toLowerCase()}:${messageId.toLowerCase()}:${voice}`;
  let client: PoolClient | undefined;
  let held = false;
  let acquisitionUncertain = false;
  let failure: unknown;
  let failed = false;
  let result: { value: T } | undefined;
  const onError = (error: Error) => lost.abort(error);
  const onEnd = () => lost.abort(new Error("Speech guard session ended"));
  try {
    guardedSignal.throwIfAborted();
    client = await pool.connect();
    client.on("error", onError);
    client.on("end", onEnd);
    for (;;) {
      guardedSignal.throwIfAborted();
      acquisitionUncertain = true;
      const attempt = await client.query<{ acquired: unknown }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1::text, 0)) AS acquired",
        [key],
      );
      const acquired = requireSingleRow(attempt.rows, "speech guard acquisition").acquired;
      if (typeof acquired !== "boolean") throw new Error("Invalid speech guard acquisition result");
      held = acquired;
      acquisitionUncertain = false;
      if (held) break;
      await delay(SPEECH_GUARD_POLL_MS, undefined, { signal: guardedSignal });
    }
    guardedSignal.throwIfAborted();
    result = { value: await work(guardedSignal) };
    guardedSignal.throwIfAborted();
  } catch (error) {
    failed = true;
    failure = error;
  }
  const cleanupFailures: unknown[] = [];
  if (client) {
    try {
      if (held && !lost.signal.aborted) {
        const unlock = await client.query<{ released: unknown }>(
          "SELECT pg_advisory_unlock(hashtextextended($1::text, 0)) AS released",
          [key],
        );
        if (requireSingleRow(unlock.rows, "speech guard release").released !== true)
          throw new Error("Speech guard release failed");
      } else if (held) {
        throw new Error("Speech guard session was lost", { cause: lost.signal.reason });
      }
    } catch (error) {
      cleanupFailures.push(error);
    }
    client.off("error", onError);
    client.off("end", onEnd);
    try {
      client.release(
        cleanupFailures.length || lost.signal.aborted || acquisitionUncertain
          ? new Error("Discarding speech guard session")
          : undefined,
      );
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  const remaining = (guardAdmissions.get(pool) ?? 1) - 1;
  if (remaining === 0) guardAdmissions.delete(pool);
  else guardAdmissions.set(pool, remaining);
  if (failed && cleanupFailures.length)
    throw new AggregateError([failure, ...cleanupFailures], "Speech guard operation and cleanup failed", {
      cause: failure,
    });
  if (failed) throw failure instanceof Error ? failure : new Error("Speech guard failed", { cause: failure });
  if (cleanupFailures.length === 1) {
    const error = cleanupFailures[0];
    throw error instanceof Error ? error : new Error("Speech guard cleanup failed", { cause: error });
  }
  if (cleanupFailures.length > 1)
    throw new AggregateError(cleanupFailures, "Speech guard cleanup failed", { cause: cleanupFailures[0] });
  if (!result) throw new Error("Speech guard returned no result");
  return result.value;
}

export async function getMessageSpeechSource(
  client: PoolClient,
  threadId: string,
  messageId: string,
  lock = false,
): Promise<string> {
  requireManagedTransaction(client);
  // The optional SQL suffix is selected from two fixed literals.
  const { rows } = await client.query<{ role: string; text: string | null }>(
    `SELECT role, text FROM semp_messages WHERE id = $1 AND thread_id = $2 ${lock ? "FOR UPDATE" : ""}`,
    [messageId, threadId],
  );
  const row = rows[0];
  if (!row) throw new NotFoundError("Message not found");
  if ((row.role !== "user" && row.role !== "assistant") || !row.text?.trim()) {
    throw new ValidationError("Message has no readable text", { field: "messageId" });
  }
  if (row.text.length > 4000) throw new ValidationError("Message is too long for speech", { field: "messageId" });
  return row.text;
}

export async function getMessageSpeech(client: PoolClient, messageId: string, voice: string): Promise<BlobRow | null> {
  requireManagedTransaction(client);
  const { rows } = await client.query<{ blob_id: string }>(
    "SELECT blob_id FROM semp_message_speech WHERE message_id = $1 AND voice = $2",
    [messageId, voice],
  );
  if (!rows[0]) return null;
  const blob = await getBlob(client, rows[0].blob_id);
  if (!blob) throw new Error("Speech cache references a missing blob");
  return blob;
}

/** Checks a private staging key after waiting for any in-flight source-row transaction. */
export async function messageSpeechStagedBlobExists(
  client: PoolClient,
  messageId: string,
  storageKey: string,
): Promise<boolean> {
  requireManagedTransaction(client);
  await client.query("SELECT id FROM semp_messages WHERE id = $1 FOR UPDATE", [messageId]);
  const { rows } = await client.query<{ present: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM blobs WHERE storage_key = $1) AS present",
    [storageKey],
  );
  return requireSingleRow(rows, "speech staging lookup").present;
}

export async function storeMessageSpeech(
  client: PoolClient,
  input: { threadId: string; messageId: string; voice: string; text: string; storageKey: string; byteSize: number },
): Promise<{ blob: BlobRow; created: boolean }> {
  requireManagedTransaction(client);
  if (
    !Number.isSafeInteger(input.byteSize) ||
    input.byteSize <= 0 ||
    input.byteSize > 32 * 1024 * 1024 ||
    input.byteSize % 2 !== 0
  ) {
    throw new ValidationError("Invalid speech audio size", { field: "audio" });
  }
  const text = await getMessageSpeechSource(client, input.threadId, input.messageId, true);
  if (text !== input.text) throw new ValidationError("Message changed during synthesis", { field: "messageId" });
  const existing = await getMessageSpeech(client, input.messageId, input.voice);
  if (existing) return { blob: existing, created: false };
  const blob = await createBlob(client, {
    mimeType: "audio/x-raw; format=S16LE; rate=24000; channels=1",
    byteSize: input.byteSize,
    storageKey: input.storageKey,
  });
  const inserted = await client.query<{ blob_id: string }>(
    `INSERT INTO semp_message_speech (message_id, voice, blob_id, audio_seconds)
     VALUES ($1, $2, $3, $4) RETURNING blob_id`,
    [input.messageId, input.voice, blob.id, input.byteSize / 48_000],
  );
  requireSingleRow(inserted.rows, "inserting message speech");
  return { blob, created: true };
}
