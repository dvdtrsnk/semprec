import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { createPool } from "../db/pool.js";
import { createRuntimeRolePool, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createTestTenant } from "../testSupport/tenantFixtures.js";
import { createUser } from "../auth/usersStore.js";
import { hashPassword } from "../auth/passwordHash.js";
import { MAX_LEDGER_BYTES, runReplayCommand } from "../tenancy/replayTenantDeletionsCommand.js";

let adminPool: Pool;
let workDir: string;
let openedPools: Pool[];
let out: string[];
let err: string[];
let openCalls: number;

async function tenantWithAdmin(): Promise<string> {
  const tenantId = await createTestTenant(adminPool);
  await createUser(adminPool, {
    email: `${randomUUID()}@example.test`,
    passwordHash: await hashPassword("s3cret-password"),
    tenantId,
    role: "admin",
  });
  return tenantId;
}

async function statusOf(tenantId: string): Promise<string | undefined> {
  const { rows } = await adminPool.query<{ status: string }>("SELECT status FROM tenants WHERE id = $1", [tenantId]);
  return rows[0]?.status;
}

async function ledgerFile(content: string): Promise<string> {
  const path = join(workDir, `ledger-${randomUUID()}`);
  await writeFile(path, content);
  return path;
}

function run(args: string[], options: { databaseUrl?: string | null } = {}) {
  return runReplayCommand({
    args,
    databaseUrl: options.databaseUrl === null ? undefined : (options.databaseUrl ?? "postgres://unused"),
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    openPool: () => {
      openCalls += 1;
      const pool = openedPools[0];
      if (!pool) throw new Error("no pool prepared");
      return pool;
    },
  });
}

describe("runReplayCommand (issue #1078)", () => {
  beforeAll(() => {
    adminPool = getTestPool();
  });

  afterAll(async () => {
    await adminPool?.end();
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
    workDir = await mkdtemp(join(tmpdir(), "semprec-test-replay-cli-"));
    openedPools = [await createRuntimeRolePool(adminPool, "semprec_data")];
    out = [];
    err = [];
    openCalls = 0;
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
    // A pool the command ended is ended already; ending it again is harmless for the pg Pool.
    await Promise.all(openedPools.map((pool) => pool.end().catch(() => undefined)));
  });

  it("exits 0, marks the listed tenants and ends the pool", async () => {
    await tenantWithAdmin();
    const target = await tenantWithAdmin();
    const endSpy = vi.spyOn(openedPools[0]!, "end");

    const code = await run([await ledgerFile(`${target}\n`)]);

    expect(code).toBe(0);
    expect(out).toEqual(["marked 1, alreadyDeleting 0, absent 0, refused 0"]);
    expect(err).toEqual([]);
    expect(await statusOf(target)).toBe("deleting");
    expect(endSpy).toHaveBeenCalledTimes(1);
  });

  it("exits 1 and prints the refused id when the only active admin's tenant is listed", async () => {
    const onlyAdmin = await tenantWithAdmin();
    const endSpy = vi.spyOn(openedPools[0]!, "end");

    const code = await run([await ledgerFile(`${onlyAdmin}\n`)]);

    expect(code).toBe(1);
    expect(out).toEqual(["marked 0, alreadyDeleting 0, absent 0, refused 1", `refused ${onlyAdmin} (lastAdmin)`]);
    expect(await statusOf(onlyAdmin)).toBe("active");
    expect(endSpy).toHaveBeenCalledTimes(1);
  });

  it("ends the pool and rethrows when the replay itself fails", async () => {
    const target = await tenantWithAdmin();
    const ledger = await ledgerFile(`${target}\n`);
    // Nothing listens on port 1, so the first query of the replay fails with a connection error.
    const unreachable = createPool("postgres://nobody@127.0.0.1:1/semprec");
    openedPools = [unreachable];
    const endSpy = vi.spyOn(unreachable, "end");

    await expect(run([ledger])).rejects.toThrow();

    expect(endSpy).toHaveBeenCalledTimes(1);
  });

  describe("bad input exits 2 without opening a pool", () => {
    const expectRejected = (message: RegExp) => {
      expect(openCalls).toBe(0);
      expect(out).toEqual([]);
      expect(err).toHaveLength(1);
      expect(err[0]).toMatch(message);
    };

    it("when DATABASE_URL is missing", async () => {
      expect(await run([await ledgerFile("")], { databaseUrl: null })).toBe(2);
      expectRejected(/DATABASE_URL/);
    });

    it("with no argument", async () => {
      expect(await run([])).toBe(2);
      expectRejected(/usage/);
    });

    it("with two arguments", async () => {
      const path = await ledgerFile("");
      expect(await run([path, path])).toBe(2);
      expectRejected(/usage/);
    });

    it("for a file that does not exist", async () => {
      expect(await run([join(workDir, "missing")])).toBe(2);
      expectRejected(/cannot use the ledger file/);
    });

    it("for a directory", async () => {
      expect(await run([workDir])).toBe(2);
      expectRejected(/cannot use the ledger file/);
    });

    it("for a FIFO, which has no size to cap", async () => {
      const fifo = join(workDir, "fifo");
      await promisify(execFile)("mkfifo", [fifo]);
      expect(await run([fifo])).toBe(2);
      expectRejected(/not a regular file/);
    });

    it("for a file over the size cap", async () => {
      expect(await run([await ledgerFile("a".repeat(MAX_LEDGER_BYTES + 1))])).toBe(2);
      expectRejected(/larger than/);
    });

    it("for a malformed ledger, leaving a listed tenant untouched", async () => {
      const tenant = await tenantWithAdmin();
      const other = await tenantWithAdmin();
      expect(await run([await ledgerFile(`${tenant}\nnot-a-uuid\n`)])).toBe(2);
      expectRejected(/line 2/);
      expect(await statusOf(tenant)).toBe("active");
      expect(await statusOf(other)).toBe("active");
    });
  });

  describe("documented offline activation", () => {
    async function invokeActivation(ledger: string): Promise<void> {
      const baseUrl = process.env.TEST_DATABASE_URL;
      if (!baseUrl) throw new Error("Missing isolated test database URL");
      const password = randomUUID();
      // The password is a generated UUID and the role name is fixed, so interpolation is closed.
      await adminPool.query(`ALTER ROLE semprec_data WITH PASSWORD '${password}'`);
      const url = new URL(baseUrl);
      url.username = "semprec_data";
      url.password = password;
      const backend = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
      await promisify(execFile)(
        "bash",
        [join(backend, "../deploy/systemd/scripts/semprec-restore-activation.test.sh")],
        {
          env: {
            ...process.env,
            NODE_OPTIONS: undefined,
            NODE_PATH: undefined,
            TEST_ACTIVATION_NODE: process.execPath,
            TEST_ACTIVATION_NATIVE_DIR: join(backend, "packages/data/dist/tenancy"),
            TEST_ACTIVATION_DATABASE_URL: url.toString(),
            TEST_ACTIVATION_LEDGER_ID: ledger,
            TEST_ACTIVATION_RESULT: join(workDir, "activated"),
          },
        },
      );
    }

    it("keeps the last admin offline and starts only after a real replay retry succeeds", async () => {
      const lastAdmin = await tenantWithAdmin();
      await expect(invokeActivation(lastAdmin)).rejects.toMatchObject({ stdout: expect.stringContaining("lastAdmin") });
      expect(existsSync(join(workDir, "activated"))).toBe(false);
      expect(await statusOf(lastAdmin)).toBe("active");
      await tenantWithAdmin();
      await invokeActivation(lastAdmin);
      expect(await statusOf(lastAdmin)).toBe("deleting");
      expect(readFileSync(join(workDir, "activated"), "utf8").trim()).toBe(
        "start semprec-api.service semprec-agents.service semprec-transcribe.service semprec-ai-gateway.service",
      );
    }, 180_000);

    it("keeps services offline on malformed evidence and unexpected status", async () => {
      const target = await createTestTenant(adminPool, { status: "provisioning" });
      await expect(invokeActivation("invalid-ledger")).rejects.toThrow();
      expect(existsSync(join(workDir, "activated"))).toBe(false);
      await expect(invokeActivation(target)).rejects.toMatchObject({
        stdout: expect.stringContaining("unexpectedStatus"),
      });
      expect(existsSync(join(workDir, "activated"))).toBe(false);
      expect(await statusOf(target)).toBe("provisioning");
    }, 180_000);
  });

  it("accepts a file of exactly the size cap", async () => {
    // Blank lines only: within the cap, so it is read and parsed to an empty ledger.
    const code = await run([await ledgerFile("\n".repeat(MAX_LEDGER_BYTES))]);

    expect(code).toBe(0);
    expect(out).toEqual(["marked 0, alreadyDeleting 0, absent 0, refused 0"]);
  });
});
