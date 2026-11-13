import { describe, expect, it } from "vitest";
import { ValidationError } from "../../errors.js";
import { parseFilterNode, type FilterNode } from "../../views/filterTree.js";
import { parseViewConfig } from "../../views/viewConfig.js";
import { TASKS_TODAY_VIEW_KEY, tasksTodayFilter, tasksVisibleFilter } from "../todayView.js";

/** The conditions of a tree in depth-first order, as `type property[ preset]` strings. */
function conditions(node: FilterNode): string[] {
  switch (node.type) {
    case "and":
    case "or":
      return node.nodes.flatMap(conditions);
    case "not":
      return conditions(node.node);
    case "date_relative":
      return [`${node.type} ${node.property} ${JSON.stringify(node.preset)}`];
    case "equals":
    case "not_equals":
      return [`${node.type} ${node.property} ${String(node.value)}`];
    case "relation_path_contains":
      return [`${node.type} ${node.path.join(".")}`];
    default:
      return [`${node.type} ${node.property}`];
  }
}

describe("the Today filters (issue #1798)", () => {
  it("names the key clients look the view up by", () => {
    expect(TASKS_TODAY_VIEW_KEY).toBe("today");
  });

  it("builds trees the filter grammar accepts", () => {
    for (const tree of [
      tasksVisibleFilter(),
      tasksTodayFilter({ openOnly: false }),
      tasksTodayFilter({ openOnly: true }),
    ]) {
      expect(parseFilterNode(tree)).toEqual(tree);
    }
  });

  it("defines visibility as an empty or passed hiddenUntil and no completedInEvent edge", () => {
    expect(conditions(tasksVisibleFilter())).toEqual([
      "is_empty hiddenUntil",
      'date_relative hiddenUntil "beforeNow"',
      "relation_is_empty completedInEvent",
    ]);
  });

  it("returns a fresh tree on every call, so a caller cannot change the definition", () => {
    const first = tasksTodayFilter({ openOnly: false });
    expect(tasksTodayFilter({ openOnly: false })).not.toBe(first);
    expect(tasksVisibleFilter()).not.toBe(tasksVisibleFilter());
  });

  it("defines the list as visible AND one of the four day rules", () => {
    const tree = tasksTodayFilter({ openOnly: false });
    if (tree.type !== "and") throw new Error("expected an and node");
    expect(tree.nodes[0]).toEqual(tasksVisibleFilter());
    expect(conditions({ type: "and", nodes: tree.nodes.slice(1) })).toEqual([
      "not_equals status done",
      'date_relative effectiveDate "today"',
      'date_relative effectiveDate "past"',
      "equals status notDone",
      "equals status done",
      'date_relative completedOn "today"',
      "equals status done",
      "is_empty completedOn",
      'date_relative effectiveDate "today"',
    ]);
  });

  it("adds exactly one notDone condition for openOnly and nothing for the list", () => {
    const list = tasksTodayFilter({ openOnly: false });
    const open = tasksTodayFilter({ openOnly: true });
    expect(open).toEqual({ type: "and", nodes: [list, { type: "equals", property: "status", value: "notDone" }] });
    expect(open).not.toEqual(list);
  });
});

describe("the systemKey of a view config (issue #1798)", () => {
  it("is kept when it is a non-empty string", () => {
    expect(parseViewConfig({ systemKey: "today" }).systemKey).toBe("today");
  });

  it("is optional", () => {
    expect(parseViewConfig({}).systemKey).toBeUndefined();
  });

  it.each([
    ["empty string", ""],
    ["number", 7],
    ["null", null],
  ])("rejects a %s", (_name, systemKey) => {
    expect(() => parseViewConfig({ systemKey })).toThrow(ValidationError);
  });
});
