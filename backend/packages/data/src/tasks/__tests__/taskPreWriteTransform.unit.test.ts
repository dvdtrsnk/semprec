import { describe, expect, it } from "vitest";
import type { ItemRow } from "../../types.js";
import { prepareTaskWrite } from "../taskPreWriteTransform.js";

const stored: ItemRow = {
  id: "item",
  databaseId: "tasks",
  properties: { name: "Task" },
  computed: {},
  updatedAt: "2026-10-13T00:00:00.000Z",
  deletedAt: null,
};

describe("Tasks schedule preparation", () => {
  it("emits all explicit null fields for an undated create and date-off patch", async () => {
    await expect(prepareTaskWrite({ stored: null, patch: { name: "Task" } })).resolves.toEqual({
      name: "Task",
      timeFrom: null,
      timeTo: null,
      time: null,
    });
    await expect(prepareTaskWrite({ stored, patch: { date: null } })).resolves.toEqual({
      date: null,
      timeFrom: null,
      timeTo: null,
      time: null,
    });
  });

  it("still rejects a nonempty start without a date", async () => {
    await expect(prepareTaskWrite({ stored, patch: { timeFrom: "10:00" } })).rejects.toMatchObject({
      code: "validation_failed",
      details: { field: "timeFrom" },
    });
  });

  it("leaves an unrelated update of a legacy schedule alone", async () => {
    const legacy: ItemRow = { ...stored, properties: { name: "Task", timeTo: "09:00" } };
    await expect(prepareTaskWrite({ stored: legacy, patch: { status: "done" } })).resolves.toEqual({ status: "done" });
  });
});
