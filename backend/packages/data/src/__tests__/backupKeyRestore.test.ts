import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runInTenant } from "@semprec/shared";
import { withTransaction } from "../db/pool.js";
import { restoreTenantKeys, RestoreStageUncertainError } from "../tenancy/restoreTenantKeys.js";
import { RestorePostgresTools } from "../tenancy/restorePostgresTools.js";
import {
  createBackupRecoveryFixture,
  createStartResponseInterruptionProxy,
  type BackupRecoveryFixture,
} from "./fixtures/backupRecovery.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
let fixture: BackupRecoveryFixture;
let admin: Pool;
let runtime: Pool;
let archive: Buffer;
let mainArchive: Buffer;
let targetUrl: string;

async function sql(database: string, text: string): Promise<void> {
  await fixture.exec(
    ["psql", "--username=postgres", `--dbname=${database}`, "--no-psqlrc", "--set=ON_ERROR_STOP=1"],
    Buffer.from(text),
  );
}

beforeAll(async () => {
  fixture = await createBackupRecoveryFixture();
  await sql(
    "postgres",
    `
    CREATE ROLE semprec_restore NOLOGIN NOSUPERUSER NOBYPASSRLS;
    CREATE TABLE public.tenants (id uuid PRIMARY KEY);
    CREATE TABLE public.tenant_deletions (tenant_id uuid PRIMARY KEY);
    CREATE TABLE public.items (updated_at timestamptz NOT NULL);
    INSERT INTO public.items VALUES (now());
    CREATE TABLE public.doc_snapshots (state bytea NOT NULL);
    INSERT INTO public.doc_snapshots VALUES (decode('01','hex'));
    CREATE TABLE public.blobs (storage_key text, content_hash text, byte_size bigint);
    CREATE FUNCTION public.app_tenant_default() RETURNS uuid LANGUAGE sql STABLE
      AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;
    CREATE TABLE public.tenant_keys (
      tenant_id uuid PRIMARY KEY REFERENCES public.tenants(id), wrapped_key bytea NOT NULL,
      wrap_nonce bytea NOT NULL, master_key_version smallint NOT NULL, created_at timestamptz NOT NULL
    );
    ALTER TABLE public.tenant_keys ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON public.tenant_keys AS RESTRICTIVE
      USING (tenant_id = (SELECT public.app_tenant_default()))
      WITH CHECK (tenant_id = (SELECT public.app_tenant_default()));
    CREATE POLICY tenant_rows ON public.tenant_keys AS PERMISSIVE USING (true) WITH CHECK (true);
    INSERT INTO public.tenants VALUES ('${A}'), ('${B}');
    INSERT INTO public.tenant_keys VALUES
      ('${A}', decode(repeat('01',48),'hex'), decode(repeat('02',24),'hex'), 3, '2026-01-02 03:04:05.123456+00'),
      ('${B}', decode(repeat('03',48),'hex'), decode(repeat('04',24),'hex'), 4, '2026-01-02 03:04:05.654321+00');
  `,
  );
  mainArchive = await fixture.exec([
    "pg_dump",
    "--username=postgres",
    "--dbname=postgres",
    "--format=custom",
    "--exclude-table-data=public.tenant_keys",
  ]);
  await sql(
    "postgres",
    `
    INSERT INTO public.tenants VALUES ('${C}');
    INSERT INTO public.tenant_keys VALUES
      ('${C}', decode(repeat('05',48),'hex'), decode(repeat('06',24),'hex'), 5, '2026-01-02 03:04:05+00');
    DELETE FROM public.tenant_keys WHERE tenant_id = '${B}';
    CREATE DATABASE restored_main;
  `,
  );
  archive = await fixture.exec([
    "pg_dump",
    "--username=postgres",
    "--dbname=postgres",
    "--format=custom",
    "--data-only",
    "--table=public.tenant_keys",
  ]);
  await fixture.exec(
    ["pg_restore", "--username=postgres", "--dbname=restored_main", "--exit-on-error", "--no-owner", "--no-privileges"],
    mainArchive,
  );
  await sql(
    "restored_main",
    `
    GRANT USAGE ON SCHEMA public TO semprec_restore;
    GRANT SELECT ON public.tenants TO semprec_restore;
    GRANT SELECT, INSERT ON public.tenant_keys TO semprec_restore;
    GRANT EXECUTE ON FUNCTION public.app_tenant_default() TO semprec_restore;
  `,
  );
  const target = new URL(fixture.adminUrl);
  target.pathname = "/restored_main";
  targetUrl = target.toString();
  admin = new Pool({ connectionString: targetUrl });
  runtime = new Pool({ connectionString: targetUrl, options: "-c role=semprec_restore" });
}, 120_000);

afterAll(async () => {
  const failures: unknown[] = [];
  try {
    await runtime?.end();
  } catch (error) {
    failures.push(error);
  }
  try {
    await admin?.end();
  } catch (error) {
    failures.push(error);
  }
  try {
    await fixture?.close();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length) throw new AggregateError(failures, "Recovery fixture cleanup failed");
}, 120_000);

describe("offline compatible tenant keys", () => {
  it("rejects a malformed archive before creating staging state", async () => {
    let stageAttempted = false;
    await expect(
      restoreTenantKeys({
        adminUrl: targetUrl,
        targetUrl,
        targetRole: "semprec_restore",
        container: fixture.containerId,
        archive: Buffer.from("invalid"),
        recordStage: async () => {
          stageAttempted = true;
        },
      }),
    ).rejects.toThrow("Restore exec failed");
    expect(stageAttempted).toBe(false);
  }, 120_000);

  it("rejects malformed staged row shape and removes its owned stage", async () => {
    await sql(
      "postgres",
      `UPDATE tenant_keys SET wrapped_key = decode(repeat('01',47),'hex') WHERE tenant_id = '${A}'`,
    );
    const malformed = await fixture.exec([
      "pg_dump",
      "--username=postgres",
      "--dbname=postgres",
      "--format=custom",
      "--data-only",
      "--table=public.tenant_keys",
    ]);
    await sql(
      "postgres",
      `UPDATE tenant_keys SET wrapped_key = decode(repeat('01',48),'hex') WHERE tenant_id = '${A}'`,
    );
    let stageName: string | undefined;
    await expect(
      restoreTenantKeys({
        adminUrl: targetUrl,
        targetUrl,
        targetRole: "semprec_restore",
        container: fixture.containerId,
        archive: malformed,
        recordStage: async (name) => {
          stageName = name;
        },
      }),
    ).rejects.toThrow();
    expect(stageName).toMatch(/^semprec_restore_[a-f0-9]{32}$/);
    const absent = await admin.query<{ present: boolean }>(
      "SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=$1) AS present",
      [stageName],
    );
    expect(absent.rows[0]?.present).toBe(false);
    const keys = await admin.query<{ count: string }>("SELECT count(*)::text AS count FROM tenant_keys");
    expect(keys.rows[0]?.count).toBe("0");
    console.info(`RECOVERY_BAD_ROW stage=${stageName} absent=true`);
  }, 120_000);

  it("rejects a different target database before staging", async () => {
    let attempted = false;
    await expect(
      restoreTenantKeys({
        adminUrl: targetUrl,
        targetUrl: fixture.adminUrl,
        targetRole: "semprec_restore",
        container: fixture.containerId,
        archive,
        recordStage: async () => {
          attempted = true;
        },
      }),
    ).rejects.toThrow("Restore database identities do not match");
    expect(attempted).toBe(false);
  }, 120_000);

  it("fails closed when an owned stage cannot be dropped and proves later removal", async () => {
    let stageName: string | undefined;
    let holder: Client | undefined;
    let stopped = false;
    let watcher: Promise<void> | undefined;
    let failure: { value: unknown } | undefined;
    try {
      await expect(
        restoreTenantKeys({
          adminUrl: targetUrl,
          targetUrl,
          targetRole: "semprec_restore",
          container: fixture.containerId,
          archive,
          recordStage: async (name) => {
            stageName = name;
            watcher = (async () => {
              while (!stopped) {
                const result = await admin.query<{ present: boolean }>(
                  "SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1) AS present",
                  [name],
                );
                if (result.rows[0]?.present) {
                  const url = new URL(fixture.adminUrl);
                  url.pathname = `/${name}`;
                  const candidate = new Client({ connectionString: url.toString(), connectionTimeoutMillis: 1000 });
                  try {
                    await candidate.connect();
                    holder = candidate;
                    return;
                  } catch (error) {
                    try {
                      await candidate.end();
                    } catch (cleanupError) {
                      throw new AggregateError([error, cleanupError], "Stage watcher cleanup failed", {
                        cause: cleanupError,
                      });
                    }
                    if (!(error instanceof Error && "code" in error && error.code === "3D000")) throw error;
                  }
                }
                await new Promise((resolveWait) => setTimeout(resolveWait, 5));
              }
            })();
          },
        }),
      ).rejects.toBeInstanceOf(RestoreStageUncertainError);
      expect(holder).toBeDefined();
    } catch (error) {
      failure = { value: error };
    }
    stopped = true;
    const cleanup: unknown[] = [];
    try {
      await watcher;
    } catch (error) {
      cleanup.push(error);
    }
    try {
      await holder?.end();
    } catch (error) {
      cleanup.push(error);
    }
    if (stageName) {
      try {
        if (!/^semprec_restore_[a-f0-9]{32}$/.test(stageName)) throw new Error("Invalid owned stage identity");
        // The stage name is a fixed prefix and UUID hex digits.
        await admin.query(`DROP DATABASE IF EXISTS "${stageName}"`);
        const absence = await admin.query<{ present: boolean }>(
          "SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1) AS present",
          [stageName],
        );
        expect(absence.rows[0]?.present).toBe(false);
        console.info(`RECOVERY_CLEANUP_FAILURE stage=${stageName} absent=true`);
      } catch (error) {
        cleanup.push(error);
      }
    }
    try {
      await admin.query("DELETE FROM tenant_keys");
    } catch (error) {
      cleanup.push(error);
    }
    if (cleanup.length)
      throw new AggregateError(failure ? [failure.value, ...cleanup] : cleanup, "Stage fixture cleanup failed");
    if (failure) throw failure.value;
  }, 120_000);

  it("restores matching bytes and timestamp, excludes newer tenants, and leaves erased keys absent", async () => {
    let stageName: string | undefined;
    await restoreTenantKeys({
      adminUrl: targetUrl,
      targetUrl,
      targetRole: "semprec_restore",
      container: fixture.containerId,
      archive,
      recordStage: async (name) => {
        stageName = name;
      },
    });
    expect(stageName).toMatch(/^semprec_restore_[a-f0-9]{32}$/);
    const absent = await admin.query<{ present: boolean }>(
      "SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1) AS present",
      [stageName],
    );
    expect(absent.rows[0]?.present).toBe(false);
    console.info(`RECOVERY_KEY_STAGE stage=${stageName} absent=true`);
    const rows = await admin.query<{
      tenant_id: string;
      wrapped: string;
      nonce: string;
      version: number;
      created: string;
    }>(
      "SELECT tenant_id::text, encode(wrapped_key,'hex') AS wrapped, encode(wrap_nonce,'hex') AS nonce, master_key_version AS version, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') AS created FROM tenant_keys ORDER BY tenant_id",
    );
    expect(rows.rows).toEqual([
      {
        tenant_id: A,
        wrapped: "01".repeat(48),
        nonce: "02".repeat(24),
        version: 3,
        created: "2026-01-02 03:04:05.123456",
      },
    ]);
    await expect(
      runInTenant(C, () =>
        withTransaction(runtime, (client) =>
          client.query("INSERT INTO tenant_keys VALUES ($1, $2, $3, 1, now())", [
            C,
            Buffer.alloc(48),
            Buffer.alloc(24),
          ]),
        ),
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      runInTenant(A, () =>
        withTransaction(runtime, (client) =>
          client.query("INSERT INTO tenant_keys VALUES ($1, $2, $3, 1, now())", [
            B,
            Buffer.alloc(48),
            Buffer.alloc(24),
          ]),
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  }, 120_000);
  it("runs the compiled offline owner against the selected PostgreSQL 16 instance", async () => {
    const database = "restored_cli";
    const work = await mkdtemp(join(tmpdir(), "semprec-key-cli-"));
    const archivePath = join(work, "tenant-keys.dump");
    const badArchive = join(work, "malformed.dump");
    const receipt = join(work, "receipt");
    let created = false;
    let target: Pool | undefined;
    let failure: { value: unknown } | undefined;
    const cleanup: unknown[] = [];
    try {
      await admin.query("CREATE DATABASE restored_cli");
      created = true;
      await fixture.exec(
        [
          "pg_restore",
          "--username=postgres",
          "--dbname=restored_cli",
          "--exit-on-error",
          "--no-owner",
          "--no-privileges",
        ],
        mainArchive,
      );
      await sql(
        "restored_cli",
        `GRANT USAGE ON SCHEMA public TO semprec_restore;
        GRANT SELECT ON public.tenants TO semprec_restore;
        GRANT SELECT, INSERT ON public.tenant_keys TO semprec_restore;
        GRANT EXECUTE ON FUNCTION public.app_tenant_default() TO semprec_restore`,
      );
      const url = new URL(fixture.adminUrl);
      url.pathname = `/${database}`;
      target = new Pool({ connectionString: url.toString() });
      await writeFile(archivePath, archive, { mode: 0o600, flag: "wx" });
      const backend = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
      await writeFile(badArchive, "synthetic secret marker", { mode: 0o600, flag: "wx" });
      const runOwner = (path: string): Promise<{ code: number | null; stdout: string; stderr: string }> =>
        new Promise((resolveChild, reject) => {
          const child = spawn(
            process.execPath,
            [join(backend, "packages/data/dist/tenancy/restoreTenantKeysCli.js"), path],
            {
              cwd: backend,
              env: {
                ...process.env,
                NODE_OPTIONS: undefined,
                NODE_PATH: undefined,
                SEMPREC_RESTORE_ADMIN_URL: url.toString(),
                SEMPREC_RESTORE_TARGET_URL: url.toString(),
                SEMPREC_RESTORE_TARGET_ROLE: "semprec_restore",
                SEMPREC_RESTORE_CONTAINER: fixture.containerId,
                SEMPREC_RESTORE_RECEIPT: receipt,
              },
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          const stdout: Buffer[] = [];
          const stderr: Buffer[] = [];
          let bytes = 0;
          let childFailure: { value: unknown } | undefined;
          const collect = (targetChunks: Buffer[], chunk: Buffer): void => {
            bytes += chunk.length;
            if (bytes <= 1_000_000) targetChunks.push(chunk);
          };
          child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
          child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
          child.on("error", (error) => {
            childFailure = { value: error };
          });
          child.on("close", (code, signal) => {
            console.info(
              `RECOVERY_KEY_CLI pid=${String(child.pid)} exit=${String(code)} signal=${String(signal)} bytes=${bytes}`,
            );
            if (childFailure) reject(new Error("Compiled key owner failed", { cause: childFailure.value }));
            else if (signal !== null || bytes > 1_000_000) reject(new Error("Compiled key owner failed"));
            else
              resolveChild({
                code,
                stdout: Buffer.concat(stdout).toString("utf8"),
                stderr: Buffer.concat(stderr).toString("utf8"),
              });
          });
        });
      const refused = await runOwner(badArchive);
      expect(refused).toEqual({ code: 1, stdout: "", stderr: "Offline key restore failed\n" });
      const success = await runOwner(archivePath);
      expect(success).toEqual({ code: 0, stdout: "", stderr: "" });
      const rows = await target.query<{ tenant_id: string }>(
        "SELECT tenant_id::text FROM tenant_keys ORDER BY tenant_id",
      );
      expect(rows.rows).toEqual([{ tenant_id: A }]);
    } catch (error) {
      failure = { value: error };
    }
    try {
      await target?.end();
    } catch (error) {
      cleanup.push(error);
    }
    if (created) {
      try {
        await admin.query("DROP DATABASE restored_cli");
        const absent = await admin.query<{ present: boolean }>(
          "SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = 'restored_cli') AS present",
        );
        expect(absent.rows[0]?.present).toBe(false);
        console.info("RECOVERY_KEY_CLI_DB absent=true");
      } catch (error) {
        cleanup.push(error);
      }
    }
    try {
      await rm(work, { recursive: true, force: true });
    } catch (error) {
      cleanup.push(error);
    }
    if (cleanup.length)
      throw new AggregateError(
        failure ? [failure.value, ...cleanup] : cleanup,
        "Compiled key owner fixture cleanup failed",
      );
    if (failure) throw failure.value;
  }, 120_000);

  it("runs the monthly script with real owned bridge, compiled owner and synthetic snapshots", async () => {
    const work = await mkdtemp(join(tmpdir(), "semprec-monthly-real-"));
    const bin = join(work, "bin");
    const restoreRoot = join(work, "restore");
    const files = join(work, "files");
    const mail = join(work, "mail");
    const mainPath = join(work, "main.dump");
    const keyPath = join(work, "keys.dump");
    const scriptPath = join(work, "restore-test.sh");
    const results = join(work, "results");
    const pings = join(work, "pings");
    const backend = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
    const repo = resolve(backend, "..");
    let failure: { value: unknown } | undefined;
    try {
      await Promise.all([mkdir(bin), mkdir(restoreRoot), mkdir(files), mkdir(mail)]);
      await writeFile(mainPath, mainArchive, { mode: 0o600, flag: "wx" });
      await writeFile(keyPath, archive, { mode: 0o600, flag: "wx" });
      const original = await readFile(join(repo, "deploy/systemd/scripts/semprec-restore-test.sh"), "utf8");
      const rewritten = original
        .replace("readonly RESTORE_ROOT=/var/tmp", `readonly RESTORE_ROOT=${restoreRoot}`)
        .replace(
          "readonly RESULT_CLI=/opt/semprec/current/backend/packages/data/dist/observability/restoreTestResultCli.js",
          "readonly RESULT_CLI=/synthetic/restoreTestResultCli.js",
        )
        .replace(
          "readonly KEY_RESTORE_CLI=/opt/semprec/current/backend/packages/data/dist/tenancy/restoreTenantKeysCli.js",
          `readonly KEY_RESTORE_CLI=${join(backend, "packages/data/dist/tenancy/restoreTenantKeysCli.js")}`,
        )
        .replace(
          "readonly LEDGER_VALIDATOR=/opt/semprec/current/backend/packages/data/dist/tenancy/validateRestoreLedgerCli.js",
          `readonly LEDGER_VALIDATOR=${join(backend, "packages/data/dist/tenancy/validateRestoreLedgerCli.js")}`,
        )
        .replace(
          "readonly POSTGRES_IMAGE=postgres:16-alpine",
          "readonly POSTGRES_IMAGE=sha256:f4610795587492cd4fb887c2dc3de301b813278bb6f616992061141b5f15ac36",
        );
      if (rewritten === original || rewritten.includes("readonly RESTORE_ROOT=/var/tmp"))
        throw new Error("Monthly fixture did not select its owned paths");
      await writeFile(scriptPath, rewritten, { mode: 0o700, flag: "wx" });
      await writeFile(
        join(bin, "restic"),
        `#!/bin/bash
set -euo pipefail
target="\${!#}"
mkdir -p "$target/var/backups/semprec"
if [[ " $* " == *" /var/backups/semprec/tenant-keys.dump "* ]]; then
  cp "$TEST_KEYS" "$target/var/backups/semprec/tenant-keys.dump"
else
  cp "$TEST_MAIN" "$target/var/backups/semprec/postgres.dump"
  : > "$target/var/backups/semprec/tenant-deletions.ledger"
fi
`,
        { mode: 0o700 },
      );
      await writeFile(
        join(bin, "node"),
        `#!/bin/bash
set -euo pipefail
if [[ "$1" == /synthetic/restoreTestResultCli.js ]]; then shift; printf '%s\n' "$*" >> "$TEST_RESULTS"; exit 0; fi
exec "$TEST_NODE" "$@"
`,
        { mode: 0o700 },
      );
      await writeFile(join(bin, "timeout"), '#!/bin/bash\nshift\nexec "$@"\n', { mode: 0o700 });
      await writeFile(join(bin, "curl"), '#!/bin/bash\nprintf "%s\\n" "${!#}" >> "$TEST_PINGS"\n', { mode: 0o700 });
      await Promise.all(["restic", "node", "timeout", "curl"].map((name) => chmod(join(bin, name), 0o700)));
      await new Promise<void>((resolveChild, reject) => {
        const child = spawn("bash", [scriptPath], {
          cwd: backend,
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ""}`,
            NODE_OPTIONS: undefined,
            NODE_PATH: undefined,
            RESTIC_REPOSITORY: "synthetic",
            RESTIC_PASSWORD: "synthetic",
            AWS_ACCESS_KEY_ID: "synthetic",
            AWS_SECRET_ACCESS_KEY: "synthetic",
            FILES_STORAGE_DIR: files,
            MAIL_ATTACHMENTS_DIR: mail,
            SEMPREC_SIDE_DATABASE_URL: "postgres://synthetic",
            HEALTHCHECKS_RESTORE_PING_URL: "https://example.invalid/test",
            TEST_MAIN: mainPath,
            TEST_KEYS: keyPath,
            TEST_RESULTS: results,
            TEST_PINGS: pings,
            TEST_NODE: process.execPath,
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let outputBytes = 0;
        const stdout: Buffer[] = [];
        let childFailure: { value: unknown } | undefined;
        child.stdout.on("data", (chunk: Buffer) => {
          outputBytes += chunk.length;
          if (outputBytes <= 1_000_000) stdout.push(chunk);
        });
        child.stderr.on("data", (chunk: Buffer) => {
          outputBytes += chunk.length;
        });
        child.on("error", (error) => {
          childFailure = { value: error };
        });
        child.on("close", (code, signal) => {
          console.info(
            `RECOVERY_MONTHLY pid=${String(child.pid)} exit=${String(code)} signal=${String(signal)} bytes=${outputBytes}`,
          );
          if (childFailure) reject(new Error("Monthly fixture failed", { cause: childFailure.value }));
          else if (code !== 0 || signal !== null || outputBytes > 1_000_000)
            reject(new Error("Monthly fixture failed"));
          else {
            const match = /restore test ([0-9]{8}T[0-9]{6}Z-[0-9]+) passed/.exec(
              Buffer.concat(stdout).toString("utf8"),
            );
            if (!match?.[1]) reject(new Error("Monthly fixture success identity is missing"));
            else {
              console.info(`RECOVERY_MONTHLY_CLEANUP run=${match[1]} absent=true`);
              resolveChild();
            }
          }
        });
      });
      expect(await readFile(results, "utf8")).toMatch(/^passed /);
      expect(await readFile(pings, "utf8")).toBe("https://example.invalid/test\n");
      expect(await readdir(restoreRoot)).toEqual([]);
    } catch (error) {
      failure = { value: error };
    }
    if (failure) throw failure.value;
    await rm(work, { recursive: true, force: true });
  }, 180_000);

  it("retains an interrupted Docker exec until its held database operation settles", async () => {
    const database = `semprec_restore_${randomUUID().replaceAll("-", "")}`;
    // The database name is a fixed prefix and UUID hex digits.
    await sql("postgres", `CREATE DATABASE "${database}"`);
    await sql(
      database,
      `CREATE TABLE public.tenant_keys (
      tenant_id uuid PRIMARY KEY, wrapped_key bytea NOT NULL, wrap_nonce bytea NOT NULL,
      master_key_version smallint NOT NULL, created_at timestamptz NOT NULL)`,
    );
    const stageUrl = new URL(fixture.adminUrl);
    stageUrl.pathname = `/${database}`;
    const lock = new Client({ connectionString: stageUrl.toString() });
    const tools = await RestorePostgresTools.connect(fixture.containerId);
    const selection = await tools.inspectArchive(archive);
    const controller = new AbortController();
    let settled = false;
    let operation: Promise<unknown> | undefined;
    let failure: { value: unknown } | undefined;
    const cleanup: unknown[] = [];
    let connected = false;
    try {
      await lock.connect();
      connected = true;
      await lock.query("BEGIN");
      await lock.query("LOCK TABLE public.tenant_keys IN ACCESS EXCLUSIVE MODE");
      operation = tools.restoreArchive(database, archive, selection, controller.signal).then(
        () => {
          settled = true;
          return undefined;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      let execId: string | undefined;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const pending = tools.pendingExecIds();
        const running = await fixture.runningExecIds();
        const current = pending[0];
        if (current && running.includes(current)) {
          const state = await admin.query<{ waiting: boolean }>(
            "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock') AS waiting",
            [database],
          );
          if (state.rows[0]?.waiting) {
            execId = current;
            break;
          }
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      }
      if (!execId) throw new Error("Did not observe the owned held restore exec");
      console.info(`RECOVERY_HELD_OUTPUT exec=${execId} stage=${database}`);
      controller.abort();
      await new Promise((resolveWait) => setTimeout(resolveWait, 300));
      expect(settled).toBe(false);
      expect(tools.pendingExecIds()).toContain(execId);
      expect(await fixture.runningExecIds()).toContain(execId);
    } catch (error) {
      failure = { value: error };
    }
    if (connected) {
      try {
        await lock.query("ROLLBACK");
      } catch (error) {
        cleanup.push(error);
      }
      try {
        await lock.end();
      } catch (error) {
        cleanup.push(error);
      }
    }
    const outcome = operation ? await operation : undefined;
    try {
      if (operation) expect(outcome).toBeInstanceOf(Error);
      expect(tools.pendingExecIds()).toEqual([]);
      expect(await fixture.runningExecIds()).toEqual([]);
      await sql("postgres", `DROP DATABASE "${database}"`);
      const absence = await admin.query<{ present: boolean }>(
        "SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1) AS present",
        [database],
      );
      expect(absence.rows[0]?.present).toBe(false);
      console.info(`RECOVERY_HELD_OUTPUT_SETTLED stage=${database} absent=true`);
    } catch (error) {
      cleanup.push(error);
    }
    if (cleanup.length)
      throw new AggregateError(failure ? [failure.value, ...cleanup] : cleanup, "Held exec cleanup failed");
    if (failure) throw failure.value;
  }, 120_000);
  it("retains an exec when its start response is lost until the daemon finishes", async () => {
    const database = `semprec_restore_${randomUUID().replaceAll("-", "")}`;
    // The database name is a fixed prefix and UUID hex digits.
    await sql("postgres", `CREATE DATABASE "${database}"`);
    await sql(
      database,
      `CREATE TABLE public.tenant_keys (
      tenant_id uuid PRIMARY KEY, wrapped_key bytea NOT NULL, wrap_nonce bytea NOT NULL,
      master_key_version smallint NOT NULL, created_at timestamptz NOT NULL)`,
    );
    const direct = await RestorePostgresTools.connect(fixture.containerId);
    const selection = await direct.inspectArchive(archive);
    let tools: RestorePostgresTools | undefined;
    const proxy = await createStartResponseInterruptionProxy(fixture.containerId, () => tools?.pendingExecIds() ?? []);
    const oldHost = process.env.DOCKER_HOST;
    const oldContext = process.env.DOCKER_CONTEXT;
    process.env.DOCKER_HOST = proxy.endpoint;
    delete process.env.DOCKER_CONTEXT;
    let operation: Promise<unknown> | undefined;
    let held = false;
    let failure: { value: unknown } | undefined;
    const cleanup: unknown[] = [];
    try {
      tools = await RestorePostgresTools.connect(fixture.containerId);
      let settled = false;
      operation = tools.restoreArchive(database, archive, selection).then(
        () => {
          settled = true;
          return undefined;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      const observed = await Promise.race([
        proxy.held.then(() => true),
        operation.then(() => false),
        new Promise<boolean>((_resolve, reject) =>
          setTimeout(() => reject(new Error("Start response was not observed")), 10_000),
        ),
      ]);
      if (!observed) throw new Error("Start completed before response interruption");
      held = true;
      const execId = tools.pendingExecIds()[0];
      if (!execId) throw new Error("Missing owned start exec identity");
      expect(await tools.isExecRunning(execId)).toBe(true);
      console.info(`RECOVERY_HELD_START exec=${execId} stage=${database}`);
      proxy.dropClient();
      await new Promise((resolveWait) => setTimeout(resolveWait, 600));
      expect(settled).toBe(false);
      expect(tools.pendingExecIds()).toContain(execId);
      expect(await tools.isExecRunning(execId)).toBe(true);
    } catch (error) {
      failure = { value: error };
    }
    let proxyClosed = false;
    if (held) {
      try {
        proxy.releaseDaemon();
      } catch (error) {
        cleanup.push(error);
      }
    } else {
      try {
        await proxy.close();
        proxyClosed = true;
      } catch (error) {
        cleanup.push(error);
      }
    }
    const outcome = operation ? await operation : undefined;
    try {
      if (operation) expect(outcome).toBeInstanceOf(Error);
      expect(tools?.pendingExecIds()).toEqual([]);
      console.info(`RECOVERY_HELD_START_SETTLED stage=${database}`);
    } catch (error) {
      cleanup.push(error);
    }
    if (oldHost === undefined) delete process.env.DOCKER_HOST;
    else process.env.DOCKER_HOST = oldHost;
    if (oldContext === undefined) delete process.env.DOCKER_CONTEXT;
    else process.env.DOCKER_CONTEXT = oldContext;
    if (!proxyClosed) {
      try {
        await proxy.close();
      } catch (error) {
        cleanup.push(error);
      }
    }
    try {
      await sql("postgres", `DROP DATABASE "${database}"`);
      const absence = await admin.query<{ present: boolean }>(
        "SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1) AS present",
        [database],
      );
      expect(absence.rows[0]?.present).toBe(false);
      console.info(`RECOVERY_HELD_START_ABSENT stage=${database}`);
    } catch (error) {
      cleanup.push(error);
    }
    if (cleanup.length)
      throw new AggregateError(failure ? [failure.value, ...cleanup] : cleanup, "Start interruption cleanup failed");
    if (failure) throw failure.value;
  }, 120_000);
});

const dockerCommand = promisify(execFile);
const controlImage = "sha256:f4610795587492cd4fb887c2dc3de301b813278bb6f616992061141b5f15ac36";

describe("fixture resource identity", () => {
  for (const mode of ["network-race", "network-unknown", "container-race", "container-unknown"] as const) {
    it(`preserves ${mode} until its independent owner cleans it`, async () => {
      const work = await mkdtemp(join(tmpdir(), "semprec-identity-control-"));
      const previous = { ...process.env };
      const docker = (await dockerCommand("which", ["docker"])).stdout.trim();
      const networkFile = join(work, "network-id");
      const containerFile = join(work, "container-id");
      let failure: { value: unknown } | undefined;
      try {
        await writeFile(
          join(work, "docker"),
          `#!/bin/bash
set -euo pipefail
printf '%s\n' "$*" >> "$IDENTITY_TEST_DIR/calls"
if [[ "$1 $2" == "network create" ]]; then
  id=$("$REAL_TEST_DOCKER" "$@")
  printf '%s\n' "$id" > "$IDENTITY_TEST_DIR/network-id"
  if [[ "$IDENTITY_TEST_MODE" == network-race ]]; then exit 51; fi
  if [[ "$IDENTITY_TEST_MODE" == network-unknown ]]; then exit 51; fi
  printf '%s\n' "$id"; exit 0
fi
if [[ "$1" == run && "$IDENTITY_TEST_MODE" == container-race ]]; then
  id=$("$REAL_TEST_DOCKER" create --name "$4" --network none "${controlImage}")
  printf '%s\n' "$id" > "$IDENTITY_TEST_DIR/container-id"
  exec "$REAL_TEST_DOCKER" "$@"
fi
if [[ "$1" == run && "$IDENTITY_TEST_MODE" == container-unknown ]]; then
  id=$("$REAL_TEST_DOCKER" "$@")
  printf '%s\n' "$id" > "$IDENTITY_TEST_DIR/container-id"
  exit 52
fi
exec "$REAL_TEST_DOCKER" "$@"
`,
          { mode: 0o700 },
        );
        process.env.PATH = `${work}:${previous.PATH ?? ""}`;
        process.env.TMPDIR = work;
        process.env.REAL_TEST_DOCKER = docker;
        process.env.IDENTITY_TEST_DIR = work;
        process.env.IDENTITY_TEST_MODE = mode;
        await expect(createBackupRecoveryFixture()).rejects.toThrow("Recovery fixture setup and cleanup failed");
        const calls = await readFile(join(work, "calls"), "utf8");
        expect(calls).not.toMatch(/^(?:rm |network rm )/m);
        const kind = mode.startsWith("network") ? "network" : "container";
        const id = (await readFile(kind === "network" ? networkFile : containerFile, "utf8")).trim();
        expect(id).toMatch(/^[a-f0-9]{64}$/);
        expect((await dockerCommand(docker, [kind, "inspect", "--format", "{{.Id}}", id])).stdout.trim()).toBe(id);
        console.info(`RECOVERY_IDENTITY ${mode} id=${id} survived=true`);
      } catch (error) {
        failure = { value: error };
      }
      for (const key of ["PATH", "TMPDIR", "REAL_TEST_DOCKER", "IDENTITY_TEST_DIR", "IDENTITY_TEST_MODE"] as const) {
        const value = previous[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      const cleanup: unknown[] = [];
      for (const [path, kind] of [
        [containerFile, "container"],
        [networkFile, "network"],
      ] as const) {
        try {
          let id: string;
          try {
            id = (await readFile(path, "utf8")).trim();
          } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
            throw error;
          }
          if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid control identity");
          await dockerCommand(docker, kind === "container" ? ["rm", "--force", id] : ["network", "rm", id]);
          const list = await dockerCommand(
            docker,
            kind === "container"
              ? ["ps", "-a", "--no-trunc", "--format", "{{.ID}}"]
              : ["network", "ls", "--no-trunc", "--format", "{{.ID}}"],
          );
          if (list.stdout.split("\n").includes(id)) throw new Error("Control object remains");
          console.info(`RECOVERY_IDENTITY_CLEANUP ${kind} id=${id} absent=true`);
        } catch (error) {
          cleanup.push(error);
        }
      }
      if (cleanup.length === 0) await rm(work, { recursive: true, force: true });
      if (cleanup.length)
        throw new AggregateError(failure ? [failure.value, ...cleanup] : cleanup, "Identity control cleanup failed");
      if (failure) throw failure.value;
    }, 120_000);
  }
});

it("preserves real replacement container and network with the fixture's former names", async () => {
  const owned = await createBackupRecoveryFixture();
  const networkId = (
    await dockerCommand("docker", ["network", "inspect", "--format", "{{.Id}}", owned.container])
  ).stdout.trim();
  if (!/^[a-f0-9]{64}$/.test(networkId)) throw new Error("Invalid owned network identity");
  let replacementContainer = "";
  let replacementNetwork = "";
  let failure: { value: unknown } | undefined;
  try {
    await dockerCommand("docker", ["rm", "--force", owned.containerId]);
    await dockerCommand("docker", ["network", "rm", networkId]);
    replacementContainer = (
      await dockerCommand("docker", ["create", "--name", owned.container, "--network", "none", controlImage])
    ).stdout.trim();
    replacementNetwork = (await dockerCommand("docker", ["network", "create", owned.container])).stdout.trim();
    expect(replacementContainer).toMatch(/^[a-f0-9]{64}$/);
    expect(replacementNetwork).toMatch(/^[a-f0-9]{64}$/);
    await owned.close();
    expect(
      (
        await dockerCommand("docker", ["container", "inspect", "--format", "{{.Id}}", replacementContainer])
      ).stdout.trim(),
    ).toBe(replacementContainer);
    expect(
      (await dockerCommand("docker", ["network", "inspect", "--format", "{{.Id}}", replacementNetwork])).stdout.trim(),
    ).toBe(replacementNetwork);
    console.info(`RECOVERY_REPLACEMENT container=${replacementContainer} network=${replacementNetwork} survived=true`);
  } catch (error) {
    failure = { value: error };
  }
  const cleanup: unknown[] = [];
  for (const [kind, id] of [
    ["container", replacementContainer],
    ["network", replacementNetwork],
  ] as const) {
    if (!id) continue;
    try {
      if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid replacement identity");
      await dockerCommand("docker", kind === "container" ? ["rm", "--force", id] : ["network", "rm", id]);
      const list = await dockerCommand(
        "docker",
        kind === "container"
          ? ["ps", "-a", "--no-trunc", "--format", "{{.ID}}"]
          : ["network", "ls", "--no-trunc", "--format", "{{.ID}}"],
      );
      if (list.stdout.split("\n").includes(id)) throw new Error("Replacement remains");
    } catch (error) {
      cleanup.push(error);
    }
  }
  try {
    await owned.close();
  } catch (error) {
    cleanup.push(error);
  }
  if (cleanup.length)
    throw new AggregateError(failure ? [failure.value, ...cleanup] : cleanup, "Replacement cleanup failed");
  if (failure) throw failure.value;
}, 120_000);
