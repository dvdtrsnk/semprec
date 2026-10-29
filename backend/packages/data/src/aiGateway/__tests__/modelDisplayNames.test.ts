import { beforeAll, describe, expect, it } from "vitest";
import type { ModuleCatalogs } from "@semprec/module-registry";
import { getModelDisplayCatalogs, resolveModelDisplayName } from "../modelDisplayNames.js";

describe("resolveModelDisplayName", () => {
  let catalogs: ModuleCatalogs;
  beforeAll(async () => {
    catalogs = await getModelDisplayCatalogs();
  });

  it("maps every Sonnet and Haiku version to one name per family", () => {
    for (const id of ["claude-sonnet-4-5", "claude-sonnet-5-5", "claude-sonnet-4-20250514"]) {
      expect(resolveModelDisplayName(catalogs, "en", id)).toBe("Claude Sonnet");
      expect(resolveModelDisplayName(catalogs, "cs", id)).toBe("Claude Sonnet");
    }
    for (const id of ["claude-haiku-4-5", "claude-haiku-3-5-20241022"]) {
      expect(resolveModelDisplayName(catalogs, "en", id)).toBe("Claude Haiku");
      expect(resolveModelDisplayName(catalogs, "cs", id)).toBe("Claude Haiku");
    }
  });

  it("maps whisper ids with and without a provider prefix", () => {
    expect(resolveModelDisplayName(catalogs, "en", "whisper-large-v3")).toBe("Whisper");
    expect(resolveModelDisplayName(catalogs, "cs", "openai/whisper-large-v3")).toBe("Whisper");
  });

  it("localizes the diarization name", () => {
    expect(resolveModelDisplayName(catalogs, "cs", "pyannote-3")).toBe("Diarizace");
    expect(resolveModelDisplayName(catalogs, "en", "pyannote-3")).toBe("Diarization");
  });

  it("falls back to English for an unknown locale", () => {
    expect(resolveModelDisplayName(catalogs, "de", "pyannote-3")).toBe("Diarization");
  });

  it("returns an id outside the mapped families unchanged", () => {
    expect(resolveModelDisplayName(catalogs, "en", "gpt-x")).toBe("gpt-x");
    expect(resolveModelDisplayName(catalogs, "en", "claude-opus-4")).toBe("claude-opus-4");
    expect(resolveModelDisplayName(catalogs, "en", "Claude-Sonnet-4")).toBe("Claude-Sonnet-4");
  });
});
