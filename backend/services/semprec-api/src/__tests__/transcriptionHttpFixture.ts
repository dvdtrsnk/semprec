import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const backend = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const blockRoot = resolve(backend, "../shared/block-model");
const producerSource = join(backend, "services/semprec-transcribe/src/__tests__/fixtures/httpTranscriptionProducer.ts");
const producer = join(backend, "services/semprec-transcribe/dist/__tests__/fixtures/httpTranscriptionProducer.js");
const audioPath = join(backend, "services/semprec-transcribe/src/__tests__/fixtures/spoken-markers.wav");
const resultSchema = z.strictObject({
  mode: z.enum(["failure", "stop", "consume"]),
  fileItemId: z.uuid(),
  transcriptId: z.uuid(),
  normalizedBlobId: z.uuid(),
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
    await rm(path, { recursive: true, force: true });
  } catch (error) {
    if (outcome.ok) outcome = { ok: false, error };
    else process.stderr.write(`Failed to remove fixture storage: ${String(error)}\n`);
  }
  if (!outcome.ok) {
    if (outcome.error instanceof Error) throw outcome.error;
    throw new Error("Fixture scenario failed with a non-error value", { cause: outcome.error });
  }
  return outcome.value;
}

async function runProducer(stdin: string, blockEntry: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [producer], {
      cwd: backend,
      env: { ...process.env, BATCH09_BLOCK_MODEL_ENTRY: blockEntry, LOG_LEVEL: "error" },
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let failure: Error | undefined;
    function stop(reason: Error) {
      if (failure) return;
      failure = reason;
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
            failure = new AggregateError([reason, error], "Could not stop fixture process group");
          }
        }
      }
    }
    const timer = setTimeout(() => stop(new Error("Transcription fixture timed out")), 25_000);
    function collect(chunk: Buffer, stream: "stdout" | "stderr") {
      bytes += chunk.length;
      if (bytes > 2_000_000) return stop(new Error("Transcription fixture output exceeds limit"));
      if (stream === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    }
    child.stdout.on("data", (chunk: Buffer) => collect(chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => collect(chunk, "stderr"));
    child.stdin.on("error", (error) => stop(error));
    child.on("error", (error) => stop(error));
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      if (code !== 0) return reject(new Error(`Transcription fixture failed: ${code ?? signal}\n${stdout}\n${stderr}`));
      resolveResult({ stdout, stderr });
    });
    child.stdin.end(stdin);
  });
}

export async function runTranscriptionFixture(input: {
  mode: "failure" | "stop" | "consume";
  tenantId: string;
  storageRoot: string;
  fileItemId?: string;
}) {
  if (statSync(producer).mtimeMs < statSync(producerSource).mtimeMs)
    throw new Error("Build the transcribe fixture before running this test");
  const temporary = mkdtempSync(join(blockRoot, "node_modules/.batch09-"));
  let primary: unknown;
  let failed = false;
  let output: { result: z.infer<typeof resultSchema>; stdout: string; stderr: string } | undefined;
  try {
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
    const child = await runProducer(JSON.stringify({ ...input, audioPath }), join(temporary, "index.js"));
    const frames = child.stdout.split("\n").filter((line) => line.startsWith("BATCH09_FRAME "));
    if (frames.length !== 1) throw new Error("Expected exactly one transcription fixture frame");
    const raw: unknown = JSON.parse(frames[0]!.slice("BATCH09_FRAME ".length));
    const result = resultSchema.parse(raw);
    if (result.mode !== input.mode || (input.fileItemId !== undefined && result.fileItemId !== input.fileItemId))
      throw new Error("Transcription fixture returned a mismatched result");
    output = { result, stdout: child.stdout, stderr: child.stderr };
  } catch (error) {
    primary = error;
    failed = true;
  }
  try {
    rmSync(temporary, { recursive: true, force: true });
  } catch (error) {
    if (failed) {
      process.stderr.write(`Failed to remove transcription fixture temporary output: ${String(error)}\n`);
    } else {
      primary = error;
      failed = true;
    }
  }
  if (failed) {
    if (primary instanceof Error) throw primary;
    throw new Error("Transcription fixture failed with a non-error value", { cause: primary });
  }
  if (!output) throw new Error("Transcription fixture returned no result");
  return output;
}
