import { describe, expect, it } from "vitest";
import type { AgentRunEventKind, AgentRunEventRow } from "../../agentRuns/agentRunEventsStore.js";
import { projectSempReplyChanges } from "../sempReplyChanges.js";
import type { SempReplyTargets } from "../sempReplyTargets.js";

const T0 = Date.parse("2026-11-01T10:00:00.000Z");
const TASKS_DB = "11111111-1111-4111-8111-111111111111";
const HEALTH_DB = "22222222-2222-4222-8222-222222222222";
const TASK_A = "33333333-3333-4333-8333-333333333333";
const TASK_B = "44444444-4444-4444-8444-444444444444";
const RECORD = "55555555-5555-4555-8555-555555555555";
const NEW_TASK = "66666666-6666-4666-8666-666666666666";
const RELATION_PROPERTY = "77777777-7777-4777-8777-777777777777";
const UNKNOWN_ID = "88888888-8888-4888-8888-888888888888";

let nextId = 1;
let clock = 0;
function event(kind: AgentRunEventKind, payload: unknown): AgentRunEventRow {
  clock += 10;
  return { id: String(nextId++), agentRunId: "run", kind, payload, at: new Date(T0 + clock).toISOString() };
}

interface Call {
  toolCallId: string;
  operation?: string;
  name?: string;
  args?: unknown;
  targetItemId?: string;
  mcp?: { toolRegistrationId: string; serverItemId: string; serverName: string; toolName: string };
}

function metadata(call: Call) {
  return {
    ...(call.operation ? { operation: call.operation } : {}),
    ...(call.mcp ? { mcp: call.mcp } : {}),
    ...(call.targetItemId ? { targetItemId: call.targetItemId } : {}),
  };
}

function use(call: Call) {
  return event("tool_use", {
    kind: "tool_use",
    toolCallId: call.toolCallId,
    name: call.name ?? "tool",
    arguments: call.args ?? {},
    ...metadata(call),
  });
}

function result(
  call: Call,
  outcome: { output?: unknown; text?: string; details?: Record<string, unknown>; isError?: boolean } = {},
) {
  const text = outcome.text ?? (outcome.output === undefined ? "{}" : JSON.stringify(outcome.output));
  return event("tool_result", {
    kind: "tool_result",
    toolCallId: call.toolCallId,
    name: call.name ?? "tool",
    result: { content: [{ type: "text", text }], details: outcome.details ?? { error: false } },
    isError: outcome.isError ?? false,
    ...metadata(call),
  });
}

/** A call and its result, as the run log stores them. */
function played(call: Call, outcome?: Parameters<typeof result>[1]) {
  return [use(call), result(call, outcome)];
}

const item = (id: string, databaseId = TASKS_DB) => ({ id, databaseId, properties: {} });

const targets: SempReplyTargets = {
  items: new Map([
    [TASK_A, { databaseId: TASKS_DB, name: "A" }],
    [TASK_B, { databaseId: TASKS_DB, name: "B" }],
    [RECORD, { databaseId: HEALTH_DB, name: "Record" }],
    [NEW_TASK, { databaseId: TASKS_DB, name: "New" }],
  ]),
  databases: new Map([
    [TASKS_DB, { moduleId: "tasks", sensitive: false }],
    [HEALTH_DB, { moduleId: "healthRecords", sensitive: true }],
  ]),
  properties: new Map([[RELATION_PROPERTY, { key: "project" }]]),
};

const patchOf = (id: string, itemId: string): Call => ({
  toolCallId: id,
  operation: "item.patch",
  name: "item_patch",
  targetItemId: itemId,
  args: { itemId, properties: {}, ifVersion: "1" },
});

const project = (events: AgentRunEventRow[], overrides: Partial<SempReplyTargets> = {}) =>
  projectSempReplyChanges({ events, targets: { ...targets, ...overrides } });

describe("projectSempReplyChanges", () => {
  it("is an empty array for a turn that changed nothing", () => {
    const read: Call = { toolCallId: "r", operation: "item.get", name: "item_get", targetItemId: TASK_A };
    expect(project([])).toEqual([]);
    expect(project(played(read, { output: item(TASK_A) }))).toEqual([]);
  });

  it("records a moved task as updated, with the previous value of the changed key", () => {
    const call = patchOf("p", TASK_A);

    const changes = project(
      played(call, {
        output: item(TASK_A),
        details: { error: false, changes: [{ key: "date", before: "2026-11-02", after: "2026-11-03" }] },
      }),
    );

    expect(changes).toEqual([
      {
        itemId: TASK_A,
        databaseId: TASKS_DB,
        change: "updated",
        changedKeys: ["date"],
        before: { date: "2026-11-02" },
      },
    ]);
  });

  it("lists a changed key the operation reported no previous value for, and omits an empty before", () => {
    const call = patchOf("p", TASK_A);

    const changes = project(
      played(call, { output: item(TASK_A), details: { error: false, changes: [{ key: "date", after: "x" }] } }),
    );

    expect(changes).toEqual([{ itemId: TASK_A, databaseId: TASKS_DB, change: "updated", changedKeys: ["date"] }]);
  });

  it("bounds a long previous value", () => {
    const call = patchOf("p", TASK_A);
    const changes = project(
      played(call, {
        output: item(TASK_A),
        details: { error: false, changes: [{ key: "note", before: "x".repeat(500), after: "y" }] },
      }),
    );
    expect(String(changes[0]?.before?.note).length).toBeLessThanOrEqual(201);
  });

  it("records a created task with the item and database of the result and the keys that were set, without before", () => {
    const call: Call = {
      toolCallId: "c",
      operation: "item.create",
      name: "item_create",
      args: { databaseId: TASKS_DB, properties: { name: "New", date: "2026-11-05" } },
    };

    const changes = project(played(call, { output: item(NEW_TASK) }));

    expect(changes).toEqual([
      { itemId: NEW_TASK, databaseId: TASKS_DB, change: "created", changedKeys: ["name", "date"] },
    ]);
    expect(changes[0]).not.toHaveProperty("before");
  });

  it("records a create in a sensitive database through the id the tool kept, with no key and no before", () => {
    const call: Call = {
      toolCallId: "c",
      operation: "item.create",
      name: "item_create",
      args: "[redacted: sensitive]",
    };

    const changes = project(
      played(call, { text: "[redacted: sensitive]", details: { error: false, createdItemId: RECORD } }),
    );

    expect(changes).toEqual([{ itemId: RECORD, databaseId: HEALTH_DB, change: "created", changedKeys: [] }]);
    expect(changes[0]).not.toHaveProperty("before");
  });

  it("records no created item when the result is redacted and the tool kept no id", () => {
    const call: Call = {
      toolCallId: "c",
      operation: "item.create",
      name: "item_create",
      args: { databaseId: HEALTH_DB, properties: {} },
    };
    expect(project(played(call, { text: "[redacted: sensitive]" }))).toEqual([]);
  });

  it("records a create whose arguments were stored redacted, with no keys", () => {
    const call: Call = {
      toolCallId: "c",
      operation: "item.create",
      name: "item_create",
      args: "[redacted: sensitive]",
    };
    expect(project(played(call, { output: item(NEW_TASK) }))).toEqual([
      { itemId: NEW_TASK, databaseId: TASKS_DB, change: "created", changedKeys: [] },
    ]);
  });

  it("adds the relation properties a create linked to its keys, once, and ignores an empty link", () => {
    const call: Call = {
      toolCallId: "c",
      operation: "item.create",
      name: "item_create",
      args: {
        databaseId: TASKS_DB,
        properties: { name: "New", project: "dup" },
        relations: [
          { propertyKey: "project", targetItemIds: [TASK_A] },
          { propertyKey: "people", targetItemIds: [TASK_A, TASK_B] },
          { propertyKey: "area", targetItemIds: [] },
          { propertyKey: 5, targetItemIds: [TASK_A] },
        ],
      },
    };
    expect(project(played(call, { output: item(NEW_TASK) }))[0]?.changedKeys).toEqual(["name", "project", "people"]);
  });

  it("records no entry for a create whose answer is not an item", () => {
    const call: Call = { toolCallId: "c", operation: "item.create", name: "item_create", args: { properties: {} } };
    expect(project(played(call, { text: "not json at all" }))).toEqual([]);
    expect(project(played({ ...call, toolCallId: "d" }, { output: { id: 5 } }))).toEqual([]);
    expect(project(played({ ...call, toolCallId: "e" }, { output: [1, 2] }))).toEqual([]);
  });

  it("takes the database of a created item from where the item is found, not from the result's text", () => {
    const call: Call = {
      toolCallId: "c",
      operation: "item.create",
      name: "item_create",
      args: { databaseId: HEALTH_DB, properties: { name: "x" } },
    };
    const answer = { id: NEW_TASK, databaseId: HEALTH_DB, properties: {} };

    expect(project(played(call, { output: answer }))).toEqual([
      { itemId: NEW_TASK, databaseId: TASKS_DB, change: "created", changedKeys: ["name"] },
    ]);
  });

  it("records no entry for a created item that is not found in the caller's tenant scope", () => {
    const call: Call = {
      toolCallId: "c",
      operation: "item.create",
      name: "item_create",
      args: { databaseId: TASKS_DB, properties: { name: "x" } },
    };
    expect(project(played(call, { output: item(UNKNOWN_ID) }))).toEqual([]);
  });

  it("records a delete that was waiting for approval as no change", () => {
    const call: Call = { toolCallId: "d", operation: "item.delete", name: "item_delete", targetItemId: TASK_A };
    const changes = project(
      played(call, { text: "Approval request x has been created", details: { error: false, approvalRequestId: "x" } }),
    );
    expect(changes).toEqual([]);
  });

  it("records a delete and a restore that ran", () => {
    const del: Call = { toolCallId: "d", operation: "item.delete", name: "item_delete", targetItemId: TASK_A };
    const restore: Call = { toolCallId: "r", operation: "item.restore", name: "item_restore", targetItemId: TASK_B };

    const changes = project([...played(del, { output: item(TASK_A) }), ...played(restore, { output: item(TASK_B) })]);

    expect(changes).toEqual([
      { itemId: TASK_A, databaseId: TASKS_DB, change: "deleted", changedKeys: [] },
      { itemId: TASK_B, databaseId: TASKS_DB, change: "restored", changedKeys: [] },
    ]);
  });

  it("finds the item of a delete whose result is redacted through the item the arguments name", () => {
    const del: Call = { toolCallId: "d", operation: "item.delete", name: "item_delete", targetItemId: RECORD };
    expect(project(played(del, { text: "[redacted: sensitive]" }))).toEqual([
      { itemId: RECORD, databaseId: HEALTH_DB, change: "deleted", changedKeys: [] },
    ]);
  });

  it("records no entry for a call that failed, in either of the ways a result says so", () => {
    const flagged = patchOf("f1", TASK_A);
    const detailed = patchOf("f2", TASK_B);
    const changes = project([
      ...played(flagged, { isError: true, text: "version_conflict" }),
      ...played(detailed, { details: { error: true, changes: [{ key: "date", before: "a", after: "b" }] } }),
    ]);
    expect(changes).toEqual([]);
  });

  it("records no entry for a call that has no result", () => {
    expect(project([use(patchOf("cut", TASK_A))])).toEqual([]);
  });

  it("records no entry for a tool that is not in the mapping, nor for an MCP tool that names an item", () => {
    const list: Call = { toolCallId: "l", operation: "database.list", name: "database_list" };
    const mcp: Call = {
      toolCallId: "m",
      name: "mcp_patch_aaaaaaaa",
      mcp: { toolRegistrationId: "r", serverItemId: "s", serverName: "Server", toolName: "patch" },
      args: { itemId: TASK_A },
      targetItemId: TASK_A,
    };
    const named: Call = { toolCallId: "n", name: "item_patch", args: { itemId: TASK_A } };
    expect(project([...played(list), ...played(mcp, { output: item(TASK_A) }), ...played(named)])).toEqual([]);
  });

  it("records no entry for an item that cannot be placed in a database", () => {
    const call = patchOf("u", UNKNOWN_ID);
    expect(
      project(played(call, { details: { error: false, changes: [{ key: "date", before: "a", after: "b" }] } })),
    ).toEqual([]);
  });

  describe("merging the changes of one item", () => {
    it("unites the keys of two patches and keeps the value each key had before the first change of it", () => {
      const first = patchOf("p1", TASK_A);
      const second = patchOf("p2", TASK_A);

      const changes = project([
        ...played(first, {
          output: item(TASK_A),
          details: { error: false, changes: [{ key: "date", before: "d0", after: "d1" }] },
        }),
        ...played(second, {
          output: item(TASK_A),
          details: {
            error: false,
            changes: [
              { key: "date", before: "d1", after: "d2" },
              { key: "name", before: "n0", after: "n1" },
            ],
          },
        }),
      ]);

      expect(changes).toEqual([
        {
          itemId: TASK_A,
          databaseId: TASKS_DB,
          change: "updated",
          changedKeys: ["date", "name"],
          before: { date: "d0", name: "n0" },
        },
      ]);
    });

    it("does not take a later value as the before of a key whose first change reported none", () => {
      const first = patchOf("p1", TASK_A);
      const second = patchOf("p2", TASK_A);

      const changes = project([
        ...played(first, { output: item(TASK_A), details: { error: false, changes: [{ key: "date", after: "d1" }] } }),
        ...played(second, {
          output: item(TASK_A),
          details: { error: false, changes: [{ key: "date", before: "d1", after: "d2" }] },
        }),
      ]);

      expect(changes).toEqual([{ itemId: TASK_A, databaseId: TASKS_DB, change: "updated", changedKeys: ["date"] }]);
    });

    it("keeps different items apart, in the order of their first change", () => {
      const changes = project([
        ...played(patchOf("a1", TASK_A), { output: item(TASK_A), details: { error: false, changes: [{ key: "x" }] } }),
        ...played(patchOf("b1", TASK_B), { output: item(TASK_B), details: { error: false, changes: [{ key: "y" }] } }),
        ...played(patchOf("a2", TASK_A), { output: item(TASK_A), details: { error: false, changes: [{ key: "z" }] } }),
      ]);

      expect(changes.map((change) => [change.itemId, change.changedKeys])).toEqual([
        [TASK_A, ["x", "z"]],
        [TASK_B, ["y"]],
      ]);
    });

    it("keeps an item the reply created as created however it was changed afterwards, without a before", () => {
      const create: Call = {
        toolCallId: "c",
        operation: "item.create",
        name: "item_create",
        args: { databaseId: TASKS_DB, properties: { name: "New" } },
      };
      const patch = patchOf("p", NEW_TASK);

      const changes = project([
        ...played(create, { output: item(NEW_TASK) }),
        ...played(patch, {
          output: item(NEW_TASK),
          details: { error: false, changes: [{ key: "date", before: "d0", after: "d1" }] },
        }),
      ]);

      expect(changes).toEqual([
        { itemId: NEW_TASK, databaseId: TASKS_DB, change: "created", changedKeys: ["name", "date"] },
      ]);
    });

    it("takes the kind of the last change, and a delete ends even a created item", () => {
      const patched = patchOf("p", TASK_A);
      const del: Call = { toolCallId: "d", operation: "item.delete", name: "item_delete", targetItemId: TASK_A };
      const create: Call = {
        toolCallId: "c",
        operation: "item.create",
        name: "item_create",
        args: { databaseId: TASKS_DB, properties: { name: "New" } },
      };
      const delNew: Call = { toolCallId: "dn", operation: "item.delete", name: "item_delete", targetItemId: NEW_TASK };

      const changes = project([
        ...played(patched, { output: item(TASK_A), details: { error: false, changes: [{ key: "x", before: "b" }] } }),
        ...played(del, { output: item(TASK_A) }),
        ...played(create, { output: item(NEW_TASK) }),
        ...played(delNew, { output: item(NEW_TASK) }),
      ]);

      expect(changes).toEqual([
        { itemId: TASK_A, databaseId: TASKS_DB, change: "deleted", changedKeys: ["x"], before: { x: "b" } },
        { itemId: NEW_TASK, databaseId: TASKS_DB, change: "deleted", changedKeys: ["name"] },
      ]);
    });
  });

  describe("a sensitive database", () => {
    it("stores no before when the result is redacted", () => {
      const call = patchOf("s", RECORD);
      const changes = project(
        played(call, { text: "[redacted: sensitive]", details: { error: false, changes: [{ key: "name" }] } }),
      );
      expect(changes).toEqual([{ itemId: RECORD, databaseId: HEALTH_DB, change: "updated", changedKeys: ["name"] }]);
    });

    it("stores no before when the database is marked sensitive, whatever the result carries", () => {
      const call = patchOf("s", RECORD);
      const changes = project(
        played(call, {
          output: item(RECORD, HEALTH_DB),
          details: { error: false, changes: [{ key: "name", before: "SECRET", after: "x" }] },
        }),
      );
      expect(changes).toEqual([{ itemId: RECORD, databaseId: HEALTH_DB, change: "updated", changedKeys: ["name"] }]);
      expect(JSON.stringify(changes)).not.toContain("SECRET");
    });

    it("stores no before when the database of the result cannot be placed", () => {
      const call = patchOf("s", TASK_A);
      const changes = project(
        played(call, {
          output: item(TASK_A),
          details: { error: false, changes: [{ key: "name", before: "SECRET", after: "x" }] },
        }),
        { databases: new Map() },
      );
      expect(changes).toEqual([{ itemId: TASK_A, databaseId: TASKS_DB, change: "updated", changedKeys: ["name"] }]);
    });
  });

  describe("links", () => {
    const relation = (
      operation: "relation.put" | "relation.delete",
      callerItemId = TASK_A,
      propertyId = RELATION_PROPERTY,
    ): Call => ({
      toolCallId: operation,
      operation,
      name: operation.replace(".", "_"),
      args: { relationPropertyId: propertyId, callerItemId, targetItemId: TASK_B },
    });

    it.each(["relation.put", "relation.delete"] as const)(
      "records %s as an update of the calling item under the relation property's key",
      (operation) => {
        expect(project(played(relation(operation), { output: { id: "edge" } }))).toEqual([
          { itemId: TASK_A, databaseId: TASKS_DB, change: "updated", changedKeys: ["project"] },
        ]);
      },
    );

    it("records no entry for a calling item that is not found or not named", () => {
      expect(project(played(relation("relation.put", UNKNOWN_ID)))).toEqual([]);
      expect(project(played({ ...relation("relation.put"), args: { relationPropertyId: RELATION_PROPERTY } }))).toEqual(
        [],
      );
    });

    it("records a link whose property is not found or not named as an update with no key, because the result proves it ran", () => {
      const update = [{ itemId: TASK_A, databaseId: TASKS_DB, change: "updated", changedKeys: [] }];
      expect(project(played(relation("relation.put", TASK_A, UNKNOWN_ID)))).toEqual(update);
      expect(project(played({ ...relation("relation.put"), args: { callerItemId: TASK_A } }))).toEqual(update);
    });

    it.each(["relation.put", "relation.delete"] as const)(
      "records %s whose arguments were stored redacted through the calling item the events name",
      (operation) => {
        const call: Call = { ...relation(operation), args: "[redacted: sensitive]", targetItemId: TASK_A };
        expect(project(played(call))).toEqual([
          { itemId: TASK_A, databaseId: TASKS_DB, change: "updated", changedKeys: [] },
        ]);
      },
    );

    it("merges a link into the other changes of the calling item", () => {
      const changes = project([
        ...played(patchOf("p", TASK_A), {
          output: item(TASK_A),
          details: { error: false, changes: [{ key: "name", before: "n0", after: "n1" }] },
        }),
        ...played(relation("relation.put")),
      ]);

      expect(changes).toEqual([
        {
          itemId: TASK_A,
          databaseId: TASKS_DB,
          change: "updated",
          changedKeys: ["name", "project"],
          before: { name: "n0" },
        },
      ]);
    });
  });
});
