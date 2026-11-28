/** A final transcript must equal exactly one of them. */
export const VOICE_STOP_COMMANDS = ["stop", "zruš"] as const;

/**
 * After trimming, lower-casing and removing trailing punctuation. A longer sentence containing one
 * of the words is no command.
 */
export function isVoiceStopCommand(transcript: string): boolean {
  const normalized = transcript
    .normalize("NFC")
    .trim()
    .toLowerCase()
    .replace(/[\p{P}\s]+$/u, "");
  return VOICE_STOP_COMMANDS.some((command) => command === normalized);
}
