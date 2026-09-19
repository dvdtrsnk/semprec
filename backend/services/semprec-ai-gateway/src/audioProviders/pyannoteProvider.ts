import { AudioProviderCallError, type DiarizationProvider, type DiarizationTurn } from "./types.js";

const PYANNOTE_API_URL = "https://api.pyannote.ai/v1";
const MAX_RESPONSE_BODY_BYTES = 10 * 1024 * 1024;
const POLL_INTERVAL_MS = 1_000;
const MAX_POLLS = 300;

type PyannoteJob = { jobId?: unknown; status?: unknown; output?: { diarization?: unknown } };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function readJsonBodyWithSizeCap(res: Response): Promise<unknown> {
  const reader = res.body?.getReader();
  if (!reader) throw new AudioProviderCallError("pyannoteAI response body stream was unavailable");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BODY_BYTES) {
      await reader.cancel();
      throw new AudioProviderCallError("pyannoteAI response body exceeded the maximum allowed size");
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8"));
  } catch {
    throw new AudioProviderCallError("pyannoteAI response body was not valid JSON");
  }
}

function parseJob(value: unknown): PyannoteJob {
  if (!isObject(value)) throw new AudioProviderCallError("pyannoteAI response did not match the expected shape");
  return value;
}

function parseTurns(value: unknown): DiarizationTurn[] {
  if (!Array.isArray(value)) throw new AudioProviderCallError("pyannoteAI job did not include diarization output");
  return value.map((turn) => {
    if (
      !isObject(turn) ||
      typeof turn.speaker !== "string" ||
      typeof turn.start !== "number" ||
      typeof turn.end !== "number"
    ) {
      throw new AudioProviderCallError("pyannoteAI job included an invalid diarization turn");
    }
    return { speaker: turn.speaker, start: turn.start, end: turn.end };
  });
}

/** pyannoteAI's asynchronous diarization adapter, normalized to speaker turns. */
export function createPyannoteDiarizationProvider(apiKey: string): DiarizationProvider {
  const headers = { Authorization: `Bearer ${apiKey}` };
  return {
    id: "pyannoteai",
    async diarize({ audioUrl }): Promise<DiarizationTurn[]> {
      let created: Response;
      try {
        created = await fetch(`${PYANNOTE_API_URL}/diarize`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ url: audioUrl }),
          signal: AbortSignal.timeout(55_000),
        });
      } catch (err) {
        throw new AudioProviderCallError(
          `pyannoteAI request failed: ${err instanceof Error ? err.name : "unknown error"}`,
        );
      }
      if (!created.ok) throw new AudioProviderCallError(`pyannoteAI responded with HTTP ${created.status}`);
      const jobId = parseJob(await readJsonBodyWithSizeCap(created)).jobId;
      if (typeof jobId !== "string") throw new AudioProviderCallError("pyannoteAI did not return a job id");

      for (let poll = 0; poll < MAX_POLLS; poll += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        let response: Response;
        try {
          response = await fetch(`${PYANNOTE_API_URL}/jobs/${encodeURIComponent(jobId)}`, {
            headers,
            signal: AbortSignal.timeout(55_000),
          });
        } catch (err) {
          throw new AudioProviderCallError(
            `pyannoteAI job request failed: ${err instanceof Error ? err.name : "unknown error"}`,
          );
        }
        if (!response.ok) throw new AudioProviderCallError(`pyannoteAI job responded with HTTP ${response.status}`);
        const job = parseJob(await readJsonBodyWithSizeCap(response));
        if (job.status === "succeeded") return parseTurns(job.output?.diarization);
        if (job.status === "failed" || job.status === "canceled") {
          throw new AudioProviderCallError(`pyannoteAI job ${job.status}`);
        }
      }
      throw new AudioProviderCallError("pyannoteAI job did not finish before the polling deadline");
    },
  };
}
