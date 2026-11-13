import { describe, expect, it } from "vitest";
import { ModuleRegistry, type ModuleDatabaseProjection } from "@semprec/module-registry";
import { filterNodeSchema } from "../views/filterTree.js";
import { sortSpecSchema } from "../views/sortSpec.js";
import { BUILTIN_VIEW_TYPES } from "../chokePoint/viewTypeRegistry.js";
import { TEMPORAL_SWITCHER_VIEW_TYPE } from "../views/temporalSwitcherViewType.js";
import { PAGES_MODULE_ID } from "../seed/pagesModuleKey.js";
import { TEN_DATABASE_MODULE_IDS } from "../seed/tenDatabaseKeys.js";
import { loadFullModuleRegistry } from "../manifest/fullModuleRegistry.js";

/**
 * Load tests (module-contract issue #226) proving each retrofit manifest for the schema/data
 * core, views, docs, and ten-system-databases modules actually loads through
 * `ModuleRegistry.loadModule()` and passes its load-time structural validation — never that
 * a `ModuleManifest` object merely type-checks. Each module is loaded into its own registry
 * so a failure in one never masks or is masked by another; the four together also prove none
 * of the four collide with each other on module id/name (the fourth-loaded manifest -
 * `systemDatabases` - would fail first, since it declares the most identifiers).
 */
function manifestPath(fileName: string): string {
  return new URL(`../${fileName}`, import.meta.url).href;
}

const SCHEMA_CORE_PATH = manifestPath("chokePoint/schemaCoreModuleManifest.js");
const VIEWS_PATH = manifestPath("views/viewsModuleManifest.js");
const DOCS_PATH = manifestPath("docs/docsModuleManifest.js");
const SYSTEM_DATABASES_PATH = manifestPath("seed/systemDatabasesModuleManifest.js");

const alwaysActive: () => ReadonlySet<string> = () => new Set(["schemaCore", "views", "docs", "systemDatabases"]);

describe("core module manifests (module-contract issue #226)", () => {
  it("loads the schema/data core manifest and declares no databases, plus its ungated heartbeat agent tools", async () => {
    const registry = new ModuleRegistry(alwaysActive);
    const moduleId = await registry.loadModule(SCHEMA_CORE_PATH);

    expect(moduleId).toBe("schemaCore");
    expect(await registry.getDatabases()).toEqual([]);
    expect(await registry.getAgentTools(new Set())).toEqual([
      { moduleId: "schemaCore", name: "heartbeat.list", handlerExport: "createHeartbeatListTool" },
      { moduleId: "schemaCore", name: "heartbeat.history", handlerExport: "createHeartbeatHistoryTool" },
      { moduleId: "schemaCore", name: "heartbeat.trigger", handlerExport: "createGuardedHeartbeatTriggerTool" },
    ]);
    const tools = await registry.getAgentToolDefinitions(new Set());
    expect(tools.map((tool) => tool.name)).toEqual(["heartbeat.list", "heartbeat.history", "heartbeat.trigger"]);
    const trigger = tools.find((tool) => tool.name === "heartbeat.trigger");
    if (!trigger) throw new Error("Heartbeat trigger missing");
    expect(trigger.parseArguments({ heartbeatId: "00000000-0000-4000-8000-000000000000" }).success).toBe(true);
    expect(trigger.parseArguments({ heartbeatId: "not-a-uuid" }).success).toBe(false);
    expect(await registry.getMigrations()).toEqual([{ moduleId: "schemaCore", migration: "0001_core_schema.sql" }]);
  });

  it("loads the views manifest and projects the built-in view types", async () => {
    const registry = new ModuleRegistry(alwaysActive);
    const moduleId = await registry.loadModule(VIEWS_PATH);

    expect(moduleId).toBe("views");
    expect(await registry.getViewTypes()).toEqual([...BUILTIN_VIEW_TYPES]);
    expect(await registry.getDatabases()).toEqual([]);
  });

  it("loads the docs manifest, which declares only the hidden Pages database, and no core-reserved task or heartbeat names", async () => {
    const registry = new ModuleRegistry(alwaysActive);
    const moduleId = await registry.loadModule(DOCS_PATH);

    expect(moduleId).toBe("docs");
    // No order fields and no visibility flag: no collection list or switcher shows the hidden database.
    expect(await registry.getDatabases()).toEqual([{ moduleId: "docs", key: PAGES_MODULE_ID, name: "Pages" }]);
    expect(await registry.getTasks()).toEqual([]);
    expect(await registry.getHeartbeatActions()).toEqual([]);
    expect(await registry.getMigrations()).toEqual([
      { moduleId: "docs", migration: "0003_docs.sql" },
      { moduleId: "docs", migration: "0036_doc_history_retention.sql" },
    ]);
  });

  it("loads the ten-system-databases manifest with all ten existing database keys and Journal's view type", async () => {
    const registry = new ModuleRegistry(alwaysActive);
    const moduleId = await registry.loadModule(SYSTEM_DATABASES_PATH);

    expect(moduleId).toBe("systemDatabases");
    const databases = await registry.getDatabases();
    expect(databases.map((db) => db.key).sort()).toEqual([...TEN_DATABASE_MODULE_IDS].sort());
    expect(await registry.getViewTypes()).toEqual([TEMPORAL_SWITCHER_VIEW_TYPE]);
    const meta = new Map(databases.map((db) => [db.key, db]));
    const pick = (key: string) => {
      const { icon, color, overviewOrder, switcherOrder, clientVisible } = meta.get(key)!;
      return { icon, color, overviewOrder, switcherOrder, clientVisible };
    };
    expect(pick("projects")).toEqual({ icon: "folder", color: "#007AFF", overviewOrder: 1, switcherOrder: 1 });
    expect(pick("tasks")).toEqual({
      icon: "checkmark-circle",
      color: "#34C759",
      overviewOrder: null,
      switcherOrder: 2,
    });
    expect(pick("events")).toEqual({ icon: "calendar", color: "#FF3B30", overviewOrder: 2, switcherOrder: 3 });
    expect(pick("journal")).toEqual({ icon: "book", color: "#AF52DE", overviewOrder: null, switcherOrder: 4 });
    expect(pick("people")).toEqual({ icon: "person", color: "#5856D6", overviewOrder: 3, switcherOrder: 5 });
    expect(pick("companies")).toEqual({ icon: "building", color: "#5AC8FA", overviewOrder: 4, switcherOrder: 6 });
    expect(pick("files")).toEqual({ icon: "document", color: "#8E8E93", overviewOrder: 5, switcherOrder: 7 });
    expect(pick("healthRecords")).toEqual({ icon: "heart", color: "#FF2D55", overviewOrder: 6, switcherOrder: 8 });
    expect(pick("areas")).toEqual({
      icon: "compass",
      color: "#30B0C7",
      overviewOrder: null,
      switcherOrder: null,
      clientVisible: true,
    });
    expect(pick("transcripts")).toEqual({
      icon: "waveform",
      color: "#8E8E93",
      overviewOrder: null,
      switcherOrder: null,
      clientVisible: true,
    });
  });

  it("declares the two transcript read tools of the systemDatabases module behind core.item.read, as reads that need no approval (issue #1832)", async () => {
    const registry = new ModuleRegistry(alwaysActive);
    await registry.loadModule(SYSTEM_DATABASES_PATH);

    expect(await registry.getAgentTools(new Set())).toEqual([]);
    expect(await registry.getAgentTools(new Set(["core.item.read"]))).toEqual([
      { moduleId: "systemDatabases", name: "transcript.get", handlerExport: "createTranscriptGetTool" },
      {
        moduleId: "systemDatabases",
        name: "transcript.segment.get",
        handlerExport: "createTranscriptSegmentGetTool",
      },
    ]);
    const tools = await registry.getAgentToolDefinitions(new Set(["core.item.read"]));
    expect(tools.map((tool) => [tool.name, tool.riskClass, tool.requiresApproval ?? false])).toEqual([
      ["transcript.get", "read", false],
      ["transcript.segment.get", "read", false],
    ]);
    const [get, segmentGet] = tools;
    if (!get || !segmentGet) throw new Error("Transcript tools missing");
    const transcriptId = "00000000-0000-4000-8000-000000000000";
    expect(get.parseArguments({ transcriptId }).success).toBe(true);
    expect(get.parseArguments({ transcriptId, tenantId: transcriptId }).success).toBe(false);
    expect(segmentGet.parseArguments({ transcriptId, fromIndex: 0, toIndex: 5, context: 3 }).success).toBe(true);
    expect(segmentGet.parseArguments({ transcriptId, startsAt: 312, endsAt: 390 }).success).toBe(true);
    expect(segmentGet.parseArguments({ transcriptId, fromIndex: 0, toIndex: 5, context: 4 }).success).toBe(false);
    expect(segmentGet.parseArguments({ transcriptId, projectItemId: transcriptId }).success).toBe(false);
  });

  it("loads all four manifests together into one registry with no id/name/database-key collisions", async () => {
    const registry = new ModuleRegistry(alwaysActive);

    await registry.loadModule(SCHEMA_CORE_PATH);
    await registry.loadModule(VIEWS_PATH);
    await registry.loadModule(DOCS_PATH);
    await registry.loadModule(SYSTEM_DATABASES_PATH);

    expect(registry.listModuleIds().sort()).toEqual(["docs", "schemaCore", "systemDatabases", "views"]);
    expect((await registry.getDatabases()).length).toBe(TEN_DATABASE_MODULE_IDS.length + 1);
  });
});

/** Every filter tree a database declares (issue #1647), named by where it is declared. */
function declaredFilters(databases: ModuleDatabaseProjection[]): [string, unknown][] {
  return databases.flatMap((db) => [
    ...(db.quickFilters ?? []).flatMap((chip): [string, unknown][] =>
      chip.filter === undefined ? [] : [[`${db.key}.quickFilters.${chip.key}`, chip.filter]],
    ),
    ...(db.collectionFilter === undefined
      ? []
      : [[`${db.key}.collectionFilter`, db.collectionFilter] as [string, unknown]]),
    ...(db.pickerFilter === undefined ? [] : [[`${db.key}.pickerFilter`, db.pickerFilter] as [string, unknown]]),
  ]);
}

/** Every sort spec a database declares, named by where it is declared. */
function declaredSorts(databases: ModuleDatabaseProjection[]): [string, unknown][] {
  return databases.flatMap((db) => [
    ...(db.quickFilters ?? []).flatMap((chip) =>
      (chip.sort ?? []).map((spec, index): [string, unknown] => [
        `${db.key}.quickFilters.${chip.key}.sort.${index}`,
        spec,
      ]),
    ),
    ...(db.defaultSort === undefined ? [] : [[`${db.key}.defaultSort`, db.defaultSort] as [string, unknown]]),
  ]);
}

/** The declarations whose tree or spec the data package's own schema refuses, with the refusal. */
function refusedDeclarations(databases: ModuleDatabaseProjection[]): string[] {
  return [
    ...declaredFilters(databases).filter(([, tree]) => !filterNodeSchema.safeParse(tree).success),
    ...declaredSorts(databases).filter(([, spec]) => !sortSpecSchema.safeParse(spec).success),
  ].map(([where]) => where);
}

/** The databases of every manifest the processes load (`loadFullModuleRegistry`), so no module's declaration is skipped. */
async function loadViewHintManifests(): Promise<ModuleDatabaseProjection[]> {
  return (await loadFullModuleRegistry()).getDatabases();
}

describe("declared quick filters, default sorts and collection and picker filters (issue #1647)", () => {
  it("parses every filter any loaded manifest declares with the data package's filter schema and every sort with its sort schema", async () => {
    expect((await loadFullModuleRegistry()).listModuleIds()).toEqual([
      "schemaCore",
      "views",
      "docs",
      "systemDatabases",
      "library",
      "mailSync",
      "inboxPipeline",
      "calendar",
      "recipes",
      "sleep",
    ]);
    const databases = await loadViewHintManifests();
    expect(declaredFilters(databases).length).toBeGreaterThan(20);
    expect(refusedDeclarations(databases)).toEqual([]);
  });

  it("refuses a malformed filter or sort declaration through the same check", async () => {
    const [projects] = (await loadViewHintManifests()).filter((db) => db.key === "projects");
    if (!projects) throw new Error("Projects is not declared");
    const malformed: ModuleDatabaseProjection = {
      ...projects,
      quickFilters: [
        { key: "typo", labelKey: "x", filter: { type: "in", property: "status", value: "done" } },
        { key: "unknownType", labelKey: "x", filter: { type: "status_is", property: "status" } },
        { key: "sorted", labelKey: "x", sort: [{ property: "date", direction: "up" as "asc" }] },
      ],
      pickerFilter: { type: "and", nodes: [] },
    };
    expect(refusedDeclarations([malformed])).toEqual([
      "projects.quickFilters.typo",
      "projects.quickFilters.unknownType",
      "projects.pickerFilter",
      "projects.quickFilters.sorted.sort.0",
    ]);
  });

  it("declares the chips, sorts, date labels and filters the issue lists, exactly", async () => {
    const byKey = new Map((await loadViewHintManifests()).map((db) => [db.key, db]));
    const chips = (key: string) =>
      (byKey.get(key)?.quickFilters ?? []).map(({ key: chip, filter, sort, isDefault }) => ({
        chip,
        filter,
        sort,
        isDefault,
      }));
    const inStatus = (value: string[]) => ({ type: "in", property: "status", value });
    expect(chips("projects")).toEqual([
      { chip: "active", filter: inStatus(["inProgress", "longTerm"]), sort: undefined, isDefault: true },
      { chip: "done", filter: inStatus(["done"]), sort: undefined, isDefault: undefined },
      { chip: "archived", filter: inStatus(["archived"]), sort: undefined, isDefault: undefined },
      { chip: "all", filter: undefined, sort: undefined, isDefault: undefined },
    ]);
    expect(byKey.get("projects")?.dateLabels).toEqual({
      pastLabelKey: "dateLabel.projects.past",
      noDateLabelKey: "dateLabel.projects.noDate",
    });
    expect(byKey.get("projects")?.collectionFilter).toEqual({ type: "is_empty", property: "systemActive" });
    expect(byKey.get("projects")?.pickerFilter).toEqual({
      type: "and",
      nodes: [
        { type: "is_empty", property: "systemActive" },
        {
          type: "or",
          nodes: [
            { type: "is_empty", property: "status" },
            { type: "not", node: inStatus(["done", "archived"]) },
          ],
        },
      ],
    });
    const relative = (preset: string) => ({ type: "date_relative", property: "date", preset });
    expect(chips("events")).toEqual([
      {
        chip: "upcoming",
        filter: relative("upcoming"),
        sort: [{ property: "date", direction: "asc" }],
        isDefault: true,
      },
      { chip: "today", filter: relative("today"), sort: undefined, isDefault: undefined },
      { chip: "thisWeek", filter: relative("thisWeek"), sort: undefined, isDefault: undefined },
      { chip: "nextWeek", filter: relative("nextWeek"), sort: undefined, isDefault: undefined },
      { chip: "past", filter: relative("past"), sort: [{ property: "date", direction: "desc" }], isDefault: undefined },
      { chip: "all", filter: undefined, sort: undefined, isDefault: undefined },
    ]);
    for (const key of ["events", "tasks"]) {
      expect(byKey.get(key)?.defaultSort, key).toEqual({ property: "date", direction: "asc" });
    }
    expect(byKey.get("tasks")?.quickFilters).toBeUndefined();
    const values = (key: string) =>
      chips(key).map(({ chip, filter, isDefault }) => [chip, filter === undefined ? null : filter, isDefault ?? false]);
    const relationship = (value: string[]) => ({ type: "in", property: "relationship", value });
    expect(values("people")).toEqual([
      ["all", null, false],
      ["clients", relationship(["client"]), false],
      ["close", relationship(["closeFriend", "parent", "girlfriend"]), false],
      ["others", relationship(["therapist", "neighbor"]), false],
    ]);
    const type = (value: string[]) => ({ type: "in", property: "type", value });
    expect(values("files")).toEqual([
      ["all", null, false],
      ["recent", relative("last30"), false],
      ["pdf", type(["pdf"]), false],
      ["images", type(["jpg"]), false],
      ["spreadsheets", type(["xlsx"]), false],
      ["documents", type(["docx"]), false],
    ]);
    expect(values("healthRecords")).toEqual([
      ["all", null, false],
      ["monitoring", inStatus(["monitoring"]), false],
      ["resolved", inStatus(["resolved"]), false],
    ]);
    expect(values("books")).toEqual([
      ["all", null, false],
      ["toRead", inStatus(["toRead"]), false],
      ["reading", inStatus(["reading"]), false],
      ["read", inStatus(["read"]), false],
    ]);
    expect(values("movies")).toEqual([
      ["all", null, false],
      ["planned", inStatus(["planned"]), false],
      ["watching", inStatus(["watching"]), false],
      ["watched", inStatus(["watched"]), false],
    ]);
    // Every chip label is its own catalog key, `quickFilter.<database>.<chip>`.
    for (const db of byKey.values()) {
      for (const chip of db.quickFilters ?? []) expect(chip.labelKey).toBe(`quickFilter.${db.key}.${chip.key}`);
    }
    // No other database declares any view hint.
    const declaring = [...byKey.values()].filter(
      (db) =>
        db.quickFilters !== undefined ||
        db.defaultSort !== undefined ||
        db.dateLabels !== undefined ||
        db.collectionFilter !== undefined ||
        db.pickerFilter !== undefined,
    );
    expect(declaring.map((db) => db.key).sort()).toEqual([
      "books",
      "events",
      "files",
      "healthRecords",
      "movies",
      "people",
      "projects",
      "tasks",
    ]);
  });
});
