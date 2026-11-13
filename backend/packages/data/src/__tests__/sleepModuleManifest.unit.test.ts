import { describe, expect, it } from "vitest";
import { createCollectionMetadataResolver } from "../manifest/collectionMetadata.js";
import { loadFullModuleRegistry } from "../manifest/fullModuleRegistry.js";
import { handleSleepResync, sleepResyncPayloadSchema } from "../sleep/sleepResync.js";
import { sleepNightPut, sleepNightsGet } from "../sleep/sleepRouteHandlers.js";

const SLEEP_DATABASE_KEYS = ["sleepSettings", "sleepPlans", "sleepNights"];

describe("sleep module manifest (issue #1776)", () => {
  it("is loaded by the full registry as a non-removable system project module with three databases that declare no order", async () => {
    const registry = await loadFullModuleRegistry();

    expect(registry.listModuleIds()).toContain("sleep");
    expect(await registry.listActiveModuleIds()).toContain("sleep");
    expect(await registry.getSystemProjectModuleIds()).toContain("sleep");
    expect(registry.isRemovable("sleep")).toBe(false);
    expect((await registry.getDatabases()).filter((database) => database.moduleId === "sleep")).toEqual([
      { moduleId: "sleep", key: "sleepSettings", name: "Sleep settings" },
      { moduleId: "sleep", key: "sleepPlans", name: "Sleep plans" },
      { moduleId: "sleep", key: "sleepNights", name: "Sleep nights" },
    ]);
    expect((await registry.getAgentTools(new Set())).filter((tool) => tool.moduleId === "sleep")).toEqual([]);
  });

  it("resolves each sleep database to clientVisible false with no overview and no switcher position", async () => {
    const resolver = await createCollectionMetadataResolver(await loadFullModuleRegistry());

    for (const key of SLEEP_DATABASE_KEYS) {
      expect(resolver.resolve({ key, system: true }), key).toEqual({
        icon: null,
        color: null,
        overviewOrder: null,
        switcherOrder: null,
        clientVisible: false,
        overviewHidden: false,
      });
    }
  });

  it("ships a Czech and an English catalog with the same keys, the database names and the seeded plan names", async () => {
    const catalogs = await (await loadFullModuleRegistry()).getCatalogs("sleep");
    if (!catalogs) throw new Error("The sleep module has no catalogs");
    const properties: Record<string, string[]> = {
      sleepSettings: [
        "name",
        "enabled",
        "prepReminder",
        "muteSemp",
        "alarmSnooze",
        "showInCalendar",
        "goalMinutes",
        "prepReminderMinutes",
        "alarmSound",
        "area",
        "systemActive",
      ],
      sleepPlans: ["name", "wakeDays", "bedTime", "wakeTime", "alarm", "position"],
      sleepNights: ["night", "bedTime", "wakeTime", "alarm"],
    };
    const expectedKeys = [
      ...SLEEP_DATABASE_KEYS.map((key) => `database.${key}.name`),
      ...Object.entries(properties).flatMap(([database, keys]) =>
        keys.map((key) => `property.${database}.${key}.name`),
      ),
      ...["morning", "birds", "piano", "vibrateOnly"].map((key) => `property.sleepSettings.alarmSound.option.${key}`),
      ...["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((key) => `property.sleepPlans.wakeDays.option.${key}`),
      "seed.sleepPlans.weekdays.name",
      "seed.sleepPlans.weekend.name",
    ];

    expect(Object.keys(catalogs.cs).sort()).toEqual([...expectedKeys].sort());
    expect(Object.keys(catalogs.en).sort()).toEqual([...expectedKeys].sort());
    expect(catalogs.cs["database.sleepSettings.name"]).toBe("Nastavení spánku");
    expect(catalogs.en["database.sleepSettings.name"]).toBe("Sleep settings");
    expect(catalogs.cs["property.sleepSettings.area.name"]).toBe("Oblast");
    expect(catalogs.en["property.sleepSettings.area.name"]).toBe("Area");
    expect(catalogs.cs["seed.sleepPlans.weekdays.name"]).toBe("Pracovní dny");
    expect(catalogs.cs["seed.sleepPlans.weekend.name"]).toBe("Víkend");
    expect(catalogs.en["seed.sleepPlans.weekdays.name"]).toBe("Weekdays");
    expect(catalogs.en["seed.sleepPlans.weekend.name"]).toBe("Weekend");
    for (const catalog of [catalogs.cs, catalogs.en]) {
      for (const label of Object.values(catalog)) expect(label.trim()).not.toBe("");
    }
  });

  it("mounts GET and PUT /api/sleep/nights as its custom routes, resolved to the handler factories (issues gh-1809 and gh-1835)", async () => {
    const registry = await loadFullModuleRegistry();

    expect((await registry.getCustomRouteDefinitions()).filter((route) => route.moduleId === "sleep")).toEqual([
      { moduleId: "sleep", name: "sleepNights", method: "GET", path: "/api/sleep/nights", handler: sleepNightsGet },
      {
        moduleId: "sleep",
        name: "sleepNightPut",
        method: "PUT",
        path: "/api/sleep/nights/:night",
        handler: sleepNightPut,
      },
    ]);
  });

  it("declares sleep.resync as its one task for the API runtime, resolved to the exported schema and handler (issue gh-1838)", async () => {
    const registry = await loadFullModuleRegistry();

    expect((await registry.getTasks()).filter((task) => task.moduleId === "sleep")).toEqual([
      {
        moduleId: "sleep",
        name: "sleep.resync",
        payloadSchemaExport: "sleepResyncPayloadSchema",
        handlerExport: "handleSleepResync",
        queueAffinity: "api",
      },
    ]);
    expect((await registry.getTaskDefinitions()).filter((task) => task.moduleId === "sleep")).toEqual([
      {
        moduleId: "sleep",
        name: "sleep.resync",
        payloadSchema: sleepResyncPayloadSchema,
        handler: handleSleepResync,
        queueAffinity: "api",
      },
    ]);
  });
});
