import { ValidationError } from "../errors.js";
import { containsNul } from "./reviseInputChecks.js";

/**
 * How an Inbox item was captured (issue gh-1964), the option keys of the Inbox `captureChannel` select. `voice` only
 * records that the text was dictated on the device: in v1 a voice note arrives as text, with no server-side audio.
 */
export const CAPTURE_CHANNELS = ["typed", "voice", "share"] as const;

export type CaptureChannel = (typeof CAPTURE_CHANNELS)[number];

/** The longest `sourceApp` the capture route stores, counted after trimming. */
export const SOURCE_APP_MAX_LENGTH = 80;

/** What a capture says about where the text came from: the channel, and for a share the displayed name of the app. */
export interface CaptureSource {
  captureChannel: CaptureChannel;
  sourceApp?: string;
}

function isCaptureChannel(value: unknown): value is CaptureChannel {
  return CAPTURE_CHANNELS.some((channel) => channel === value);
}

/**
 * Reads `captureChannel` and `sourceApp` from the body of `POST /api/inbox/items`. The channel is required and must be
 * one of `CAPTURE_CHANNELS`. `sourceApp` is optional: a string holding no U+0000 (which Postgres cannot store), trimmed,
 * and at most `SOURCE_APP_MAX_LENGTH` characters after trimming. A `sourceApp` that is blank after trimming names no
 * app and is not stored. Every refusal is a `ValidationError` on the failing field.
 */
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
