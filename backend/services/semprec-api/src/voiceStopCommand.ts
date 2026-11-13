/** The spoken commands that cancel a running Semp turn: a final transcript that equals exactly one of them. */
export const VOICE_STOP_COMMANDS = ["stop", "zruš"] as const;

/**
 * Whether a final transcript is a stop command: after trimming, lower-casing and removing trailing punctuation it
 * equals exactly one entry of `VOICE_STOP_COMMANDS`. A longer sentence that contains one of the words is no command.
 */
export function isVoiceStopCommand(transcript: string): boolean {
  const normalized = transcript
    .normalize("NFC")
    .trim()
    .toLowerCase()
    .replace(/[\p{P}\s]+$/u, "");
  return VOICE_STOP_COMMANDS.some((command) => command === normalized);
}
