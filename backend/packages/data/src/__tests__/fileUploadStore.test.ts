import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import {
  createRuntimeRolePool,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "../testSupport/testDb.js";
import { runInTenant } from "@semprec/shared";
import { ForbiddenError } from "../errors.js";
import { seedSystem } from "../seed/seedSystem.js";
import { withTransaction } from "../db/pool.js";
import { resolveMailModuleIds } from "../mail/mailModuleIds.js";
import { ingestUploadedBlob, ingestUploadedFile } from "../blobs/fileUploadStore.js";
import type { BlobStorageWriter } from "../mail/blobStorage.js";
import { logger } from "../blobs/logger.js";
import { deleteBlobIfUnreferenced } from "../blobs/blobsStore.js";

/**
 * In-memory stand-in for `LocalFsBlobStorageWriter`: records every `writeStream`/`delete` call
 * and can be told to make the *next* written key's `delete` throw, so the tests can drive the
 * "delete inside vs. after commit" distinction the ADR requires without touching the filesystem.
 */
class FakeBlobStorageWriter implements BlobStorageWriter {
  readonly bytesByKey = new Map<string, Buffer>();
  readonly deleteCalls: string[] = [];
  private readonly deleteFailureKeys = new Set<string>();
  private failNextWrittenKeysDelete = false;

  failDeleteForNextWrite(): void {
    this.failNextWrittenKeysDelete = true;
  }

  async writeStream(storageKey: string, source: Readable): Promise<{ byteSize: number; contentHash: string }> {
    const chunks: Buffer[] = [];
    for await (const chunk of source) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const bytes = Buffer.concat(chunks);
    this.bytesByKey.set(storageKey, bytes);
    if (this.failNextWrittenKeysDelete) {
      this.deleteFailureKeys.add(storageKey);
      this.failNextWrittenKeysDelete = false;
    }
    return { byteSize: bytes.length, contentHash: createHash("sha256").update(bytes).digest("hex") };
  }

  async delete(storageKey: string): Promise<void> {
    this.deleteCalls.push(storageKey);
    if (this.deleteFailureKeys.has(storageKey)) {
      throw new Error(`simulated delete failure for ${storageKey}`);
    }
    this.bytesByKey.delete(storageKey);
  }

  readStream(storageKey: string, range?: { start: number; end: number }): Readable {
    const bytes = this.bytesByKey.get(storageKey);
    if (!bytes) throw new Error(`no bytes stored for ${storageKey}`);
    return Readable.from([range ? bytes.subarray(range.start, range.end + 1) : bytes]);
  }
}

function requireDefined<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("filing barrier timed out")), 5000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Captures the backend on the very client that issues the matched production statement. */
function observeStatementPid(runtime: Pool, statement: RegExp, onCaptured?: (client: PoolClient) => void) {
  let resolvePid!: (pid: number) => void;
  const pid = new Promise<number>((resolve) => {
    resolvePid = resolve;
  });
  const wrapped = new Map<PoolClient, PoolClient["query"]>();
  let captured = false;
  const instrument = (client: PoolClient) => {
    if (wrapped.has(client)) return;
    // eslint-disable-next-line @typescript-eslint/unbound-method
    wrapped.set(client, client.query);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    client.query = new Proxy(client.query, {
      apply(target, receiver, args: unknown[]) {
        if (captured || typeof args[0] !== "string" || !statement.test(args[0])) {
          return Reflect.apply(target, receiver, args);
        }
        captured = true;
        onCaptured?.(client);
        return (async () => {
          const result = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
          const actual = result.rows[0]?.pid;
          if (actual === undefined) throw new Error("missing competing backend pid");
          resolvePid(actual);
          return Reflect.apply(target, receiver, args);
        })();
      },
    });
  };
  runtime.on("acquire", instrument);
  return {
    pid,
    restore() {
      runtime.off("acquire", instrument);
      for (const [client, query] of wrapped) client.query = query;
    },
  };
}

// pg 8.23.0 reports these two finite owned-release paths with plain, uncoded errors.
function isOwnedPgClosure(
  error: unknown,
  message: "Connection terminated" | "Client was closed and is not queryable",
): boolean {
  return error instanceof Error && error.constructor === Error && !("code" in error) && error.message === message;
}

/** Owns only this overlap's runtime clients, gates and operations. */
function ownOverlap(
  runtime: Pool,
  cancel: () => void,
  onCancellation?: (client: PoolClient, generation: object) => void,
  onGeneration?: (client: PoolClient, generation: object) => void,
  onReleased?: (client: PoolClient, generation: object) => void,
) {
  runtime.options.connectionTimeoutMillis = 2500;
  runtime.options.statement_timeout = 5000;
  runtime.options.query_timeout = 7000;
  const active = new Map<PoolClient, object>();
  const destroyed = new Set<object>();
  const retired = new Set<PoolClient>();
  const tasks = new Set<Promise<void>>();
  const outcomes: Array<{ error?: { value: unknown }; consumed: boolean }> = [];
  const outcomeByOperation = new WeakMap<Promise<unknown>, (typeof outcomes)[number]>();
  const errors: unknown[] = [];
  let closing = false;
  let expired = false;
  let closingPromise: Promise<void> | undefined;
  let settledCleanup = false;
  const onClientError = (error: Error) => errors.push(error);
  const destroy = (client: PoolClient, token: object) => {
    if (active.get(client) !== token) return;
    try {
      onCancellation?.(client, token);
      destroyed.add(token);
      client.release(true);
      onReleased?.(client, token);
    } catch (error) {
      errors.push(error);
    }
  };
  const onAcquire = (client: PoolClient) => {
    const token = {};
    active.set(client, token);
    onGeneration?.(client, token);
    client.on("error", onClientError);
    // pg-pool 3.14 assigns release after the acquire event.
    if (closing) queueMicrotask(() => destroy(client, token));
  };
  const onRelease = (_error: Error | undefined, client: PoolClient) => {
    const generation = active.get(client);
    active.delete(client);
    if (generation && destroyed.has(generation)) retired.add(client);
    else client.removeListener("error", onClientError);
  };
  runtime.on("acquire", onAcquire);
  runtime.on("release", onRelease);
  const run = <T>(start: () => Promise<T>): Promise<T> => {
    const operation = Promise.resolve().then(() => {
      if (closing) throw new Error("Overlap is closing");
      return start();
    });
    const outcome: { error?: { value: unknown }; consumed: boolean } = { consumed: false };
    outcomes.push(outcome);
    outcomeByOperation.set(operation, outcome);
    const settled = operation.then(
      () => {},
      (error: unknown) => {
        outcome.error = { value: error };
      },
    );
    tasks.add(settled);
    void settled.then(() => tasks.delete(settled));
    return operation;
  };
  const wait = <T>(signal: Promise<T>, ...actors: Promise<unknown>[]): Promise<T> =>
    overlapBounded(
      Promise.race([
        signal,
        ...actors.map((actor) =>
          actor.then(
            () => {
              throw new Error("Overlap participant completed before its barrier");
            },
            (error: unknown) => {
              throw error;
            },
          ),
        ),
      ]),
      5000,
    );
  const finish = (bodyFailed = false): Promise<void> => {
    if (closingPromise) return closingPromise;
    closing = true;
    clearTimeout(timer);
    const detach = () => {
      runtime.removeListener("acquire", onAcquire);
      runtime.removeListener("release", onRelease);
      for (const client of retired) client.removeListener("error", onClientError);
      retired.clear();
      settledCleanup = true;
    };
    closingPromise = (async () => {
      if (!bodyFailed) {
        try {
          const deadline = Date.now() + 3000;
          while (tasks.size > 0 || active.size > 0 || runtime.waitingCount > 0) {
            if (Date.now() >= deadline) throw new Error("Overlap returned with owned work pending");
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        cancel();
      } catch (error) {
        errors.push(error);
      }
      for (const [client, token] of active) destroy(client, token);
      const end = runtime.end();
      const joined = (async () => {
        const results = await Promise.allSettled([end, ...tasks]);
        for (const result of results) if (result.status === "rejected") errors.push(result.reason);
        while (tasks.size > 0) await Promise.all([...tasks]);
        for (const outcome of outcomes) {
          if (outcome.error !== undefined && !outcome.consumed) errors.push(outcome.error.value);
        }
        const deadline = Date.now() + 3000;
        while (runtime.waitingCount > 0) {
          if (Date.now() >= deadline) throw new Error("Overlap pool waiters did not settle");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      })();
      try {
        await overlapBounded(joined, 8000);
        detach();
      } catch (error) {
        errors.push(error);
        // Only an unestablished driver/host stall reaches this failure fallback.
        void joined.then(detach, detach);
      }
      if (expired) errors.unshift(new Error("Overlap timed out"));
      if (errors.length) throw new AggregateError(errors, "Overlap cleanup failed", { cause: errors[0] });
    })();
    return closingPromise;
  };
  const timer = setTimeout(() => {
    expired = true;
    void finish(true).catch(() => {});
  }, 8000);
  const consume = (operation: Promise<unknown>, expected: unknown): void => {
    const outcome = outcomeByOperation.get(operation);
    if (!outcome?.error || outcome.error.value !== expected) throw new Error("Unexpected participant outcome");
    outcome.consumed = true;
  };
  return { run, wait, finish, consume, isSettled: () => settledCleanup };
}

async function overlapBounded<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Overlap cleanup timed out")), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function combineOverlapFailure(body: { error: unknown } | undefined, cleanup: unknown): { error: unknown } {
  return {
    error:
      body === undefined
        ? cleanup
        : new AggregateError([body.error, cleanup], "Overlap and cleanup failed", { cause: body.error }),
  };
}

function rethrowOverlap(error: unknown): never {
  // Preserve even non-Error thrown identities from the tested operation.
  throw error;
}

let pool: Pool;

describe("ingestUploadedFile (issue #670)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function filesDatabaseId(): Promise<string> {
    const ids = await withTransaction(pool, (client) => resolveMailModuleIds(client));
    return ids.filesDatabaseId;
  }

  function upload(storage: FakeBlobStorageWriter, filesDatabaseId: string, bytes: string) {
    return ingestUploadedFile(pool, {
      filesDatabaseId,
      filename: "note.txt",
      contentType: "text/plain",
      source: Readable.from([Buffer.from(bytes)]),
      storageKeyPrefix: "files",
      maxBytes: 1024,
      storage,
    });
  }

  async function uploadBytes(
    storage: FakeBlobStorageWriter,
    filesDatabaseId: string,
    bytes: Buffer,
    contentType: string,
    filename = "upload.bin",
    activePool: Pool = pool,
  ) {
    return ingestUploadedFile(activePool, {
      filesDatabaseId,
      filename,
      contentType,
      source: Readable.from([bytes]),
      storageKeyPrefix: "files",
      maxBytes: 1024 * 1024,
      storage,
    });
  }

  it("detects a PDF sent as image/jpeg from its bytes: type pdf and blob mime application/pdf", async () => {
    const result = await uploadBytes(
      new FakeBlobStorageWriter(),
      await filesDatabaseId(),
      Buffer.from("%PDF-1.7\n%body"),
      "image/jpeg",
    );
    expect(result.item.properties["type"]).toBe("pdf");
    expect(result.blob.mimeType).toBe("application/pdf");
  });

  it("stores no type and application/octet-stream for unrecognised content, whatever the client claimed", async () => {
    const result = await uploadBytes(
      new FakeBlobStorageWriter(),
      await filesDatabaseId(),
      Buffer.from("just some text"),
      "application/pdf",
    );
    expect(result.item.properties).not.toHaveProperty("type");
    expect(result.blob.mimeType).toBe("application/octet-stream");
  });

  it("stores an empty upload as unknown content", async () => {
    const result = await uploadBytes(
      new FakeBlobStorageWriter(),
      await filesDatabaseId(),
      Buffer.alloc(0),
      "image/png",
    );
    expect(result.item.properties).not.toHaveProperty("type");
    expect(result.blob.mimeType).toBe("application/octet-stream");
  });

  it("returns the existing item unchanged when identical bytes are uploaded again", async () => {
    const filesId = await filesDatabaseId();
    const storage = new FakeBlobStorageWriter();
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const first = await uploadBytes(storage, filesId, bytes, "application/octet-stream");
    const second = await uploadBytes(storage, filesId, bytes, "image/jpeg");
    expect(first.item.properties["type"]).toBe("png");
    expect(second.created).toBe(false);
    expect(second.item).toEqual(first.item);
  });

  it("reuses a standalone blob and its original storage root when filing identical bytes", async () => {
    const storage = new FakeBlobStorageWriter();
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
    const standalone = await ingestUploadedBlob(pool, {
      mimeType: "image/png",
      source: Readable.from([bytes]),
      maxBytes: 1024,
      storage,
    });
    const filed = await uploadBytes(storage, await filesDatabaseId(), bytes, "image/png");
    expect(filed.created).toBe(true);
    expect(filed.blob.id).toBe(standalone.blob.id);
    expect(filed.blob.storageKey).toBe(standalone.blob.storageKey);
    expect(filed.item.properties.file).toEqual({ blobId: standalone.blob.id });
    expect(storage.bytesByKey.has(standalone.blob.storageKey)).toBe(true);
  });

  it.each([undefined, { marker: "late" }])(
    "retains a late participant failure and consumes only the asserted participant %#",
    async (late) => {
      const runtime = await createRuntimeRolePool(pool, "semprec_data");
      let release = () => {};
      let started = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      const owned = ownOverlap(runtime, release);
      const expected = { marker: "asserted" };
      const body = new Error("forced observation failure");
      let lateSettled = false;
      let failure: { error: unknown } | undefined;
      try {
        const negative = owned.run(() =>
          withTenantTransaction(runtime, getTenantZeroId(), async (client) => {
            await client.query<{ "?column?": number }>("SELECT 1");
            rethrowOverlap(expected);
          }),
        );
        await expect(negative).rejects.toBe(expected);
        owned.consume(negative, expected);
        const participant = owned.run(() =>
          withTenantTransaction(runtime, getTenantZeroId(), async (client) => {
            const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
            if (!pid) throw new Error("Missing owned PID");
            started();
            await gate;
            rethrowOverlap(late);
          }),
        );
        void participant.then(
          () => {
            lateSettled = true;
          },
          () => {
            lateSettled = true;
          },
        );
        await owned.wait(ready, participant);
        throw body;
      } catch (error) {
        failure = { error };
      } finally {
        try {
          await owned.finish(failure !== undefined);
        } catch (error) {
          failure = combineOverlapFailure(failure, error);
        }
      }
      if (failure && (!(failure.error instanceof AggregateError) || failure.error.cause !== body)) {
        rethrowOverlap(failure.error);
      }
      const combined = failure?.error;
      expect(combined).toBeInstanceOf(AggregateError);
      if (!(combined instanceof AggregateError)) throw new Error("Expected combined failure");
      expect(combined.cause).toBe(body);
      expect(combined.errors[0]).toBe(body);
      const cleanup: unknown = combined.errors[1];
      expect(cleanup).toBeInstanceOf(AggregateError);
      if (!(cleanup instanceof AggregateError)) throw new Error("Expected cleanup failure");
      expect(combined.errors).toHaveLength(2);
      expect(cleanup.errors).toHaveLength(1);
      expect(cleanup.errors[0]).toBe(late);
      expect(cleanup.cause).toBe(late);
      expect(lateSettled).toBe(true);
      expect(runtime.ended).toBe(true);
      expect(runtime.totalCount).toBe(0);
      expect(runtime.listenerCount("acquire")).toBe(0);
      expect(runtime.listenerCount("release")).toBe(0);
    },
    20000,
  );

  it("settles ownership when the first participant has the wrong rejection", async () => {
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    const wrong = { marker: "wrong" };
    const expected = { marker: "expected" };
    const cleanupError = new Error("controlled cleanup failure");
    const owned = ownOverlap(runtime, () => {
      throw cleanupError;
    });
    let assertion: { error: unknown } | undefined;
    let failure: { error: unknown } | undefined;
    try {
      const negative = owned.run(() =>
        withTenantTransaction(runtime, getTenantZeroId(), async (client) => {
          await client.query<{ "?column?": number }>("SELECT 1");
          rethrowOverlap(wrong);
        }),
      );
      try {
        await expect(negative).rejects.toBe(expected);
      } catch (error) {
        assertion = { error };
        throw error;
      }
      owned.consume(negative, expected);
    } catch (error) {
      failure = { error };
    } finally {
      try {
        await owned.finish(failure !== undefined);
      } catch (error) {
        failure = combineOverlapFailure(failure, error);
      }
    }
    if (!assertion) throw new Error("Expected assertion failure");
    const combined = failure?.error;
    expect(combined).toBeInstanceOf(AggregateError);
    if (!(combined instanceof AggregateError)) throw new Error("Expected combined failure");
    expect(combined.errors).toHaveLength(2);
    expect(combined.errors[0]).toBe(assertion.error);
    expect(combined.cause).toBe(assertion.error);
    const cleanup: unknown = combined.errors[1];
    expect(cleanup).toBeInstanceOf(AggregateError);
    if (!(cleanup instanceof AggregateError)) throw new Error("Expected cleanup failure");
    expect(cleanup.errors).toHaveLength(2);
    expect(cleanup.errors[0]).toBe(cleanupError);
    expect(cleanup.errors[1]).toBe(wrong);
    expect(cleanup.cause).toBe(cleanupError);
    expect(runtime.ended).toBe(true);
    expect(runtime.totalCount).toBe(0);
    expect(runtime.waitingCount).toBe(0);
    expect(runtime.listenerCount("acquire")).toBe(0);
    expect(runtime.listenerCount("release")).toBe(0);
  }, 20000);

  it("preserves an early checkout failure together with cleanup failure", async () => {
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    const actorError = new Error("pre-verify checkout failure");
    const cleanupError = new Error("cleanup failure");
    let release = () => {};
    const signal = new Promise<void>((resolve) => {
      release = resolve;
    });
    runtime.options.verify = (_client, done) => done(actorError);
    const generations = new Map<PoolClient, object>();
    const cancellationRequests = new Set<object>();
    const owned = ownOverlap(
      runtime,
      () => {
        release();
        throw cleanupError;
      },
      (_client, generation) => {
        cancellationRequests.add(generation);
      },
      (client, generation) => {
        generations.set(client, generation);
      },
    );
    let operationFailure: { value: unknown } | undefined;
    const observedDiagnostics: Array<{ error: Error; generation: object; cancelled: boolean; operation: "checkout" }> =
      [];
    const observing = new Map<PoolClient, (error: Error) => void>();
    const observeAcquire = (client: PoolClient) => {
      const generation = generations.get(client);
      if (!generation) throw new Error("Missing client generation");
      const onError = (error: Error) =>
        observedDiagnostics.push({
          error,
          generation,
          cancelled: cancellationRequests.has(generation),
          operation: "checkout",
        });
      observing.set(client, onError);
      client.on("error", onError);
    };
    const observeRelease = (_reason: unknown, client: PoolClient) => {
      const onError = observing.get(client);
      const generation = generations.get(client);
      if (generation && cancellationRequests.has(generation)) return;
      if (onError) client.removeListener("error", onError);
      observing.delete(client);
      generations.delete(client);
    };
    runtime.on("acquire", observeAcquire);
    runtime.on("release", observeRelease);
    let failure: { error: unknown } | undefined;
    try {
      const actor = owned.run(() => withTenantTransaction(runtime, getTenantZeroId(), async () => {}));
      void actor.catch((error: unknown) => {
        operationFailure = { value: error };
      });
      await owned.wait(signal, actor);
    } catch (error) {
      failure = { error };
    } finally {
      try {
        await owned.finish(failure !== undefined);
      } catch (error) {
        failure = combineOverlapFailure(failure, error);
      }
    }
    if (!owned.isSettled()) {
      if (failure) throw failure.error;
      throw new Error("Owned overlap did not settle");
    }
    runtime.removeListener("acquire", observeAcquire);
    runtime.removeListener("release", observeRelease);
    for (const [client, onError] of observing) client.removeListener("error", onError);
    observing.clear();
    expect(observing.size).toBe(0);
    const observed = failure?.error;
    expect(observed).toBeInstanceOf(AggregateError);
    if (!(observed instanceof AggregateError)) throw new Error("Expected combined error");
    expect(observed.cause).toBe(actorError);
    expect(observed.errors[0]).toBe(actorError);
    expect(observed.errors).toHaveLength(2);
    const cleanup: unknown = observed.errors[1];
    expect(cleanup).toBeInstanceOf(AggregateError);
    if (!(cleanup instanceof AggregateError)) throw new Error("Expected cleanup aggregate");
    expect(operationFailure).toBeDefined();
    if (!operationFailure) throw new Error("Missing operation failure");
    expect(operationFailure.value).toBe(actorError);
    for (const diagnostic of observedDiagnostics) {
      expect(diagnostic.cancelled).toBe(true);
      expect(diagnostic.operation).toBe("checkout");
      expect(diagnostic.error).toBe(operationFailure.value);
    }
    const expectedErrors = [cleanupError, ...observedDiagnostics.map((entry) => entry.error), operationFailure.value];
    expect(cleanup.errors).toHaveLength(expectedErrors.length);
    for (let i = 0; i < expectedErrors.length; i++) expect(cleanup.errors[i]).toBe(expectedErrors[i]);
    expect(cleanup.cause).toBe(cleanupError);
    expect(runtime.ended).toBe(true);
    expect(runtime.totalCount).toBe(0);
    expect(runtime.waitingCount).toBe(0);
    expect(runtime.listenerCount("acquire")).toBe(0);
    expect(runtime.listenerCount("release")).toBe(0);
  }, 20000);

  it.each([false, true])(
    "settles late overlap checkout and preserves a simultaneous cleanup failure (post-release %s)",
    async (injectPostCancel) => {
      const runtime = await createRuntimeRolePool(pool, "semprec_data");
      let deliver = () => {};
      let ready = () => {};
      const verifying = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const bodyError = new Error("body failure");
      const cleanupError = new Error("cleanup failure");
      let ran = false;
      let settled = false;
      const postCancel = new Error("unrelated post-release checkout diagnostic");
      let releaseCallbackFailure: { value: unknown } | undefined;
      let checkoutGeneration: object | undefined;
      runtime.options.verify = (client, done) => {
        checkoutGeneration = generations.get(client);
        deliver = () => queueMicrotask(() => done());
        ready();
      };
      const generations = new Map<PoolClient, object>();
      const cancellationRequests = new Set<object>();
      const releaseCompletions = new Set<object>();
      const owned = ownOverlap(
        runtime,
        () => {
          deliver();
          throw cleanupError;
        },
        (_client, generation) => {
          cancellationRequests.add(generation);
        },
        (client, generation) => {
          generations.set(client, generation);
        },
        (client, generation) => {
          releaseCompletions.add(generation);
          if (injectPostCancel) {
            try {
              client.emit("error", postCancel);
            } catch (error) {
              releaseCallbackFailure = { value: error };
              throw error;
            }
          }
        },
      );
      const operation = owned.run(() =>
        withTenantTransaction(runtime, getTenantZeroId(), async () => {
          ran = true;
        }),
      );
      void operation.then(
        () => {
          settled = true;
        },
        (error: unknown) => {
          operationFailure = {
            value: error,
            generation: checkoutGeneration,
            cancelled: checkoutGeneration !== undefined && cancellationRequests.has(checkoutGeneration),
          };
          settled = true;
        },
      );
      let operationFailure: { value: unknown; generation: object | undefined; cancelled: boolean } | undefined;
      const observedDiagnostics: Array<{
        error: Error;
        generation: object;
        cancelled: boolean;
        released: boolean;
        operation: "checkout";
      }> = [];
      const observing = new Map<PoolClient, (error: Error) => void>();
      const observeAcquire = (client: PoolClient) => {
        const generation = generations.get(client);
        if (!generation) throw new Error("Missing client generation");
        const onError = (error: Error) =>
          observedDiagnostics.push({
            error,
            generation,
            cancelled: cancellationRequests.has(generation),
            released: releaseCompletions.has(generation),
            operation: "checkout",
          });
        observing.set(client, onError);
        client.on("error", onError);
      };
      const observeRelease = (_reason: unknown, client: PoolClient) => {
        const onError = observing.get(client);
        const generation = generations.get(client);
        if (generation && cancellationRequests.has(generation)) return;
        if (onError) client.removeListener("error", onError);
        observing.delete(client);
        generations.delete(client);
      };
      runtime.on("acquire", observeAcquire);
      runtime.on("release", observeRelease);
      let failure: { error: unknown } | undefined;
      try {
        await owned.wait(verifying, operation);
        failure = { error: bodyError };
      } catch (error) {
        failure = { error };
      } finally {
        try {
          await owned.finish(true);
        } catch (error) {
          failure = combineOverlapFailure(failure, error);
        }
      }
      if (!owned.isSettled()) {
        if (failure) throw failure.error;
        throw new Error("Owned overlap did not settle");
      }
      runtime.removeListener("acquire", observeAcquire);
      runtime.removeListener("release", observeRelease);
      for (const [client, onError] of observing) client.removeListener("error", onError);
      observing.clear();
      expect(observing.size).toBe(0);
      const observed = failure?.error;
      expect(observed).toBeInstanceOf(AggregateError);
      if (!(observed instanceof AggregateError)) throw new Error("Expected combined failure");
      expect(observed.cause).toBe(bodyError);
      expect(observed.errors[0]).toBe(bodyError);
      expect(observed.errors).toHaveLength(2);
      const cleanup: unknown = observed.errors[1];
      expect(cleanup).toBeInstanceOf(AggregateError);
      if (!(cleanup instanceof AggregateError)) throw new Error("Expected cleanup aggregate");
      expect(operationFailure).toBeDefined();
      if (!operationFailure) throw new Error("Missing operation failure");
      expect(operationFailure.generation).toBeDefined();
      expect(operationFailure.cancelled).toBe(true);
      expect(isOwnedPgClosure(operationFailure.value, "Client was closed and is not queryable")).toBe(true);
      expect(
        isOwnedPgClosure(new Error("unrelated post-cancel failure"), "Client was closed and is not queryable"),
      ).toBe(false);
      for (const diagnostic of observedDiagnostics) {
        expect(diagnostic.cancelled).toBe(true);
        expect(diagnostic.operation).toBe("checkout");
        if (diagnostic.error === postCancel) {
          expect(diagnostic.released).toBe(true);
          expect(injectPostCancel).toBe(true);
          expect(isOwnedPgClosure(diagnostic.error, "Client was closed and is not queryable")).toBe(false);
        } else expect(diagnostic.error).toBe(operationFailure.value);
      }
      expect(observedDiagnostics.filter((entry) => entry.error === postCancel)).toHaveLength(injectPostCancel ? 1 : 0);
      if (releaseCallbackFailure) expect(releaseCallbackFailure.value).toBe(postCancel);
      const expectedErrors = [
        cleanupError,
        ...observedDiagnostics.flatMap((entry) =>
          entry.error === postCancel && releaseCallbackFailure
            ? [entry.error, releaseCallbackFailure.value]
            : [entry.error],
        ),
        operationFailure.value,
      ];
      expect(cleanup.errors).toHaveLength(expectedErrors.length);
      for (let i = 0; i < expectedErrors.length; i++) expect(cleanup.errors[i]).toBe(expectedErrors[i]);
      expect(cleanup.cause).toBe(cleanupError);
      expect(ran).toBe(false);
      expect(settled).toBe(true);
      expect(runtime.ended).toBe(true);
      expect(runtime.totalCount).toBe(0);
      expect(runtime.waitingCount).toBe(0);
      expect(runtime.listenerCount("acquire")).toBe(0);
      expect(runtime.listenerCount("release")).toBe(0);
    },
    20000,
  );

  it.each([
    [undefined, false, false],
    [{ marker: "late participant" }, false, false],
    [{ marker: "late participant" }, true, false],
    [{ marker: "late participant" }, false, true],
  ] as const)(
    "settles a blocked filing operation when its owner fails %#",
    async (lateParticipant, injectPreCancel, injectPostCancel) => {
      const filesId = await filesDatabaseId();
      const storage = new FakeBlobStorageWriter();
      const bytes = Buffer.from("cancel blocked filing");
      const standalone = await ingestUploadedBlob(pool, {
        mimeType: "image/png",
        source: Readable.from([bytes]),
        maxBytes: 1024,
        storage,
      });
      const runtime = await createRuntimeRolePool(pool, "semprec_data");
      let release = () => {};
      let ready = (_pid: number) => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<number>((resolve) => {
        ready = resolve;
      });
      const generations = new Map<PoolClient, object>();
      const cancellationRequests = new Set<object>();
      const releaseCompletions = new Set<object>();
      let holderClient: PoolClient | undefined;
      let contenderClient: PoolClient | undefined;
      let contenderGeneration: object | undefined;
      const preCancel = new Error("pre-cancellation diagnostic");
      const postCancel = new Error("unrelated post-cancellation diagnostic");
      let releaseCallbackFailure: { value: unknown } | undefined;
      const owned = ownOverlap(
        runtime,
        release,
        (_client, generation) => {
          cancellationRequests.add(generation);
        },
        (client, generation) => {
          generations.set(client, generation);
        },
        (client, generation) => {
          releaseCompletions.add(generation);
          if (injectPostCancel && client === holderClient) {
            try {
              client.emit("error", postCancel);
            } catch (error) {
              releaseCallbackFailure = { value: error };
              throw error;
            }
          }
        },
      );
      const bodyError = new Error("forced blocked filing failure");
      let failure: { error: unknown } | undefined;
      let observer: ReturnType<typeof observeStatementPid> | undefined;
      let holderSettled = false;
      type ObservedClient = { generation: object; onError: (error: Error) => void };
      const observedClients = new Map<PoolClient, ObservedClient>();
      const diagnostics: Array<{
        error: Error;
        generation: object;
        cancelled: boolean;
        released: boolean;
        operation: string;
      }> = [];
      const observeAcquire = (client: PoolClient) => {
        const generation = generations.get(client);
        if (!generation) throw new Error("Missing client generation");
        const onError = (error: Error) =>
          diagnostics.push({
            error,
            generation,
            cancelled: cancellationRequests.has(generation),
            released: releaseCompletions.has(generation),
            operation: client === holderClient ? "holder" : client === contenderClient ? "contender" : "other",
          });
        observedClients.set(client, { generation, onError });
        client.on("error", onError);
      };
      const observeRelease = (_reason: unknown, client: PoolClient) => {
        const owner = observedClients.get(client);
        if (!owner) throw new Error("Unknown owned client release");
        if (cancellationRequests.has(owner.generation)) return;
        client.removeListener("error", owner.onError);
        observedClients.delete(client);
        generations.delete(client);
      };
      runtime.on("acquire", observeAcquire);
      runtime.on("release", observeRelease);
      let holderError: { value: unknown } | undefined;
      let contenderError:
        | {
            value: unknown;
            generation: object | undefined;
            cancellationRequested: boolean;
          }
        | undefined;
      let contenderSettled = false;
      let contenderFailed = false;
      try {
        const holder = owned.run(() =>
          withTenantTransaction(runtime, getTenantZeroId(), async (client) => {
            holderClient = client;
            const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
            if (pid === undefined) throw new Error("Missing holder PID");
            await client.query<{ id: string }>("SELECT id FROM blobs WHERE id = $1 FOR UPDATE", [standalone.blob.id]);
            ready(pid);
            await gate;
            rethrowOverlap(lateParticipant);
          }),
        );
        void holder.then(
          () => {
            holderSettled = true;
          },
          (error: unknown) => {
            holderError = { value: error };
            holderSettled = true;
          },
        );
        const holderPid = await owned.wait(started, holder);
        observer = observeStatementPid(runtime, /FROM blobs\b[\s\S]*FOR UPDATE/i, (client) => {
          contenderClient = client;
          contenderGeneration = generations.get(client);
        });
        const contender = owned.run(() =>
          runInTenant(getTenantZeroId(), () =>
            uploadBytes(storage, filesId, bytes, "image/png", "blocked.bin", runtime),
          ),
        );
        void contender.then(
          () => {
            contenderSettled = true;
          },
          (error: unknown) => {
            contenderError = {
              value: error,
              generation: contenderGeneration,
              cancellationRequested: contenderGeneration !== undefined && cancellationRequests.has(contenderGeneration),
            };
            contenderSettled = true;
            contenderFailed = true;
          },
        );
        const contenderPid = await owned.wait(observer.pid, holder, contender);
        await owned.wait(
          owned.run(() =>
            expect
              .poll(
                async () => {
                  const result = await runtime.query<{ blocked: boolean }>(
                    "SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked",
                    [holderPid, contenderPid],
                  );
                  return result.rows[0]?.blocked;
                },
                { timeout: 5000 },
              )
              .toBe(true),
          ),
          holder,
          contender,
        );
        if (injectPreCancel) {
          if (!holderClient) throw new Error("Missing holder client");
          holderClient.emit("error", preCancel);
        }
        throw bodyError;
      } catch (error) {
        failure = { error };
      } finally {
        try {
          await owned.finish(failure !== undefined);
        } catch (error) {
          failure = combineOverlapFailure(failure, error);
        }
        runtime.removeListener("acquire", observeAcquire);
        runtime.removeListener("release", observeRelease);
        observer?.restore();
      }
      for (const [client, owner] of observedClients) client.removeListener("error", owner.onError);
      observedClients.clear();
      const combined = failure?.error;
      expect(combined).toBeInstanceOf(AggregateError);
      if (!(combined instanceof AggregateError)) throw new Error("Expected combined failure");
      expect(combined.cause).toBe(bodyError);
      expect(combined.errors[0]).toBe(bodyError);
      const cleanup: unknown = combined.errors[1];
      expect(cleanup).toBeInstanceOf(AggregateError);
      if (!(cleanup instanceof AggregateError)) throw new Error("Expected cleanup failures");
      expect(holderError).toBeDefined();
      if (!holderError) throw new Error("Missing participant failure");
      expect(holderError.value).toBe(lateParticipant);
      expect(observedClients.size).toBe(0);
      for (const diagnostic of diagnostics) {
        expect(diagnostic.error).toBeInstanceOf(Error);
        if (diagnostic.error === preCancel) {
          expect(injectPreCancel).toBe(true);
          expect(diagnostic.released).toBe(false);
          expect(diagnostic.cancelled).toBe(false);
          expect(diagnostic.operation).toBe("holder");
        } else if (diagnostic.error === postCancel) {
          expect(diagnostic.released).toBe(true);
          expect(injectPostCancel).toBe(true);
          expect(diagnostic.cancelled).toBe(true);
          expect(diagnostic.operation).toBe("holder");
          expect(isOwnedPgClosure(diagnostic.error, "Connection terminated")).toBe(false);
        } else {
          expect(diagnostic.cancelled).toBe(true);
          expect(["holder", "contender"]).toContain(diagnostic.operation);
          expect(isOwnedPgClosure(diagnostic.error, "Connection terminated")).toBe(true);
          if (diagnostic.operation === "holder") expect(diagnostic.error).toBe(holderError.value);
          else expect(diagnostic.error).toBe(contenderError?.value);
        }
      }
      if (!contenderError) throw new Error("Missing contender failure");
      expect(contenderError.generation).toBeDefined();
      expect(isOwnedPgClosure(contenderError.value, "Connection terminated")).toBe(true);
      expect(contenderError.cancellationRequested).toBe(true);
      expect(diagnostics.filter((entry) => entry.error === preCancel)).toHaveLength(injectPreCancel ? 1 : 0);
      expect(diagnostics.filter((entry) => entry.error === postCancel)).toHaveLength(injectPostCancel ? 1 : 0);
      if (releaseCallbackFailure) expect(releaseCallbackFailure.value).toBe(postCancel);
      const expectedErrors = [
        ...diagnostics.flatMap((entry) =>
          entry.error === postCancel && releaseCallbackFailure
            ? [entry.error, releaseCallbackFailure.value]
            : [entry.error],
        ),
        holderError.value,
        contenderError.value,
      ];
      expect(combined.errors).toHaveLength(2);
      expect(cleanup.errors).toHaveLength(expectedErrors.length);
      for (let i = 0; i < expectedErrors.length; i++) expect(cleanup.errors[i]).toBe(expectedErrors[i]);
      expect(cleanup.cause).toBe(expectedErrors[0]);

      expect(holderSettled).toBe(true);
      expect(contenderSettled).toBe(true);
      expect(contenderFailed).toBe(true);
      const rows = await pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM items WHERE database_id = $1 AND properties ? 'file'",
        [filesId],
      );
      expect(rows.rows[0]?.n).toBe(0);
      expect(storage.bytesByKey.has(standalone.blob.storageKey)).toBe(true);
      expect(runtime.ended).toBe(true);
      expect(runtime.totalCount).toBe(0);
      expect(runtime.waitingCount).toBe(0);
      expect(runtime.listenerCount("acquire")).toBe(0);
      expect(runtime.listenerCount("release")).toBe(0);
    },
    20000,
  );

  it.each([
    ["first.bin", "second.bin", "commit"],
    ["second.bin", "first.bin", "commit"],
    ["first.bin", "second.bin", "rollback"],
  ] as const)(
    "serializes %s before %s when the first outcome is %s",
    async (firstName, secondName, outcome) => {
      const filesId = await filesDatabaseId();
      const storage = new FakeBlobStorageWriter();
      const bytes = Buffer.from("standalone race bytes");
      const standalone = await ingestUploadedBlob(pool, {
        mimeType: "image/png",
        source: Readable.from([bytes]),
        maxBytes: 1024,
        storage,
      });
      let release!: () => void;
      let ready!: (pid: number) => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<number>((resolve) => {
        ready = resolve;
      });
      const wrapped = new Map<PoolClient, PoolClient["query"]>();
      let held = false;
      const firstRollback = new Error("forced first filing rollback");
      const instrument = (client: PoolClient) => {
        if (wrapped.has(client)) return;
        // The proxy forwards each call with its original receiver.
        // eslint-disable-next-line @typescript-eslint/unbound-method
        wrapped.set(client, client.query);
        // eslint-disable-next-line @typescript-eslint/unbound-method
        client.query = new Proxy(client.query, {
          apply(target, receiver, args: unknown[]) {
            const result: unknown = Reflect.apply(target, receiver, args);
            if (held || typeof args[0] !== "string" || !args[0].includes("properties -> 'file' ->> 'blobId'"))
              return result;
            held = true;
            return Promise.resolve(result).then(async (value: unknown) => {
              const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
              if (pid === undefined) throw new Error("missing filing pid");
              ready(pid);
              await gate;
              if (outcome === "rollback") throw firstRollback;
              return value;
            });
          },
        });
      };
      const runtime = await createRuntimeRolePool(pool, "semprec_data");
      runtime.on("acquire", instrument);
      const owned = ownOverlap(runtime, release);
      const first = owned.run(() =>
        runInTenant(getTenantZeroId(), () => uploadBytes(storage, filesId, bytes, "image/png", firstName, runtime)),
      );
      const firstSettled = Promise.allSettled([first]);
      let second: ReturnType<typeof uploadBytes> | undefined;
      let competing: ReturnType<typeof observeStatementPid> | undefined;
      let failure: { error: unknown } | undefined;
      try {
        const pid = await owned.wait(started, first);
        competing = observeStatementPid(runtime, /FROM blobs\b[\s\S]*FOR UPDATE/i);
        second = owned.run(() =>
          runInTenant(getTenantZeroId(), () => uploadBytes(storage, filesId, bytes, "image/png", secondName, runtime)),
        );
        const secondSettled = Promise.allSettled([second]);
        const competitorPid = await owned.wait(competing.pid, first, second);
        await owned.wait(
          owned.run(() =>
            expect
              .poll(
                async () => {
                  const result = await runtime.query<{ blocked: boolean }>(
                    "SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked",
                    [pid, competitorPid],
                  );
                  return result.rows[0]?.blocked;
                },
                { timeout: 5000 },
              )
              .toBe(true),
          ),
          first,
          second,
        );
        release();
        const [firstResult] = await firstSettled;
        const [secondResult] = await secondSettled;
        if (outcome === "commit") {
          expect(firstResult?.status).toBe("fulfilled");
          expect(secondResult?.status).toBe("fulfilled");
          if (firstResult?.status === "fulfilled" && secondResult?.status === "fulfilled") {
            expect(firstResult.value.created).toBe(true);
            expect(firstResult.value.item.properties.name).toBe(firstName);
            expect(secondResult.value.created).toBe(false);
            expect(secondResult.value.item.id).toBe(firstResult.value.item.id);
            expect(secondResult.value.blob.id).toBe(standalone.blob.id);
          }
        } else {
          expect(firstResult?.status).toBe("rejected");
          if (firstResult?.status === "rejected") {
            expect(firstResult.reason).toBe(firstRollback);
            owned.consume(first, firstRollback);
          }
          expect(secondResult?.status).toBe("fulfilled");
          if (secondResult?.status === "fulfilled")
            expect(secondResult.value).toMatchObject({
              created: true,
              blob: { id: standalone.blob.id },
              item: { properties: { name: secondName } },
            });
        }
        const rows = await pool.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM items WHERE database_id = $1 AND properties ? 'file'",
          [filesId],
        );
        expect(rows.rows[0]?.n).toBe(1);
        expect(storage.bytesByKey.has(standalone.blob.storageKey)).toBe(true);
        await vi.waitFor(() => expect(storage.bytesByKey.size).toBe(1));
        expect(storage.deleteCalls).toHaveLength(2);
      } catch (error) {
        failure = { error };
      } finally {
        try {
          await owned.finish(failure !== undefined);
        } catch (error) {
          failure = combineOverlapFailure(failure, error);
        }
        competing?.restore();
        runtime.off("acquire", instrument);
        for (const [client, query] of wrapped) client.query = query;
      }
      if (failure) rethrowOverlap(failure.error);
    },
    25000,
  );

  it("fails closed and cleans its bytes if the reused blob disappears before the filing lock", async () => {
    const filesId = await filesDatabaseId();
    const storage = new FakeBlobStorageWriter();
    const bytes = Buffer.from("blob deleted before filing lock");
    const standalone = await ingestUploadedBlob(pool, {
      mimeType: "image/png",
      source: Readable.from([bytes]),
      maxBytes: 1024,
      storage,
    });
    const wrapped = new Map<PoolClient, PoolClient["query"]>();
    let intercepted = false;
    let deletion: Promise<void> | undefined;
    const instrument = (client: PoolClient) => {
      if (wrapped.has(client)) return;
      // eslint-disable-next-line @typescript-eslint/unbound-method
      wrapped.set(client, client.query);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      client.query = new Proxy(client.query, {
        apply(target, receiver, args: unknown[]) {
          if (intercepted || typeof args[0] !== "string" || !args[0].includes("AND id = $1 FOR UPDATE")) {
            return Reflect.apply(target, receiver, args);
          }
          intercepted = true;
          deletion = withTransaction(pool, async (other) => {
            const key = await deleteBlobIfUnreferenced(other, standalone.blob.id);
            expect(key).toBe(standalone.blob.storageKey);
          }).then(async () => storage.delete(standalone.blob.storageKey));
          return bounded(deletion).then(() => Reflect.apply(target, receiver, args));
        },
      });
    };
    pool.on("acquire", instrument);
    try {
      await expect(uploadBytes(storage, filesId, bytes, "image/png")).rejects.toMatchObject({
        code: "validation_failed",
        details: { field: "file" },
      });
      expect(intercepted).toBe(true);
      expect(storage.bytesByKey.size).toBe(0);
      expect(storage.deleteCalls).toHaveLength(2);
      const rows = await pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM items WHERE database_id = $1 AND properties ? 'file'",
        [filesId],
      );
      expect(rows.rows[0]?.n).toBe(0);
    } finally {
      if (deletion) await Promise.allSettled([deletion]);
      pool.off("acquire", instrument);
      for (const [client, query] of wrapped) client.query = query;
    }
  }, 15000);

  it("deletes the streamed bytes and leaves no blobs row when the transaction fails", async () => {
    const filesId = await filesDatabaseId();
    // The Files database is seeded as a system database, which `chokePoint.archiveDatabase`
    // refuses to archive — archived directly here purely to make `createItemWithClient` throw
    // `database_archived`, the same guard a non-system database hits through the choke point.
    await pool.query("UPDATE databases SET archived_at = now() WHERE id = $1", [filesId]);
    const storage = new FakeBlobStorageWriter();

    await expect(upload(storage, filesId, "hello world")).rejects.toBeInstanceOf(ForbiddenError);

    expect(storage.deleteCalls).toHaveLength(1);
    expect(storage.bytesByKey.size).toBe(0);

    const contentHash = createHash("sha256").update("hello world").digest("hex");
    const { rows } = await pool.query("SELECT id FROM blobs WHERE content_hash = $1", [contentHash]);
    expect(rows).toHaveLength(0);
  });

  it("deletes the duplicate's bytes after commit, exactly once, keeping the first key's bytes", async () => {
    const filesId = await filesDatabaseId();
    const storage = new FakeBlobStorageWriter();

    const first = await upload(storage, filesId, "same content");
    expect(first.created).toBe(true);
    const firstKey = first.blob.storageKey;

    const second = await upload(storage, filesId, "same content");
    expect(second.created).toBe(false);
    expect(second.item.id).toBe(first.item.id);

    expect(storage.deleteCalls).toHaveLength(1);
    const secondKey = requireDefined(storage.deleteCalls[0], "expected one delete call");
    expect(secondKey).not.toBe(firstKey);
    expect(storage.bytesByKey.has(firstKey)).toBe(true);
    expect(storage.bytesByKey.has(secondKey)).toBe(false);
  });

  it("a failed after-commit delete of the duplicate does not fail the upload (delete happens after commit, not inside)", async () => {
    const loggerErrorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    const filesId = await filesDatabaseId();
    const storage = new FakeBlobStorageWriter();

    const first = await upload(storage, filesId, "same content again");
    storage.failDeleteForNextWrite();

    const second = await upload(storage, filesId, "same content again");

    expect(second.created).toBe(false);
    expect(second.item.id).toBe(first.item.id);
    expect(storage.deleteCalls).toHaveLength(1);
    // The duplicate's bytes are still present because the fake's delete failed — the point
    // being verified is that the failure did not abort the transaction.
    const secondKey = requireDefined(storage.deleteCalls[0], "expected one delete call");
    expect(storage.bytesByKey.has(secondKey)).toBe(true);

    // The delete runs from an `afterCommit` callback, whose rejection is handled asynchronously.
    await new Promise((resolve) => setImmediate(resolve));
    expect(loggerErrorSpy).toHaveBeenCalledWith(
      { errCode: undefined, blobId: expect.any(String) },
      "Failed to delete duplicate upload bytes",
    );
    // The log names neither the storage key nor the fake's error text, which embeds the key.
    const logged = JSON.stringify(loggerErrorSpy.mock.calls);
    expect(logged).not.toContain(secondKey);
    expect(logged).not.toContain("simulated delete failure");
  });

  it("keeps the bytes and the blobs row referencing them when the upload creates a new blob", async () => {
    const filesId = await filesDatabaseId();
    const storage = new FakeBlobStorageWriter();

    const result = await upload(storage, filesId, "brand new bytes");

    expect(result.created).toBe(true);
    expect(storage.deleteCalls).toHaveLength(0);
    expect(storage.bytesByKey.get(result.blob.storageKey)).toBeDefined();
  });
});
