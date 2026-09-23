import { randomUUID } from "node:crypto";
import {
  AudioProviderCallError,
  type DiarizationProvider,
  type DiarizationRequest,
  type DiarizationTurn,
} from "./types.js";
import { isObject, readJsonBodyWithSizeCap } from "./httpUtils.js";

const PYANNOTE_API_URL = "https://api.pyannote.ai/v1";
const PYANNOTE_DIARIZATION_MODEL = "pyannote-3";
const MAX_RESPONSE_BODY_BYTES = 10 * 1024 * 1024;
const POLL_INTERVAL_MS = 1_000;
// Each attempt can take up to POLL_INTERVAL_MS + the 55s per-request HTTP timeout below, so this
// bounds wall-clock time at roughly 300 * 56s ≈ 4.7h worst case, not 300s — a name like MAX_POLLS
// alone would suggest the shorter figure.
const MAX_POLL_ATTEMPTS = 300;

type PyannoteJob = { jobId?: unknown; status?: unknown; output?: unknown };

function parseJob(value: unknown): PyannoteJob {
  if (!isObject(value)) throw new AudioProviderCallError("pyannoteAI response did not match the expected shape");
  if (value.output !== undefined && !isObject(value.output)) {
    throw new AudioProviderCallError("pyannoteAI job's output did not match the expected shape");
  }
  return value;
}

function parseTurns(output: unknown): DiarizationTurn[] {
  if (!isObject(output)) throw new AudioProviderCallError("pyannoteAI job did not include an output");
  const diarization = output.diarization;
  if (!Array.isArray(diarization)) {
    throw new AudioProviderCallError("pyannoteAI job's output did not include diarization turns");
  }
  return diarization.map((turn) => {
    if (
      !isObject(turn) ||
      typeof turn.speaker !== "string" ||
      typeof turn.start !== "number" ||
      !Number.isFinite(turn.start) ||
      typeof turn.end !== "number" ||
      !Number.isFinite(turn.end) ||
      turn.end < turn.start
    ) {
      throw new AudioProviderCallError("pyannoteAI job included an invalid diarization turn");
    }
    return { speaker: turn.speaker, start: turn.start, end: turn.end };
  });
}

function parseUploadUrl(value: unknown): string {
  if (!isObject(value) || typeof value.url !== "string") {
    throw new AudioProviderCallError("pyannoteAI media upload did not return a URL");
  }
  return value.url;
}

/**
 * pyannoteAI's `/diarize` endpoint fetches its input from a URL it controls, not from bytes
 * posted directly to it — this uploads `request.audio` to pyannoteAI's own presigned storage
 * first (its documented "media input" flow: `POST /media/input {url: "media://<key>"}` returns a
 * presigned PUT URL, then the bytes are PUT there) and hands `/diarize` the resulting `media://`
 * key. This sidesteps needing any publicly-fetchable URL of our own for the source audio — there
 * isn't one, since Semprec's blob storage requires an authenticated session — and it avoids
 * accepting a caller-supplied `audioUrl` that would otherwise need SSRF validation.
 */
async function uploadMedia(headers: Record<string, string>, request: DiarizationRequest): Promise<string> {
  const mediaKey = `media://semprec-${randomUUID()}`;

  let created: Response;
  try {
    created = await fetch(`${PYANNOTE_API_URL}/media/input`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ url: mediaKey }),
      signal: AbortSignal.timeout(55_000),
    });
  } catch (err) {
    throw new AudioProviderCallError(
      `pyannoteAI media upload request failed: ${err instanceof Error ? err.name : "unknown error"}`,
    );
  }
  if (!created.ok) throw new AudioProviderCallError(`pyannoteAI media upload responded with HTTP ${created.status}`);
  const presignedUrl = parseUploadUrl(await readJsonBodyWithSizeCap(created, "pyannoteAI", MAX_RESPONSE_BODY_BYTES));

  let put: Response;
  try {
    put = await fetch(presignedUrl, {
      method: "PUT",
      headers: { "content-type": request.mimeType },
      body: request.audio,
      signal: AbortSignal.timeout(55_000),
    });
  } catch (err) {
    throw new AudioProviderCallError(
      `pyannoteAI media upload PUT failed: ${err instanceof Error ? err.name : "unknown error"}`,
    );
  }
  if (!put.ok) throw new AudioProviderCallError(`pyannoteAI media upload PUT responded with HTTP ${put.status}`);

  return mediaKey;
}

/** pyannoteAI's asynchronous diarization adapter, normalized to speaker turns. */
export function createPyannoteDiarizationProvider(apiKey: string): DiarizationProvider {
  const headers = { Authorization: `Bearer ${apiKey}` };
  return {
    id: "pyannoteai",
    model: PYANNOTE_DIARIZATION_MODEL,
    async diarize(request: DiarizationRequest): Promise<DiarizationTurn[]> {
      const mediaKey = await uploadMedia(headers, request);

      let created: Response;
      try {
        created = await fetch(`${PYANNOTE_API_URL}/diarize`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ url: mediaKey }),
          signal: AbortSignal.timeout(55_000),
        });
      } catch (err) {
        throw new AudioProviderCallError(
          `pyannoteAI request failed: ${err instanceof Error ? err.name : "unknown error"}`,
        );
      }
      if (!created.ok) throw new AudioProviderCallError(`pyannoteAI responded with HTTP ${created.status}`);
      const jobId = parseJob(await readJsonBodyWithSizeCap(created, "pyannoteAI", MAX_RESPONSE_BODY_BYTES)).jobId;
      if (typeof jobId !== "string") throw new AudioProviderCallError("pyannoteAI did not return a job id");

      for (let poll = 0; poll < MAX_POLL_ATTEMPTS; poll += 1) {
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
        const job = parseJob(await readJsonBodyWithSizeCap(response, "pyannoteAI", MAX_RESPONSE_BODY_BYTES));
        if (job.status === "succeeded") return parseTurns(job.output);
        if (job.status === "failed" || job.status === "canceled") {
          throw new AudioProviderCallError(`pyannoteAI job ${job.status}`);
        }
      }
      throw new AudioProviderCallError("pyannoteAI job did not finish before the polling deadline");
    },
  };
}
