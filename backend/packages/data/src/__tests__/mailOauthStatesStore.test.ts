import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { openSecret } from "@semprec/credentials";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { getOrCreateTenantDataKey } from "../credentials/tenantKeysStore.js";
import { withTransaction } from "../db/pool.js";
import { consumeMailOauthState, createMailOauthState } from "../mail/mailOauthStatesStore.js";
import { handleMailOauthStatesSweepTask } from "../mail/mailOauthStatesSweep.js";
import { LocalFsBlobStorageWriter } from "../mail/blobStorage.js";
import { handleTenantExportTask } from "../tenancy/tenantExportJob.js";
import { requestTenantExport } from "../tenancy/tenantExportsStore.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";

let adminPool: Pool;
let pool: Pool;
let tenantA: string;
let tenantB: string;

async function createUser(tenantId: string): Promise<string> {
  const { rows } = await adminPool.query<{ id: string }>(
    "INSERT INTO users (email, password_hash, tenant_id) VALUES ($1, 'unused', $2) RETURNING id",
    [`${randomUUID()}@example.com`, tenantId],
  );
  return rows[0]!.id;
}

function create(tenantId: string, userId: string, provider: "gmail" | "outlook" = "gmail") {
  return runInTenant(tenantId, () =>
    withTransaction(pool, (client) => createMailOauthState(client, { userId, provider, mailboxItemId: null })),
  );
}

function consume(tenantId: string, state: string, userId: string) {
  return runInTenant(tenantId, () =>
    withTransaction(pool, (client) => consumeMailOauthState(client, { state, userId })),
  );
}

async function rowFor(state: string) {
  const { rows } = await adminPool.query<{
    id: string;
    tenant_id: string;
    used_at: Date | null;
    created_at: Date;
    expires_at: Date;
    code_verifier_ciphertext: Buffer;
    code_verifier_nonce: Buffer;
  }>("SELECT * FROM mail_oauth_states WHERE state_hash = $1", [createHash("sha256").update(state).digest("hex")]);
  return rows[0];
}

describe("mail OAuth states (issue #1483)", () => {
  let userA: string;

  beforeAll(async () => {
    adminPool = getTestPool();
    pool = await createRuntimeRolePool(adminPool, "semprec_data");
  });

  afterAll(async () => {
    await pool?.end();
    await adminPool?.end();
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
    tenantA = getTenantZeroId();
    tenantB = await createTestTenant(adminPool);
    userA = await createUser(tenantA);
  });

  it("returns provider, mailbox id and verifier once, and sets used_at", async () => {
    const { state, codeChallenge } = await create(tenantA, userA, "outlook");
    const row = (await rowFor(state))!;
    expect(row.used_at).toBeNull();
    expect(row.expires_at.getTime() - row.created_at.getTime()).toBe(10 * 60 * 1000);

    const consumed = await consume(tenantA, state, userA);
    expect(consumed).toMatchObject({ provider: "outlook", mailboxItemId: null });
    expect(createHash("sha256").update(consumed!.codeVerifier).digest("base64url")).toBe(codeChallenge);
    expect((await rowFor(state))!.used_at).not.toBeNull();
  });

  it("returns the mailbox id when reauthorizing an existing mailbox", async () => {
    const mailboxItemId = randomUUID();
    const created = await runInTenant(tenantA, () =>
      withTransaction(pool, (client) =>
        createMailOauthState(client, { userId: userA, provider: "gmail", mailboxItemId }),
      ),
    );
    const consumed = await consume(tenantA, created.state, userA);
    expect(consumed?.mailboxItemId).toBe(mailboxItemId);
    expect(consumed?.provider).toBe("gmail");
    expect(await consume(tenantA, created.state, userA)).toBeNull();
  });

  it("returns null for a second consume, another user and an expired state, changing nothing", async () => {
    const userOther = randomUUID();
    const first = await create(tenantA, userA);
    expect(await consume(tenantA, first.state, userOther)).toBeNull();
    expect((await rowFor(first.state))!.used_at).toBeNull();
    expect(await consume(tenantA, first.state, userA)).not.toBeNull();
    const usedAt = (await rowFor(first.state))!.used_at;
    expect(await consume(tenantA, first.state, userA)).toBeNull();
    expect((await rowFor(first.state))!.used_at).toEqual(usedAt);

    const expired = await create(tenantA, userA);
    await adminPool.query("UPDATE mail_oauth_states SET expires_at = now() - interval '1 second' WHERE id = $1", [
      (await rowFor(expired.state))!.id,
    ]);
    expect(await consume(tenantA, expired.state, userA)).toBeNull();
    expect((await rowFor(expired.state))!.used_at).toBeNull();

    expect(await consume(tenantA, "unknown-state", userA)).toBeNull();
  });

  it("lets exactly one of two racing consume calls succeed", async () => {
    const { state } = await create(tenantA, userA);
    let releaseFirst: () => void = () => undefined;
    const firstMayCommit = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstConsumed: () => void = () => undefined;
    const firstReady = new Promise<void>((resolve) => {
      firstConsumed = resolve;
    });
    let reportSecondPid: (pid: number) => void = () => undefined;
    const secondPid = new Promise<number>((resolve) => {
      reportSecondPid = resolve;
    });
    const first = runInTenant(tenantA, () =>
      withTransaction(pool, async (client) => {
        const result = await consumeMailOauthState(client, { state, userId: userA });
        firstConsumed();
        await firstMayCommit;
        return result;
      }),
    );
    let second: Promise<Awaited<ReturnType<typeof consumeMailOauthState>>> | undefined;
    let results: PromiseSettledResult<Awaited<ReturnType<typeof consumeMailOauthState>>>[];
    try {
      await Promise.race([
        firstReady,
        first.then(() => {
          throw new Error("First transaction ended before barrier");
        }),
      ]);
      second = runInTenant(tenantA, () =>
        withTransaction(pool, async (client) => {
          await client.query("SET LOCAL statement_timeout = '5s'");
          const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
          const pid = rows[0]?.pid;
          if (pid === undefined) throw new Error("Missing backend pid");
          reportSecondPid(pid);
          return consumeMailOauthState(client, { state, userId: userA });
        }),
      );
      const pid = await Promise.race([
        secondPid,
        second.then(() => {
          throw new Error("Second transaction ended before reporting pid");
        }),
      ]);
      const deadline = Date.now() + 3000;
      let blocked = false;
      while (Date.now() < deadline) {
        const { rows } = await adminPool.query<{ blocked: boolean }>(
          "SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked",
          [pid],
        );
        if (rows[0]?.blocked) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
    } finally {
      releaseFirst();
      results = await Promise.allSettled(second ? [first, second] : [first]);
    }
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ status: "fulfilled", value: { provider: "gmail" } });
    expect(results[1]).toEqual({ status: "fulfilled", value: null });
  });

  it("rejects a duplicate state hash within a tenant but permits it in a different tenant", async () => {
    const userB = await createUser(tenantB);
    const first = await create(tenantA, userA);
    const otherA = await create(tenantA, userA);
    const otherB = await create(tenantB, userB);
    const firstHash = createHash("sha256").update(first.state).digest("hex");
    const otherAHash = createHash("sha256").update(otherA.state).digest("hex");
    const otherBHash = createHash("sha256").update(otherB.state).digest("hex");
    await expect(
      runInTenant(tenantA, () =>
        withTransaction(pool, (client) =>
          client.query("UPDATE mail_oauth_states SET state_hash = $1 WHERE state_hash = $2", [firstHash, otherAHash]),
        ),
      ),
    ).rejects.toMatchObject({ code: "23505", constraint: "mail_oauth_states_state_hash_uq" });
    await runInTenant(tenantB, () =>
      withTransaction(pool, (client) =>
        client.query("UPDATE mail_oauth_states SET state_hash = $1 WHERE state_hash = $2", [firstHash, otherBHash]),
      ),
    );
    expect(await consume(tenantA, first.state, userA)).not.toBeNull();
    expect(await consume(tenantB, first.state, userB)).not.toBeNull();
    expect(await consume(tenantA, otherA.state, userA)).not.toBeNull();
  });

  it("stores neither the plaintext state nor the verifier, bound to tenant and row", async () => {
    const { state } = await create(tenantA, userA);
    const row = (await rowFor(state))!;
    const dump = JSON.stringify((await adminPool.query("SELECT * FROM mail_oauth_states")).rows);
    expect(dump).not.toContain(state);

    const consumed = (await consume(tenantA, state, userA))!;
    expect(row.code_verifier_ciphertext.toString("utf8")).not.toContain(consumed.codeVerifier);

    const keyA = await runInTenant(tenantA, () => withTransaction(pool, (c) => getOrCreateTenantDataKey(c)));
    const keyB = await runInTenant(tenantB, () => withTransaction(pool, (c) => getOrCreateTenantDataKey(c)));
    const sealed = { ciphertext: row.code_verifier_ciphertext, nonce: row.code_verifier_nonce };
    const ad = (tenant: string, id: string) => Buffer.from(`semprec:mail-oauth-state:v1:${tenant}:${id}`, "utf8");

    expect((await openSecret(sealed, keyA.dataKey, ad(tenantA, row.id))).toString("utf8")).toBe(consumed.codeVerifier);
    await expect(openSecret(sealed, keyB.dataKey, ad(tenantA, row.id))).rejects.toThrow();
    await expect(openSecret(sealed, keyA.dataKey, ad(tenantA, randomUUID()))).rejects.toThrow();
    await expect(openSecret(sealed, keyA.dataKey, ad(tenantB, row.id))).rejects.toThrow();
  });

  it("hides tenant A's rows from tenant B", async () => {
    const { state } = await create(tenantA, userA);
    const own = await runInTenant(tenantA, () =>
      withTransaction(pool, (client) => client.query("SELECT id FROM mail_oauth_states")),
    );
    expect(own.rows).toHaveLength(1);
    const visible = await runInTenant(tenantB, () =>
      withTransaction(pool, (client) => client.query("SELECT id FROM mail_oauth_states")),
    );
    expect(visible.rows).toHaveLength(0);
    const userB = await createUser(tenantB);
    expect(await consume(tenantB, state, userB)).toBeNull();
    expect((await rowFor(state))!.used_at).toBeNull();
  });

  it("excludes OAuth state rows from the actual tenant export archive", async () => {
    const created = await create(tenantA, userA);
    const stateRow = await rowFor(created.state);
    if (!stateRow) throw new Error("Missing OAuth state row");
    const consumed = await consume(tenantA, created.state, userA);
    if (!consumed) throw new Error("Expected OAuth state consumption");
    const root = await mkdtemp(join(tmpdir(), "semprec-oauth-export-"));
    try {
      const files = new LocalFsBlobStorageWriter(join(root, "files"));
      const mailAttachments = new LocalFsBlobStorageWriter(join(root, "mail"));
      const exportId = await runInTenant(tenantA, async () => {
        const request = await withTransaction(pool, (client) => requestTenantExport(client, userA));
        await handleTenantExportTask(pool, { files, mailAttachments }, { exportId: request.export.id }, {});
        return request.export.id;
      });
      const archive = await readFile(join(root, "files", tenantA, "exports", `${exportId}.zip`));
      const eocd = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
      if (eocd < 0) throw new Error("Missing ZIP central directory");
      const count = archive.readUInt16LE(eocd + 10);
      let offset = archive.readUInt32LE(eocd + 16);
      const names: string[] = [];
      for (let index = 0; index < count; index += 1) {
        if (archive.readUInt32LE(offset) !== 0x02014b50) throw new Error("Invalid ZIP central directory");
        const nameLength = archive.readUInt16LE(offset + 28);
        const extraLength = archive.readUInt16LE(offset + 30);
        const commentLength = archive.readUInt16LE(offset + 32);
        const method = archive.readUInt16LE(offset + 10);
        const size = archive.readUInt32LE(offset + 20);
        const localOffset = archive.readUInt32LE(offset + 42);
        const dataStart =
          localOffset + 30 + archive.readUInt16LE(localOffset + 26) + archive.readUInt16LE(localOffset + 28);
        const raw = archive.subarray(dataStart, dataStart + size);
        const content = method === 8 ? inflateRawSync(raw) : raw;
        expect(content.includes(Buffer.from(created.state))).toBe(false);
        expect(content.includes(Buffer.from(consumed.codeVerifier))).toBe(false);
        expect(content.includes(Buffer.from(createHash("sha256").update(created.state).digest("hex")))).toBe(false);
        expect(content.includes(stateRow.code_verifier_ciphertext)).toBe(false);
        names.push(archive.toString("utf8", offset + 46, offset + 46 + nameLength));
        offset += 46 + nameLength + extraLength + commentLength;
      }
      expect(names).toContain("tables/mail_account_sync_state.jsonl");
      expect(names).not.toContain("tables/mail_oauth_states.jsonl");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("sweeps expired and long-used rows of every tenant and keeps live ones", async () => {
    const userB = await createUser(tenantB);
    const states: Record<string, string> = {};
    for (const [name, tenant, user] of [
      ["expiredA", tenantA, userA],
      ["liveA", tenantA, userA],
      ["usedOldB", tenantB, userB],
      ["usedRecentB", tenantB, userB],
      ["expiredB", tenantB, userB],
    ] as const) {
      states[name] = (await create(tenant, user)).state;
    }
    const idOf = async (name: string) => (await rowFor(states[name]!))!.id;
    await adminPool.query("UPDATE mail_oauth_states SET expires_at = now() - interval '1 second' WHERE id = ANY($1)", [
      [await idOf("expiredA"), await idOf("expiredB")],
    ]);
    await adminPool.query("UPDATE mail_oauth_states SET used_at = now() - interval '2 hours' WHERE id = $1", [
      await idOf("usedOldB"),
    ]);
    await adminPool.query("UPDATE mail_oauth_states SET used_at = now() - interval '5 minutes' WHERE id = $1", [
      await idOf("usedRecentB"),
    ]);

    const result = await runAsSystem("test", () => handleMailOauthStatesSweepTask(pool));

    expect(result.deleted).toBe(3);
    expect(await rowFor(states.expiredA!)).toBeUndefined();
    expect(await rowFor(states.expiredB!)).toBeUndefined();
    expect(await rowFor(states.usedOldB!)).toBeUndefined();
    expect(await rowFor(states.liveA!)).toBeDefined();
    expect(await rowFor(states.usedRecentB!)).toBeDefined();
  });
});
