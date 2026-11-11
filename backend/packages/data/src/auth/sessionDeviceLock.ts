import type { PoolClient } from "pg";

/**
 * The two-key advisory lock class of the installation lock
 * (docs/adr/2026-11-10-login-replaces-the-sessions-of-its-installation.md). The key is derived from a
 * `deviceId` the client chooses, so it has a class nothing else locks in: a chosen value can equal
 * another installation key, but neither a single-key advisory lock, such as the admin-membership one,
 * nor a key of another two-key class (2331 in `seed/seedSystem.ts`, 2332 and 2333 in `db/pool.ts`).
 */
export const SESSION_DEVICE_LOCK_CLASS = 2334;

/**
 * Takes the installation lock of `userId` and `deviceId` for the rest of the caller's transaction:
 * `(SESSION_DEVICE_LOCK_CLASS, hashtext('semprec_device:<user id>:<device id>'))`, with both ids in the
 * lowercase text form of a `uuid`, so two spellings of one `deviceId` take the same key. `client` is the
 * caller's `withTransaction` client; commit or rollback releases the lock.
 */
export async function lockSessionDevice(client: PoolClient, userId: string, deviceId: string): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock($1::int4, hashtext('semprec_device:' || $2::uuid::text || ':' || $3::uuid::text))",
    [SESSION_DEVICE_LOCK_CLASS, userId, deviceId],
  );
}
