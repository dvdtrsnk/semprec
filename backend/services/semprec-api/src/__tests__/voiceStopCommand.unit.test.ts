import { describe, expect, it } from "vitest";
import { isVoiceStopCommand, VOICE_STOP_COMMANDS } from "../voiceStopCommand.js";

describe("isVoiceStopCommand", () => {
  it("keeps the closed list of commands", () => {
    expect(VOICE_STOP_COMMANDS).toEqual(["stop", "zruš"]);
  });

  it.each([
    "stop",
    "Stop",
    "STOP",
    "Stop.",
    "stop!",
    "Stop...",
    "  Stop. ",
    "stop ,",
    "zruš",
    "Zruš",
    "ZRUŠ",
    "Zruš.",
    "zruš!?",
  ])("recognizes %j", (transcript) => {
    expect(isVoiceStopCommand(transcript)).toBe(true);
  });

  it("recognizes a command spelled with a combining caron", () => {
    expect(isVoiceStopCommand("Zruš.")).toBe(true);
  });

  it.each([
    "stop the music",
    "Please stop",
    "stop stop",
    "Stop, zruš",
    "don't stop",
    "zrušit",
    "zrus",
    "stoppen",
    ".stop",
    "stop. now",
    "",
    "   ",
    "...",
  ])("does not recognize %j", (transcript) => {
    expect(isVoiceStopCommand(transcript)).toBe(false);
  });
});
