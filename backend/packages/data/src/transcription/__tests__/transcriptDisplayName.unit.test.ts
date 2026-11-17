import { describe, expect, it } from "vitest";
import { presentText, resolveTranscriptDisplayName, resolveTranscriptSuggestedName } from "../transcriptDisplayName.js";

// 11:52Z on 14 October 2024 is 13:52 in Prague (UTC+2) and 07:52 in New York (UTC-4).
const RECORDED_AT = "2024-10-14T11:52:00.000Z";

describe("resolveTranscriptDisplayName (issue #1830)", () => {
  it("is the user-entered name, ahead of the Event's name and the recording date", async () => {
    expect(
      await resolveTranscriptDisplayName(
        { name: "Pricing call", eventName: "Sprint planning", date: RECORDED_AT },
        "Europe/Prague",
        "en",
      ),
    ).toBe("Pricing call");
  });

  it("is the live linked Event's name when the user typed none", async () => {
    expect(
      await resolveTranscriptDisplayName(
        { name: null, eventName: "Sprint planning", date: RECORDED_AT },
        "Europe/Prague",
        "en",
      ),
    ).toBe("Sprint planning");
    expect(
      await resolveTranscriptDisplayName(
        { name: undefined, eventName: "Sprint planning", date: undefined },
        "Europe/Prague",
        "en",
      ),
    ).toBe("Sprint planning");
  });

  it("is 'Recording D. M. HH:MM' in the tenant zone and the reader's language without a name and an Event", async () => {
    const facts = { name: null, eventName: null, date: RECORDED_AT };

    expect(await resolveTranscriptDisplayName(facts, "Europe/Prague", "en")).toBe("Recording 14. 10. 13:52");
    expect(await resolveTranscriptDisplayName(facts, "Europe/Prague", "cs")).toBe("Nahrávka 14. 10. 13:52");
    expect(await resolveTranscriptDisplayName(facts, "America/New_York", "en")).toBe("Recording 14. 10. 07:52");
  });

  it("does not pad the day and the month", async () => {
    expect(
      await resolveTranscriptDisplayName(
        { name: null, eventName: null, date: "2024-03-05T08:05:00.000Z" },
        "UTC",
        "en",
      ),
    ).toBe("Recording 5. 3. 08:05");
  });

  it.each([
    ["a blank name", { name: "   ", eventName: null }],
    ["an empty name", { name: "", eventName: null }],
    ["a blank Event name", { name: null, eventName: " " }],
  ])("treats %s as absent", async (_label, names) => {
    expect(await resolveTranscriptDisplayName({ ...names, date: RECORDED_AT }, "Europe/Prague", "en")).toBe(
      "Recording 14. 10. 13:52",
    );
  });

  it.each([
    ["no date", null],
    ["an unreadable date", "not a date"],
  ])("is null for %s when there is neither a name nor an Event", async (_label, date) => {
    expect(await resolveTranscriptDisplayName({ name: null, eventName: null, date }, "Europe/Prague", "en")).toBeNull();
  });

  it("refuses an invalid tenant zone instead of formatting a wrong time", async () => {
    await expect(
      resolveTranscriptDisplayName({ name: null, eventName: null, date: RECORDED_AT }, "Mars/Olympus", "en"),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });
});

describe("resolveTranscriptSuggestedName (issue #1830)", () => {
  it("is the generated title when there is no name and no live Event", () => {
    expect(resolveTranscriptSuggestedName({ name: null, eventName: null, generatedTitle: "Pricing review" })).toBe(
      "Pricing review",
    );
  });

  it("is null once the user has a name", () => {
    expect(
      resolveTranscriptSuggestedName({ name: "Pricing call", eventName: null, generatedTitle: "Pricing review" }),
    ).toBeNull();
  });

  it("is null while the transcript is linked to a live Event", () => {
    expect(
      resolveTranscriptSuggestedName({ name: null, eventName: "Sprint planning", generatedTitle: "Pricing review" }),
    ).toBeNull();
  });

  it.each([null, undefined, "", "  "])("is null for the generated title %j", (generatedTitle) => {
    expect(resolveTranscriptSuggestedName({ name: null, eventName: null, generatedTitle })).toBeNull();
  });

  it("treats a blank name and a blank Event name as absent", () => {
    expect(resolveTranscriptSuggestedName({ name: " ", eventName: "", generatedTitle: "Pricing review" })).toBe(
      "Pricing review",
    );
  });
});

describe("presentText", () => {
  it("returns a non-blank string as it is and anything else as null", () => {
    expect(presentText("  a ")).toBe("  a ");
    expect([presentText(""), presentText("  "), presentText(null), presentText(3)]).toEqual([null, null, null, null]);
  });
});
