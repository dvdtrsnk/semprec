import { describe, expect, it } from "vitest";
import {
  filterRecognitionCandidates,
  validRecognitionTypes,
  clarificationTypes,
  recognitionClarificationReason,
  RECOGNITION_CONFIDENCE_THRESHOLD,
  type RecognitionType,
} from "../inboxRecognition.js";
const catalog: RecognitionType[] = [
  { id: "task", label: "Task", emoji: "", processingMethod: "database", targetDatabaseKey: "tasks" },
  { id: "thought", label: "Thought", emoji: "", processingMethod: "pageContent", targetDatabaseKey: null },
];
describe("Inbox recognition", () => {
  it("filters invalid candidates and sorts valid candidates by confidence", () => {
    expect(
      filterRecognitionCandidates(
        [
          { typeId: "unknown", confidence: 1 },
          { targetDatabaseKey: "unknown", confidence: 1 },
          { typeId: "task", confidence: 0.5 },
          { targetDatabaseKey: "mcpServers", confidence: 0.9 },
          { typeId: "thought", confidence: 2 },
        ],
        catalog,
      ),
    ).toEqual([
      { targetDatabaseKey: "mcpServers", confidence: 0.9 },
      { typeId: "task", confidence: 0.5 },
    ]);
    expect(filterRecognitionCandidates(null, catalog)).toEqual([]);
  });
  it("excludes invalid processing configurations", () => {
    expect(validRecognitionTypes([...catalog, { ...catalog[0]!, id: "bad", targetDatabaseKey: "journal" }])).toEqual(
      catalog,
    );
  });
  it("pads distinct type candidates without including direct targets", () => {
    expect(
      clarificationTypes(
        [
          { typeId: "task", confidence: 0.5 },
          { typeId: "task", confidence: 0.4 },
          { targetDatabaseKey: "tasks", confidence: 0.3 },
        ],
        catalog,
      ),
    ).toEqual(
      catalog.map((type) => ({ typeId: type.id, label: type.label, targetDatabaseKey: type.targetDatabaseKey })),
    );
  });
  it.each([0, 1])("offers only the %s available types", (count) => {
    expect(clarificationTypes([], catalog.slice(0, count))).toHaveLength(count);
  });
  it("caps the ranked choices at four", () => {
    const types = Array.from({ length: 5 }, (_, i) => ({ ...catalog[0]!, id: String(i) }));
    expect(
      clarificationTypes(
        types.map((type) => ({ typeId: type.id, confidence: 0.5 })),
        types,
      ),
    ).toHaveLength(4);
  });
  it("uses localized shortage and fallback reasons", async () => {
    expect(await recognitionClarificationReason("en", 0)).toContain("Fewer than two");
    expect(await recognitionClarificationReason("cs", 1)).not.toContain("Fewer than two");
    expect(await recognitionClarificationReason("en", 2, "  Model reason  ")).toBe("Model reason");
    expect(await recognitionClarificationReason("en", 2)).toBe("Choose an item type.");
    expect(RECOGNITION_CONFIDENCE_THRESHOLD).toBe(0.7);
  });
});
