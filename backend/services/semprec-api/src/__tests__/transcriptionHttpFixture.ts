import { spawn, spawnSync } from "node:child_process";
import fs, { existsSync, mkdtempSync, statSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { createRuntimeRolePool } from "@semprec/data/testSupport";
import { z } from "zod";

const backend = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const blockRoot = resolve(backend, "../shared/block-model");
const producerSource = join(backend, "services/semprec-transcribe/src/__tests__/fixtures/httpTranscriptionProducer.ts");
const producer = join(backend, "services/semprec-transcribe/dist/__tests__/fixtures/httpTranscriptionProducer.js");
const taskSource = join(backend, "services/semprec-transcribe/src/transcriptionTask.ts");
const taskOutput = join(backend, "services/semprec-transcribe/dist/transcriptionTask.js");
const mediaSource = join(backend, "services/semprec-transcribe/src/__tests__/fixtures/mediaFixtures.ts");
const mediaOutput = join(backend, "services/semprec-transcribe/dist/__tests__/fixtures/mediaFixtures.js");
const audioPath = join(backend, "services/semprec-transcribe/src/__tests__/fixtures/spoken-markers.wav");
const resolver = join(backend, "services/semprec-transcribe/src/__tests__/fixtures/workspaceDistResolver.mjs");
type GuardControl = "hang" | "overflow" | "malformed" | "duplicate" | "resolver";
type GuardObservation = {
  pid: number | null;
  descendantPid: number | null;
  descendantGoneAfterGroupKill: boolean;
  emergencyCleanupError: string | null;
  closed: boolean;
  temporaryRemoved: boolean;
  poolClosed: boolean;
};
const resultSchema = z.strictObject({
  mode: z.enum(["failure", "stop", "consume"]),
  fileItemId: z.uuid(),
  transcriptId: z.uuid(),
  normalizedBlobId: z.uuid(),
  playbackBlobId: z.uuid().optional(),
  diarizeCalls: z.number().int().nonnegative(),
  transcribeCalls: z.number().int().nonnegative(),
  summaryCalls: z.number().int().nonnegative(),
});

export async function withFixtureStorage<T>(path: string, run: () => Promise<T>): Promise<T> {
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    outcome = { ok: true, value: await run() };
  } catch (error) {
    outcome = { ok: false, error };
  }
  try {
    await fsPromises.rm(path, { recursive: true, force: true });
  } catch (error) {
    if (outcome.ok) outcome = { ok: false, error };
    else {
      const message = outcome.error instanceof Error ? outcome.error.message : "Fixture scenario failed";
      outcome = {
        ok: false,
        error: new AggregateError([outcome.error, error], message, { cause: outcome.error }),
      };
    }
  }
  if (!outcome.ok) {
    if (outcome.error instanceof Error) throw outcome.error;
    throw new Error("Fixture scenario failed with a non-error value", { cause: outcome.error });
  }
  return outcome.value;
}

async function runProducer(
  stdin: string,
  blockEntry: string,
  runtimeUrl: string,
  observation?: GuardObservation,
  control?: GuardControl,
  recordLifecycle = false,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveResult, reject) => {
    const scripts: Record<GuardControl, string> = {
      hang: `import { spawn } from 'node:child_process';
        const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
        descendant.on('spawn', () => console.log('BATCH09_DESCENDANT ' + descendant.pid));
        descendant.on('error', () => process.exit(1));
        setInterval(() => {}, 1000)`,
      overflow: "process.stdout.write('x'.repeat(1100000)); process.stderr.write('y'.repeat(1100000))",
      malformed: "console.log('BATCH09_FRAME {bad-json')",
      duplicate: "console.log('BATCH09_FRAME {}'); console.log('BATCH09_FRAME {}')",
      resolver: `import { register } from 'node:module'; import { pathToFileURL } from 'node:url'; register(pathToFileURL(${JSON.stringify(resolver)})); await import('@semprec/data/private')`,
    };
    const args = control ? ["--input-type=module", "-e", scripts[control]] : [producer];
    const spawnRequestedAt = new Date().toISOString();
    const child = spawn(process.execPath, args, {
      cwd: backend,
      env: {
        ...process.env,
        BATCH09_BLOCK_MODEL_ENTRY: blockEntry,
        BATCH09_RUNTIME_DATABASE_URL: runtimeUrl,
        LOG_LEVEL: "error",
      },
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (observation) observation.pid = child.pid ?? null;
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let failure: Error | undefined;
    const reportingFailures: unknown[] = [];
    let emergencyTimer: ReturnType<typeof setTimeout> | undefined;
    let groupSignalSucceeded = false;
    function reportCleanupFailure(message: string) {
      if (observation)
        observation.emergencyCleanupError = [observation.emergencyCleanupError, message].filter(Boolean).join("; ");
      try {
        process.stderr.write(`Transcription fixture cleanup: ${message}\n`);
      } catch (error) {
        reportingFailures.push(error);
      }
    }
    function primaryError(reason: Error): Error {
      return reportingFailures.length
        ? new AggregateError([reason, ...reportingFailures], reason.message, { cause: reason })
        : reason;
    }
    function stop(reason: Error) {
      if (failure) return;
      failure = reason;
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
          groupSignalSucceeded = true;
        } catch (error) {
          reportCleanupFailure(`Group kill failed: ${String(error)}`);
          for (const ownedPid of [child.pid, observation?.descendantPid]) {
            if (!ownedPid) continue;
            try {
              process.kill(ownedPid, "SIGKILL");
            } catch (cleanupError) {
              if (!(cleanupError instanceof Error && "code" in cleanupError && cleanupError.code === "ESRCH")) {
                reportCleanupFailure(`Fallback signal failed: ${String(cleanupError)}`);
              }
            }
          }
          emergencyTimer = setTimeout(() => {
            reportCleanupFailure("Owned child did not close after fallback");
            child.stdin.destroy();
            child.stdout.destroy();
            child.stderr.destroy();
            child.unref();
            reject(primaryError(reason));
          }, 3000);
        }
      }
    }
    const timer = setTimeout(() => stop(new Error("Transcription fixture timed out")), 25_000);
    function collect(chunk: Buffer, stream: "stdout" | "stderr") {
      bytes += chunk.length;
      if (bytes > 2_000_000) return stop(new Error("Transcription fixture output exceeds limit"));
      if (stream === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
      if (control === "hang" && stream === "stdout" && observation && observation.descendantPid === null) {
        const line = stdout.split("\n").find((entry) => entry.startsWith("BATCH09_DESCENDANT "));
        if (line && stdout.includes(`${line}\n`)) {
          const match = /^BATCH09_DESCENDANT ([1-9]\d*)$/.exec(line);
          const parsed = z
            .number()
            .int()
            .positive()
            .safeParse(match ? Number(match[1]) : null);
          if (!parsed.success) stop(new Error("Invalid fixture descendant PID"));
          else observation.descendantPid = parsed.data;
        }
      }
    }
    child.stdout.on("data", (chunk: Buffer) => collect(chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => collect(chunk, "stderr"));
    child.stdin.on("error", (error) => stop(error));
    child.on("error", (error) => stop(error));
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (emergencyTimer) clearTimeout(emergencyTimer);
      if (observation) observation.closed = true;
      if (recordLifecycle) {
        try {
          process.stdout.write(
            `${JSON.stringify({ fixture: "recording-transcription-producer", pid: child.pid ?? null, derivedPgid: child.pid ?? null, spawnRequestedAt, executable: process.execPath, argv: child.spawnargs, exitCode: code, signal })}\n`,
          );
        } catch (error) {
          reportingFailures.push(error);
        }
      }
      void (async () => {
        if (control === "hang" && observation?.descendantPid) {
          const descendantPid = observation.descendantPid;
          const deadline = Date.now() + 3000;
          let gone = false;
          try {
            do {
              try {
                process.kill(descendantPid, 0);
              } catch (error) {
                if (error instanceof Error && "code" in error && error.code === "ESRCH") {
                  gone = true;
                  break;
                }
                throw error;
              }
              await new Promise((resolveWait) => setTimeout(resolveWait, 50));
            } while (Date.now() < deadline);
            observation.descendantGoneAfterGroupKill =
              gone && groupSignalSucceeded && failure?.message === "Transcription fixture timed out";
            if (!gone) process.kill(descendantPid, "SIGKILL");
          } catch (error) {
            reportCleanupFailure(`Descendant observation failed: ${String(error)}`);
            try {
              process.kill(descendantPid, "SIGKILL");
            } catch (cleanupError) {
              if (!(cleanupError instanceof Error && "code" in cleanupError && cleanupError.code === "ESRCH"))
                reportCleanupFailure(`Descendant fallback failed: ${String(cleanupError)}`);
            }
          }
          if (!gone) {
            const cleanupDeadline = Date.now() + 3000;
            try {
              do {
                try {
                  process.kill(descendantPid, 0);
                } catch (error) {
                  if (error instanceof Error && "code" in error && error.code === "ESRCH") {
                    gone = true;
                    break;
                  }
                  throw error;
                }
                await new Promise((resolveWait) => setTimeout(resolveWait, 50));
              } while (Date.now() < cleanupDeadline);
              if (!gone) reportCleanupFailure("Owned descendant did not settle after fallback");
            } catch (error) {
              reportCleanupFailure(`Owned descendant settlement failed: ${String(error)}`);
            }
          }
        }
        if (failure) return reject(primaryError(failure));
        if (code !== 0)
          return reject(
            primaryError(new Error(`Transcription fixture failed: ${code ?? signal}\n${stdout}\n${stderr}`)),
          );
        if (reportingFailures.length) return reject(new AggregateError(reportingFailures, "Fixture reporting failed"));
        resolveResult({ stdout, stderr });
      })();
    });
    child.stdin.end(stdin);
  });
}

type FixtureInput = {
  mode: "failure" | "stop" | "consume";
  tenantId: string;
  storageRoot: string;
  fileItemId?: string;
  source?: "wav" | "ogg";
};

async function runFixture(
  input: FixtureInput,
  adminPool: Pool,
  control?: GuardControl,
  observation?: GuardObservation,
  recordLifecycle = false,
) {
  const rolePool = await createRuntimeRolePool(adminPool, "semprec_data");
  let temporary: string | undefined;
  let primary: unknown;
  let failed = false;
  const cleanupFailures: unknown[] = [];
  let output: { result: z.infer<typeof resultSchema>; stdout: string; stderr: string } | undefined;
  try {
    for (const [source, output] of [
      [producerSource, producer],
      [taskSource, taskOutput],
      [mediaSource, mediaOutput],
    ]) {
      if (!source || !output || statSync(output).mtimeMs < statSync(source).mtimeMs)
        throw new Error("Build the transcribe fixture and task before running this test");
    }
    temporary = mkdtempSync(join(blockRoot, "node_modules/.batch09-"));
    const runtimeUrl = z.object({ connectionString: z.string() }).parse(rolePool.options).connectionString;
    const compiler = join(backend, "node_modules/typescript/bin/tsc");
    const build = spawnSync(
      process.execPath,
      [
        compiler,
        "-p",
        join(blockRoot, "tsconfig.json"),
        "--noEmit",
        "false",
        "--declaration",
        "false",
        "--incremental",
        "false",
        "--outDir",
        temporary,
      ],
      {
        cwd: backend,
        encoding: "utf8",
        timeout: 25_000,
        maxBuffer: 1_000_000,
      },
    );
    if (build.error || build.status !== 0)
      throw new Error(
        `Temporary block-model build failed: ${build.error?.message ?? build.status}\n${build.stdout}\n${build.stderr}`,
      );
    const child = await runProducer(
      JSON.stringify({ ...input, audioPath }),
      join(temporary, "index.js"),
      runtimeUrl,
      observation,
      control,
      recordLifecycle,
    );
    const frames = child.stdout.split("\n").filter((line) => line.startsWith("BATCH09_FRAME "));
    if (frames.length !== 1) throw new Error("Expected exactly one transcription fixture frame");
    let raw: unknown;
    try {
      raw = JSON.parse(frames[0]!.slice("BATCH09_FRAME ".length));
    } catch (error) {
      throw new Error("Invalid transcription fixture frame", { cause: error });
    }
    const result = resultSchema.parse(raw);
    if (result.mode !== input.mode || (input.fileItemId !== undefined && result.fileItemId !== input.fileItemId))
      throw new Error("Transcription fixture returned a mismatched result");
    output = { result, stdout: child.stdout, stderr: child.stderr };
  } catch (error) {
    primary = error;
    failed = true;
  }
  try {
    if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
    if (observation) observation.temporaryRemoved = temporary !== undefined && !existsSync(temporary);
    if (recordLifecycle)
      process.stdout.write(
        `${JSON.stringify({ fixture: "recording-transcription-temporary", path: temporary ?? null, removed: temporary !== undefined && !existsSync(temporary) })}\n`,
      );
  } catch (error) {
    cleanupFailures.push(error);
  }
  try {
    await rolePool.end();
    if (observation) {
      try {
        await rolePool.query("SELECT 1");
      } catch (error) {
        observation.poolClosed = error instanceof Error && error.message.includes("after calling end");
      }
    }
  } catch (error) {
    cleanupFailures.push(error);
  }
  if (failed) {
    const original =
      primary instanceof Error
        ? primary
        : new Error("Transcription fixture failed with a non-error value", { cause: primary });
    if (cleanupFailures.length)
      throw new AggregateError([original, ...cleanupFailures], original.message, { cause: original });
    throw original;
  }
  if (cleanupFailures.length) throw new AggregateError(cleanupFailures, "Transcription fixture cleanup failed");
  if (!output) throw new Error("Transcription fixture returned no result");
  return output;
}

export function runTranscriptionFixture(input: FixtureInput, adminPool: Pool, recordLifecycle = false) {
  return runFixture(input, adminPool, undefined, undefined, recordLifecycle);
}

/** Exercise the same overflow failure with the producer's lack of a test observation. */
export function runFixtureOverflowWithoutObservation(input: FixtureInput, adminPool: Pool) {
  return runFixture(input, adminPool, "overflow");
}

/** Closed fault controls exercise the same runner, parser and ownership cleanup as the producer. */
export async function runFixtureGuardControl(control: GuardControl, input: FixtureInput, adminPool: Pool) {
  const observation: GuardObservation = {
    pid: null,
    descendantPid: null,
    descendantGoneAfterGroupKill: false,
    emergencyCleanupError: null,
    closed: false,
    temporaryRemoved: false,
    poolClosed: false,
  };
  try {
    await runFixture(input, adminPool, control, observation);
    throw new Error("Guard control unexpectedly succeeded");
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { ...observation, message: error.message, error };
  }
}
