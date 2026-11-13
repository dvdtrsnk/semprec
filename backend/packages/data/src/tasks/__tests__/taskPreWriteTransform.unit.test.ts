import { describe, expect, it } from "vitest";
import type { ItemRow } from "../../types.js";
import { prepareTaskProposal, prepareTaskWrite } from "../taskPreWriteTransform.js";

const stored: ItemRow = {
  id: "item",
  databaseId: "tasks",
  properties: { name: "Task" },
  computed: {},
  createdAt: "2026-10-13T00:00:00.000Z",
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

  it("normalizes retained schedule values only when their stored representation changes", async () => {
    const legacy: ItemRow = {
      ...stored,
      properties: { name: "Task", date: "2026-10-13", timeFrom: "9:00", timeTo: "10:00" },
    };
    await expect(prepareTaskWrite({ stored: legacy, patch: { date: "2026-10-14" } })).resolves.toEqual({
      date: "2026-10-14",
      timeFrom: "09:00",
      time: "09:00–10:00",
    });
    await expect(prepareTaskWrite({ stored: legacy, patch: { timeTo: "11:00" } })).resolves.toEqual({
      timeFrom: "09:00",
      timeTo: "11:00",
      time: "09:00–11:00",
    });
    const emptyEnd: ItemRow = { ...legacy, properties: { ...legacy.properties, timeFrom: "09:00", timeTo: "" } };
    await expect(prepareTaskWrite({ stored: emptyEnd, patch: { date: "2026-10-14" } })).resolves.toEqual({
      date: "2026-10-14",
      timeTo: null,
      time: "09:00",
    });
    const canonical: ItemRow = { ...legacy, properties: { ...legacy.properties, timeFrom: "09:00", timeTo: null } };
    await expect(prepareTaskWrite({ stored: canonical, patch: { date: "2026-10-14" } })).resolves.toEqual({
      date: "2026-10-14",
      time: "09:00",
    });
    await expect(
      prepareTaskWrite({ stored: null, patch: { name: "Task", date: "2026-10-13", timeFrom: "9:00" } }),
    ).resolves.toEqual({
      name: "Task",
      date: "2026-10-13",
      timeFrom: "09:00",
      time: "09:00",
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

describe("Tasks status preparation (issue sp-9cf1be65)", () => {
  const notAStatus: [string, unknown][] = [
    ["null", null],
    ["an empty string", ""],
    ["a number", 1],
  ];
  const legacy: ItemRow = { ...stored, properties: { name: "Legacy task" } };

  it.each(notAStatus)("refuses a create that names status %s", async (_name, status) => {
    await expect(prepareTaskWrite({ stored: null, patch: { name: "Task", status } })).rejects.toMatchObject({
      code: "validation_failed",
      message: "Property 'status' must be a task status",
      details: { field: "status" },
    });
  });

  it.each(notAStatus)("refuses an update that names status %s", async (_name, status) => {
    await expect(
      prepareTaskWrite({ stored: { ...stored, properties: { name: "Task", status: "done" } }, patch: { status } }),
    ).rejects.toMatchObject({
      code: "validation_failed",
      details: { field: "status" },
    });
    await expect(prepareTaskWrite({ stored: legacy, patch: { status } })).rejects.toMatchObject({
      code: "validation_failed",
      details: { field: "status" },
    });
  });

  it("refuses the status of a write that names a date as well", async () => {
    await expect(prepareTaskWrite({ stored, patch: { date: "2026-10-14", status: null } })).rejects.toMatchObject({
      details: { field: "status" },
    });
  });

  it("accepts a status string on a create and on an update", async () => {
    await expect(prepareTaskWrite({ stored: null, patch: { name: "Task", status: "done" } })).resolves.toMatchObject({
      name: "Task",
      status: "done",
    });
    await expect(prepareTaskWrite({ stored, patch: { status: "done" } })).resolves.toEqual({ status: "done" });
  });

  it("leaves a create without status unchanged, for the property default to fill in", async () => {
    const prepared = await prepareTaskWrite({ stored: null, patch: { name: "Task" } });
    expect(prepared).not.toHaveProperty("status");
  });

  it("leaves a patch that does not name status unchanged on a legacy row that has none", async () => {
    const patch = { name: "Renamed" };
    const prepared = await prepareTaskWrite({ stored: legacy, patch });
    expect(prepared).toBe(patch);
    const unrelated = { priority: "high" };
    await expect(prepareTaskWrite({ stored: legacy, patch: unrelated })).resolves.toBe(unrelated);
  });

  it("refuses a proposal that names a status that is not a nonempty string and accepts one that does", async () => {
    await expect(prepareTaskProposal({ stored, patch: { status: null } })).rejects.toMatchObject({
      details: { field: "status" },
    });
    await expect(prepareTaskProposal({ stored: null, patch: { name: "Task", status: "" } })).rejects.toMatchObject({
      details: { field: "status" },
    });
    await expect(prepareTaskProposal({ stored, patch: { status: "notDone" } })).resolves.toMatchObject({
      patch: { status: "notDone" },
    });
  });
});
