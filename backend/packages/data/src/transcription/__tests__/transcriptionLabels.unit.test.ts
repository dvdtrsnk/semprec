import { describe, expect, it, vi } from "vitest";

const { loadModuleCatalogs } = vi.hoisted(() => ({ loadModuleCatalogs: vi.fn() }));

vi.mock("@semprec/module-registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@semprec/module-registry")>();
  loadModuleCatalogs.mockImplementation(actual.loadModuleCatalogs);
  return { ...actual, loadModuleCatalogs };
});

const { renderTranscriptionLabel } = await import("../transcriptionLabels.js");

describe("renderTranscriptionLabel (issue #1818)", () => {
  it("fills the placeholders of the text in the requested language", async () => {
    expect(await renderTranscriptionLabel("cs", "transcript.newMeeting.name", { day: 14, month: 10 })).toBe(
      "Schůzka 14. 10.",
    );
    expect(await renderTranscriptionLabel("en", "transcript.newMeeting.name", { day: 14, month: 10 })).toBe(
      "Meeting 14/10",
    );
  });

  it("reads English for a locale that has no catalog of its own", async () => {
    expect(await renderTranscriptionLabel("de", "transcript.newMeeting.name", { day: 4, month: 9 })).toBe(
      "Meeting 4/9",
    );
  });

  it("leaves a placeholder without a value as written and returns a text without placeholders unchanged", async () => {
    expect(await renderTranscriptionLabel("en", "transcript.newMeeting.name", { day: 4 })).toBe("Meeting 4/{month}");
    expect(await renderTranscriptionLabel("en", "transcript.speaker.genericLabel")).toBe("Speaker");
  });

  it("retries a failed catalog load on the next call instead of caching the rejection", async () => {
    vi.resetModules();
    loadModuleCatalogs.mockClear();
    const { renderTranscriptionLabel: fresh } = await import("../transcriptionLabels.js");
    loadModuleCatalogs.mockRejectedValueOnce(new Error("catalog missing"));

    await expect(fresh("en", "transcript.speaker.genericLabel")).rejects.toThrow("catalog missing");
    expect(await fresh("en", "transcript.speaker.genericLabel")).toBe("Speaker");
    expect(loadModuleCatalogs).toHaveBeenCalledTimes(2);
  });
});
