import { isIP } from "node:net";
import { AudioProviderCallError, type DiarizationProvider, type DiarizationTurn } from "./types.js";
import { readJsonBodyWithSizeCap } from "./httpUtils.js";

const PYANNOTE_API_URL = "https://api.pyannote.ai/v1";
const PYANNOTE_DIARIZATION_MODEL = "pyannote-3";
const MAX_RESPONSE_BODY_BYTES = 10 * 1024 * 1024;
const POLL_INTERVAL_MS = 1_000;
const MAX_POLLS = 300;

/** IPv4 octets or lowercased IPv6 groups that are loopback, link-local, or RFC 1918/4193 private. */
function isPrivateOrReservedIp(hostname: string, family: 4 | 6): boolean {
  if (family === 4) {
    const [a = 0, b = 0] = hostname.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  const lower = hostname.toLowerCase();
  return (
    lower === "::1" || lower === "::" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80")
  );
}

/**
 * pyannoteAI's API fetches `audioUrl` itself on our behalf, so an unvalidated caller-supplied
 * URL is an SSRF vector: it could point at a private/loopback address or a cloud metadata
 * endpoint. Rejects anything that isn't an https URL with a public-looking host up front —
 * this is a static check, not a DNS-rebinding-proof guarantee, but it stops the direct
 * literal-IP and localhost cases the finding calls out.
 */
function assertPublicAudioUrl(audioUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(audioUrl);
  } catch {
    throw new AudioProviderCallError("audioUrl is not a valid URL");
  }
  if (parsed.protocol !== "https:") {
    throw new AudioProviderCallError("audioUrl must use https");
  }
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".internal") || hostname.endsWith(".local")) {
    throw new AudioProviderCallError("audioUrl targets a disallowed host");
  }
  const family = isIP(hostname);
  if (family && isPrivateOrReservedIp(hostname, family as 4 | 6)) {
    throw new AudioProviderCallError("audioUrl targets a private or reserved address");
  }
}

type PyannoteJob = { jobId?: unknown; status?: unknown; output?: unknown };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

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
      !Number.isFinite(turn.end)
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
    model: PYANNOTE_DIARIZATION_MODEL,
    async diarize({ audioUrl }): Promise<DiarizationTurn[]> {
      assertPublicAudioUrl(audioUrl);

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
      const jobId = parseJob(await readJsonBodyWithSizeCap(created, "pyannoteAI", MAX_RESPONSE_BODY_BYTES)).jobId;
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
