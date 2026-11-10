import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { z } from "zod";

const IMAGE = "postgres@sha256:f4610795587492cd4fb887c2dc3de301b813278bb6f616992061141b5f15ac36";

async function command(args: readonly string[], input: Buffer = Buffer.alloc(0)): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let size = 0;
    let failure: { value: unknown } | undefined;
    const record = (error: unknown): void => {
      failure ??= { value: error };
    };
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024 * 1024) record(new Error("Fixture command output exceeded its limit"));
      else chunks.push(chunk);
    });
    child.stderr.resume();
    child.stdin.on("error", record);
    child.on("error", record);
    child.on("close", (code, signal) => {
      if (failure) reject(new Error("Fixture command failed", { cause: failure.value }));
      else if (code !== 0 || signal !== null)
        reject(
          new Error(`Fixture command failed (${args[0]} ${args[0] === "exec" ? args[3] : ""}, exit ${String(code)})`),
        );
      else resolve(Buffer.concat(chunks));
    });
    child.stdin.end(input);
  });
}

export interface BackupRecoveryFixture {
  container: string;
  containerId: string;
  adminUrl: string;
  targetUrl: string;
  runningExecIds(): Promise<string[]>;
  exec(args: readonly string[], input?: Buffer): Promise<Buffer>;
  close(): Promise<void>;
}

/** Owns one isolated PostgreSQL 16 container, its private credentials, and its network. */
export async function createBackupRecoveryFixture(): Promise<BackupRecoveryFixture> {
  const id = randomUUID().replaceAll("-", "");
  const container = `semprec-recovery-${id}`;
  const network = `semprec-recovery-${id}`;
  const directory = await mkdtemp(join(tmpdir(), "semprec-recovery-"));
  const password = randomUUID();
  const envFile = join(directory, "postgres.env");
  let networkAttempted = false;
  let containerAttempted = false;
  let networkId: string | undefined;
  let containerId: string | undefined;
  let closed = false;
  let ready = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    const ownedContainer = containerId;
    const ownedNetwork = networkId;
    const failures: unknown[] = [];
    const ids = async (kind: "container" | "network"): Promise<string[]> => {
      const args =
        kind === "container"
          ? ["ps", "--all", "--no-trunc", "--format", "{{.ID}}"]
          : ["network", "ls", "--no-trunc", "--format", "{{.ID}}"];
      return (await command(args)).toString("utf8").trim().split("\n").filter(Boolean);
    };
    const unknown = (containerAttempted && !containerId) || (networkAttempted && !networkId);
    if (containerId) {
      if ((await ids("container")).includes(containerId)) {
        if (ready) {
          const remaining = await command([
            "exec",
            "--interactive",
            containerId,
            "psql",
            "--username=postgres",
            "--dbname=postgres",
            "--no-psqlrc",
            "--tuples-only",
            "--no-align",
            "--set=ON_ERROR_STOP=1",
            "--command=SELECT count(*) FROM pg_database WHERE left(datname,16) = 'semprec_restore_'",
          ]);
          if (remaining.toString("utf8").trim() !== "0") throw new Error("Fixture staging database remains present");
        }
        const identity = (await command(["container", "inspect", "--format", "{{.Id}}", containerId]))
          .toString("utf8")
          .trim();
        if (identity !== containerId) throw new Error("Fixture container identity mismatch");
        const result = await command(["container", "inspect", "--format", "{{json .ExecIDs}}", containerId]);
        const execIds = z
          .array(z.string().regex(/^[a-f0-9]{64}$/))
          .nullable()
          .parse(JSON.parse(result.toString("utf8")));
        if (execIds !== null && execIds.length !== 0) throw new Error("Fixture container has unsettled execs");
        await command(["rm", "--force", "--volumes", containerId]);
        if ((await ids("container")).includes(containerId)) throw new Error("Fixture container remains present");
      }
      containerAttempted = false;
      containerId = undefined;
    }
    if (unknown) throw new Error("Fixture creation outcome is uncertain");
    if (networkId) {
      if ((await ids("network")).includes(networkId)) {
        const identity = (await command(["network", "inspect", "--format", "{{.Id}}", networkId]))
          .toString("utf8")
          .trim();
        if (identity !== networkId) throw new Error("Fixture network identity mismatch");
        await command(["network", "rm", networkId]);
        if ((await ids("network")).includes(networkId)) throw new Error("Fixture network remains present");
      }
      networkAttempted = false;
      networkId = undefined;
    }
    try {
      await rm(directory, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) throw new AggregateError(failures, "Recovery fixture cleanup failed");
    console.info(`RECOVERY_FIXTURE_CLEANUP containerId=${ownedContainer} networkId=${ownedNetwork} absent=true`);
    closed = true;
  };
  try {
    await writeFile(envFile, `POSTGRES_PASSWORD=${password}\nPOSTGRES_DB=postgres\n`, { mode: 0o600, flag: "wx" });
    const containerNames = (await command(["ps", "--all", "--format", "{{.Names}}"])).toString("utf8").split("\n");
    const networkNames = (await command(["network", "ls", "--format", "{{.Name}}"])).toString("utf8").split("\n");
    if (containerNames.includes(container) || networkNames.includes(network))
      throw new Error("Recovery fixture name is unavailable");
    networkAttempted = true;
    const networkCandidate = (
      await command([
        "network",
        "create",
        "--driver",
        "bridge",
        "--opt",
        "com.docker.network.bridge.enable_ip_masquerade=false",
        network,
      ])
    )
      .toString("utf8")
      .trim();
    if (!/^[a-f0-9]{64}$/.test(networkCandidate)) throw new Error("Invalid recovery network identity");
    const networkIdentity = (await command(["network", "inspect", "--format", "{{.Id}}", networkCandidate]))
      .toString("utf8")
      .trim();
    if (networkIdentity !== networkCandidate) throw new Error("Recovery network identity mismatch");
    networkId = networkCandidate;
    containerAttempted = true;
    const containerCandidate = (
      await command([
        "run",
        "--detach",
        "--name",
        container,
        "--network",
        networkId,
        "--publish",
        "127.0.0.1::5432",
        "--env-file",
        envFile,
        IMAGE,
        "postgres",
        "-c",
        "max_locks_per_transaction=2048",
      ])
    )
      .toString("utf8")
      .trim();
    if (!/^[a-f0-9]{64}$/.test(containerCandidate)) throw new Error("Invalid recovery container identity");
    const containerIdentity = (await command(["container", "inspect", "--format", "{{.Id}}", containerCandidate]))
      .toString("utf8")
      .trim();
    if (containerIdentity !== containerCandidate) throw new Error("Recovery container identity mismatch");
    containerId = containerCandidate;
    console.info(`RECOVERY_FIXTURE container=${container} id=${containerId} network=${network}`);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        await command(["exec", containerId, "pg_isready", "--host=127.0.0.1", "--username=postgres"]);
        ready = true;
        break;
      } catch {
        await new Promise((resolveWait) => setTimeout(resolveWait, 250));
      }
    }
    if (!ready) throw new Error("Recovery fixture did not become ready");
    const mapping = (await command(["port", containerId, "5432/tcp"])).toString("utf8").trim();
    const match = /^127\.0\.0\.1:(\d{1,5})$/.exec(mapping);
    const port = Number(match?.[1]);
    if (!Number.isInteger(port) || port < 1 || port > 65_535)
      throw new Error("Recovery fixture has an invalid port mapping");
    const url = new URL("postgresql://postgres@127.0.0.1/postgres");
    url.port = String(port);
    url.password = password;
    const pool = new Pool({ connectionString: url.toString(), connectionTimeoutMillis: 10_000 });
    try {
      const result = await pool.query<{ ready: number }>("SELECT 1 AS ready");
      if (result.rows[0]?.ready !== 1) throw new Error("Recovery host connection failed");
    } finally {
      await pool.end();
    }
    return {
      container,
      containerId: containerCandidate,
      adminUrl: url.toString(),
      targetUrl: url.toString(),
      runningExecIds: async () => {
        const result = await command(["container", "inspect", "--format", "{{json .ExecIDs}}", containerCandidate]);
        return (
          z
            .array(z.string().regex(/^[a-f0-9]{64}$/))
            .nullable()
            .parse(JSON.parse(result.toString("utf8"))) ?? []
        );
      },
      exec: (args, input) => command(["exec", "--interactive", containerCandidate, ...args], input),
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Recovery fixture setup and cleanup failed", {
        cause: cleanupError,
      });
    }
    throw error;
  }
}

/** Holds exactly one Docker exec start response on a private Unix socket until the caller drops it. */
export async function createStartResponseInterruptionProxy(
  containerId: string,
  pendingIds: () => readonly string[],
): Promise<{
  endpoint: string;
  held: Promise<void>;
  dropClient(): void;
  releaseDaemon(): void;
  close(): Promise<void>;
}> {
  const directory = await mkdtemp("/private/tmp/b19-proxy-");
  const endpoint = join(directory, "engine.sock");
  const host = (await command(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"]))
    .toString("utf8")
    .trim();
  const parsed = new URL(host);
  if (parsed.protocol !== "unix:" || parsed.hostname !== "") throw new Error("Fixture requires local Docker context");
  const daemonPath = decodeURIComponent(parsed.pathname);
  const connections = new Set<Socket>();
  let clientStart: Socket | undefined;
  let daemonStart: Socket | undefined;
  let heldResolve: (() => void) | undefined;
  const held = new Promise<void>((resolveHeld) => {
    heldResolve = resolveHeld;
  });
  const server = createServer((client) => {
    connections.add(client);
    client.on("close", () => connections.delete(client));
    client.on("error", () => {});
    let header = Buffer.alloc(0);
    const readHeader = (chunk: Buffer): void => {
      header = Buffer.concat([header, chunk]);
      if (header.length > 32_768) {
        client.destroy();
        return;
      }
      const end = header.indexOf("\r\n\r\n");
      if (end < 0) return;
      client.off("data", readHeader);
      client.pause();
      const line = header.subarray(0, header.indexOf("\r\n")).toString("ascii");
      const match = /^(GET|POST) (\/[^ ]+) HTTP\/1\.[01]$/.exec(line);
      const method = match?.[1];
      const path = match?.[2];
      if (!method || !path) {
        client.destroy();
        return;
      }
      const containerPath = new RegExp(`^/v1\\.\\d+/containers/${containerId}/(?:json|exec)$`);
      const execMatch = /^\/v1\.\d+\/exec\/([a-f0-9]{64})\/(start|json)$/.exec(path);
      const execId = execMatch?.[1];
      const action = execMatch?.[2];
      const allowed =
        (method === "GET" && path === "/version") ||
        containerPath.test(path) ||
        (execId !== undefined &&
          pendingIds().includes(execId) &&
          ((method === "GET" && action === "json") || (method === "POST" && action === "start")));
      if (!allowed) {
        client.destroy();
        return;
      }
      const upstream = createConnection(daemonPath);
      connections.add(upstream);
      upstream.on("close", () => connections.delete(upstream));
      upstream.on("error", () => client.destroy());
      const intercept = method === "POST" && action === "start";
      if (!intercept) {
        const boundary = end + 4;
        const headers = header
          .subarray(0, boundary)
          .toString("ascii")
          .replace(/^connection: keep-alive$/im, "Connection: close");
        upstream.write(Buffer.concat([Buffer.from(headers, "ascii"), header.subarray(boundary)]));
      } else upstream.write(header);
      console.info(`RECOVERY_PROXY ${method} ${action ?? (path === "/version" ? "version" : "container")}`);
      if (intercept) {
        clientStart = client;
        daemonStart = upstream;
        let response = Buffer.alloc(0);
        upstream.on("data", (data: Buffer) => {
          response = Buffer.concat([response, data]);
          if (response.length > 32_768) {
            upstream.destroy();
            client.destroy();
            return;
          }
          if (response.includes(Buffer.from("\r\n\r\n"))) {
            if (!response.subarray(0, 16).toString("ascii").includes("101")) {
              upstream.destroy();
              client.destroy();
              return;
            }
            heldResolve?.();
            heldResolve = undefined;
          }
        });
        client.pipe(upstream);
      } else {
        client.pipe(upstream);
        upstream.pipe(client);
      }
      client.resume();
    };
    client.on("data", readHeader);
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(endpoint, resolveListen);
  });
  await chmod(endpoint, 0o600);
  return {
    endpoint: `unix://${endpoint}`,
    held,
    dropClient: () => {
      if (!clientStart) throw new Error("Start response is not held");
      clientStart.destroy();
    },
    releaseDaemon: () => {
      if (!daemonStart) throw new Error("Start response is not held");
      daemonStart.end();
    },
    close: async () => {
      for (const connection of connections) connection.destroy();
      await new Promise<void>((resolveClose, reject) =>
        server.close((error) => (error ? reject(error) : resolveClose())),
      );
      await rm(directory, { recursive: true, force: true });
    },
  };
}
