import { execFile } from "node:child_process";
import { request, type IncomingMessage } from "node:http";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import { z } from "zod";

const MAX_OUTPUT = 1024 * 1024;
const MAX_ARCHIVE = 64 * 1024 * 1024;
const execFileAsync = promisify(execFile);
const idSchema = z.string().regex(/^[0-9a-f]{64}$/);
const inspectSchema = z
  .object({ ID: idSchema, ContainerID: idSchema, Running: z.boolean(), ExitCode: z.number().int().nullable() })
  .passthrough();
interface ResponseData {
  status: number;
  body: Buffer;
}

async function readResponse(response: IncomingMessage): Promise<ResponseData> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of response) {
    if (!Buffer.isBuffer(chunk)) throw new Error("Invalid Docker response");
    length += chunk.length;
    if (length > MAX_OUTPUT) throw new Error("Docker response exceeds limit");
    chunks.push(chunk);
  }
  return { status: response.statusCode ?? 0, body: Buffer.concat(chunks) };
}
function json(value: Buffer): unknown {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value));
}
async function localSocket(): Promise<string> {
  if (process.env.DOCKER_HOST && process.env.DOCKER_CONTEXT) throw new Error("Ambiguous Docker context");
  let endpoint = process.env.DOCKER_HOST;
  if (!endpoint) {
    const result = await execFileAsync("docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], {
      timeout: 10_000,
      maxBuffer: 4096,
    });
    endpoint = result.stdout.trim();
  }
  const url = new URL(endpoint);
  if (url.protocol !== "unix:" || url.hostname !== "" || url.search !== "" || url.hash !== "")
    throw new Error("Restore requires a local Docker Unix context");
  const path = decodeURIComponent(url.pathname);
  if (!path.startsWith("/") || !(await stat(path)).isSocket()) throw new Error("Invalid local Docker socket");
  return path;
}

/** Owns narrowly scoped PostgreSQL client execs in one selected offline container. */
export class RestorePostgresTools {
  private readonly owned = new Set<string>();
  private constructor(
    private readonly socketPath: string,
    private readonly version: string,
    private readonly container: string,
  ) {}
  private call(method: "GET" | "POST", path: string, body?: Buffer): Promise<ResponseData> {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath: this.socketPath,
          path,
          method,
          headers: body ? { "Content-Type": "application/json", "Content-Length": body.length } : undefined,
        },
        (res) => {
          readResponse(res).then(resolve, reject);
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  }
  static async connect(containerId: string): Promise<RestorePostgresTools> {
    const container = idSchema.parse(containerId);
    const socketPath = await localSocket();
    const probe = new RestorePostgresTools(socketPath, "", container);
    const response = await probe.call("GET", "/version");
    if (response.status !== 200) throw new Error("Docker version discovery failed");
    const info = z
      .object({ ApiVersion: z.string(), MinAPIVersion: z.string() })
      .passthrough()
      .parse(json(response.body));
    const parseVersion = (value: string): number => {
      const match = /^1\.(\d{1,3})$/.exec(value);
      if (!match) throw new Error("Unsupported Docker API version");
      return Number(match[1]);
    };
    const minor = Math.min(parseVersion(info.ApiVersion), 54);
    if (minor < Math.max(parseVersion(info.MinAPIVersion), 40)) throw new Error("Unsupported Docker API version");
    const owner = new RestorePostgresTools(socketPath, `1.${minor}`, container);
    const found = await owner.call("GET", `/v${owner.version}/containers/${container}/json`);
    if (found.status !== 200 || z.object({ Id: idSchema }).passthrough().parse(json(found.body)).Id !== container)
      throw new Error("Restore container identity is unavailable");
    return owner;
  }
  private async inspect(id: string): Promise<z.infer<typeof inspectSchema>> {
    if (!this.owned.has(id)) throw new Error("Restore exec is not owned");
    const response = await this.call("GET", `/v${this.version}/exec/${id}/json`);
    if (response.status !== 200) throw new Error("Restore exec inspection failed");
    const parsed = inspectSchema.parse(json(response.body));
    if (parsed.ID !== id || parsed.ContainerID !== this.container) throw new Error("Restore exec identity mismatch");
    return parsed;
  }
  private async run(command: readonly string[], input: Buffer, signal?: AbortSignal): Promise<Buffer> {
    if (input.length > MAX_ARCHIVE) throw new Error("Restore input exceeds limit");
    const createBody = Buffer.from(
      JSON.stringify({ AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: false, Cmd: command }),
    );
    const created = await this.call("POST", `/v${this.version}/containers/${this.container}/exec`, createBody);
    if (created.status !== 201) throw new Error("Restore exec creation failed");
    const id = z.object({ Id: idSchema }).passthrough().parse(json(created.body)).Id;
    this.owned.add(id);
    let acknowledged = false;
    let output: Buffer = Buffer.alloc(0);
    let streamFailure: { value: unknown } | undefined;
    try {
      output = await new Promise<Buffer>((resolve, reject) => {
        const body = Buffer.from(JSON.stringify({ Detach: false, Tty: false }));
        const req = request({
          socketPath: this.socketPath,
          path: `/v${this.version}/exec/${id}/start`,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": body.length,
            Connection: "Upgrade",
            Upgrade: "tcp",
          },
        });
        req.on("error", reject);
        req.on("response", (response) => {
          response.resume();
          reject(new Error("Restore exec did not upgrade"));
        });
        req.on("upgrade", (_response, socket, head) => {
          acknowledged = true;
          const interrupt = (): void => {
            socket.destroy(new Error("Restore exec output interrupted"));
          };
          if (signal?.aborted) interrupt();
          else signal?.addEventListener("abort", interrupt, { once: true });
          socket.once("close", () => signal?.removeEventListener("abort", interrupt));
          let pending: Buffer = Buffer.alloc(0);
          const stdout: Buffer[] = [];
          let total = 0;
          const consume = (chunk: Buffer): void => {
            if (pending.length + chunk.length > MAX_OUTPUT + 8) {
              socket.destroy(new Error("Restore output exceeds limit"));
              return;
            }
            pending = Buffer.concat([pending, chunk]);
            while (pending.length >= 8) {
              const stream = pending[0];
              if ((stream !== 1 && stream !== 2) || pending[1] !== 0 || pending[2] !== 0 || pending[3] !== 0) {
                socket.destroy(new Error("Invalid Docker output frame"));
                return;
              }
              const size = pending.readUInt32BE(4);
              if (size > MAX_OUTPUT || total + size > MAX_OUTPUT) {
                socket.destroy(new Error("Restore output exceeds limit"));
                return;
              }
              if (pending.length < 8 + size) return;
              total += size;
              if (stream === 1) stdout.push(pending.subarray(8, 8 + size));
              pending = pending.subarray(8 + size);
            }
          };
          socket.on("data", consume);
          let ended = false;
          socket.on("error", reject);
          socket.on("close", () => {
            if (!ended) reject(new Error("Restore exec stream closed unexpectedly"));
          });
          socket.on("end", () => {
            ended = true;
          });
          socket.on("end", () =>
            pending.length === 0 ? resolve(Buffer.concat(stdout)) : reject(new Error("Truncated Docker output frame")),
          );
          if (head.length) consume(head);
          socket.end(input);
        });
        req.end(body);
      });
    } catch (error) {
      streamFailure = { value: error };
    }
    let observedRunning = false;
    let inspectionFailure: { value: unknown } | undefined;
    while (true) {
      let state: z.infer<typeof inspectSchema>;
      try {
        state = await this.inspect(id);
      } catch (error) {
        inspectionFailure ??= { value: error };
        await new Promise((resolveWait) => setTimeout(resolveWait, 250));
        continue;
      }
      if (state.Running) observedRunning = true;
      else if ((acknowledged || observedRunning) && state.ExitCode !== null) {
        this.owned.delete(id);
        if (streamFailure && inspectionFailure) {
          throw new AggregateError([streamFailure.value, inspectionFailure.value], "Restore exec observations failed");
        }
        if (streamFailure) throw new Error("Restore exec stream failed", { cause: streamFailure.value });
        if (inspectionFailure)
          throw new Error("Restore exec inspection was interrupted", { cause: inspectionFailure.value });
        if (state.ExitCode !== 0) throw new Error("Restore exec failed");
        return output;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
  }
  async systemIdentifier(): Promise<string> {
    const bytes = await this.run(
      [
        "psql",
        "--username=postgres",
        "--dbname=postgres",
        "--no-psqlrc",
        "--tuples-only",
        "--no-align",
        "--set=ON_ERROR_STOP=1",
        "--command=SELECT system_identifier::text FROM pg_control_system()",
      ],
      Buffer.alloc(0),
    );
    const value = bytes.toString("utf8").trim();
    if (!/^\d{1,20}$/.test(value)) throw new Error("Invalid restore tool identity");
    return value;
  }
  async inspectArchive(archive: Buffer): Promise<string> {
    if (archive.length === 0 || archive.length > MAX_ARCHIVE) throw new Error("Invalid restore archive size");
    const version = (await this.run(["pg_restore", "--version"], Buffer.alloc(0))).toString("utf8");
    if (!/^pg_restore \(PostgreSQL\) 16(?:\.|\s|$)/.test(version)) throw new Error("Unsupported restore client");
    return selectTenantKeysToc(await this.run(["pg_restore", "--list"], archive));
  }
  async isExecRunning(id: string): Promise<boolean> {
    return (await this.inspect(id)).Running;
  }

  pendingExecIds(): readonly string[] {
    return [...this.owned];
  }

  async restoreArchive(database: string, archive: Buffer, selection: string, signal?: AbortSignal): Promise<void> {
    if (
      !/^semprec_restore_[a-f0-9]{32}$/.test(database) ||
      !/^\d+; \d+ \d+ TABLE DATA public tenant_keys \S+$/.test(selection)
    )
      throw new Error("Invalid restore selection");
    const script =
      "umask 077; f=$(mktemp /tmp/semprec-key-toc.XXXXXXXX) || exit 1; " +
      'printf "%s\\n" "$1" > "$f" || { rm -f -- "$f"; exit 1; }; ' +
      'pg_restore --username=postgres --dbname="$2" --data-only --exit-on-error --no-owner --no-privileges --use-list="$f"; ' +
      's=$?; rm -f -- "$f" || exit 1; exit "$s"';
    await this.run(["sh", "-c", script, "restore-key-toc", selection, database], archive, signal);
  }
}

export function selectTenantKeysToc(bytes: Buffer): string {
  if (bytes.length > MAX_OUTPUT) throw new Error("Restore catalog exceeds limit");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!/^;\s+Dumped by pg_dump version: 16(?:\.|\s|$)/m.test(text)) throw new Error("Unsupported archive client");
  const entries = text.split(/\r?\n/).filter((line) => line !== "" && !line.startsWith(";"));
  const entry = entries[0];
  if (entries.length !== 1 || entry === undefined || !/^\d+; \d+ \d+ TABLE DATA public tenant_keys \S+$/.test(entry))
    throw new Error("Invalid restore catalog");
  return entry;
}
