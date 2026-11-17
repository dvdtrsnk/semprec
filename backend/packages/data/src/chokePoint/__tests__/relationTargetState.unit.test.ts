import { describe, expect, it } from "vitest";
import { PROJECTS_MODULE_ID, TASKS_MODULE_ID } from "../../seed/tenDatabaseKeys.js";
import { relationTargetBlock } from "../relationTargetState.js";

const live = (status?: string) => ({ deletedAt: null, properties: status === undefined ? {} : { status } });

describe("the state of a relation target (issue #1426, read by issue gh-1959)", () => {
  it("is deleted for a trashed item, whatever its database or status", () => {
    const trashed = { deletedAt: "2026-11-01T10:00:00.000Z", properties: { status: "archived" } };

    expect(relationTargetBlock(trashed, PROJECTS_MODULE_ID)).toBe("targetDeleted");
    expect(relationTargetBlock(trashed, null)).toBe("targetDeleted");
  });

  it("is archived for an archived project", () => {
    expect(relationTargetBlock(live("archived"), PROJECTS_MODULE_ID)).toBe("targetArchived");
  });

  it("is linkable for an archived item of another database, and for a database that is not known", () => {
    expect(relationTargetBlock(live("archived"), TASKS_MODULE_ID)).toBeNull();
    expect(relationTargetBlock(live("archived"), null)).toBeNull();
  });

  it("is linkable for a done project, a project in another status and an item with no status", () => {
    expect(relationTargetBlock(live("done"), PROJECTS_MODULE_ID)).toBeNull();
    expect(relationTargetBlock(live("active"), PROJECTS_MODULE_ID)).toBeNull();
    expect(relationTargetBlock(live(), PROJECTS_MODULE_ID)).toBeNull();
  });
});
