import { ValidationError } from "../errors.js";
import { containsNul } from "./reviseInputChecks.js";

/** `voice` only records that the text was dictated on the device; no audio reaches the server. */
export const CAPTURE_CHANNELS = ["typed", "voice", "share"] as const;

export type CaptureChannel = (typeof CAPTURE_CHANNELS)[number];

export const SOURCE_APP_MAX_LENGTH = 80;

export interface CaptureSource {
  captureChannel: CaptureChannel;
  sourceApp?: string;
}

function isCaptureChannel(value: unknown): value is CaptureChannel {
  return CAPTURE_CHANNELS.some((channel) => channel === value);
}

/** `sourceApp` may not hold U+0000 (Postgres cannot store it); a blank one is not stored. */
export function parseCaptureSource(body: Record<string, unknown>): CaptureSource {
  const { captureChannel, sourceApp } = body;
  if (!isCaptureChannel(captureChannel)) {
    throw new ValidationError(`'captureChannel' must be one of ${CAPTURE_CHANNELS.join(", ")}`, {
      field: "captureChannel",
    });
  }
  if (sourceApp === undefined) return { captureChannel };
  if (typeof sourceApp !== "string") {
    throw new ValidationError("'sourceApp' must be a string", { field: "sourceApp" });
  }
  if (containsNul(sourceApp)) {
    throw new ValidationError("'sourceApp' must not contain NUL characters", { field: "sourceApp" });
  }
  const trimmed = sourceApp.trim();
  if (trimmed.length > SOURCE_APP_MAX_LENGTH) {
    throw new ValidationError(`'sourceApp' must be at most ${SOURCE_APP_MAX_LENGTH} characters`, {
      field: "sourceApp",
    });
  }
  return trimmed.length === 0 ? { captureChannel } : { captureChannel, sourceApp: trimmed };
}
