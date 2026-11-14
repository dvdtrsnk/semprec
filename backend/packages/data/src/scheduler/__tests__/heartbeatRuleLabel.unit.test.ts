import { beforeAll, describe, expect, it } from "vitest";
import { loadModuleCatalogs, resolveCatalogLabel, type ModuleCatalogs } from "@semprec/module-registry";
import { toManifestLocale } from "../../manifest/catalogResolution.js";
import { formatHeartbeatRuleLabel } from "../heartbeatRuleLabel.js";
import { lastOccurrenceStatusOf } from "../projectHeartbeatsRoute.js";

let catalogs: ModuleCatalogs;

beforeAll(async () => {
  catalogs = await loadModuleCatalogs(new URL("../../seed/systemDatabasesModuleManifest.js", import.meta.url).href);
});

function label(rule: unknown, locale: "en" | "cs"): string {
  return formatHeartbeatRuleLabel(rule, (key) =>
    resolveCatalogLabel(null, catalogs[toManifestLocale(locale)], catalogs.en, key),
  );
}

function weekly(days: string[], at = "08:30"): unknown {
  return { kind: "weekly", days, at };
}

describe("formatHeartbeatRuleLabel (issue gh-1910)", () => {
  it("reads weekly Monday to Friday at 08:30 as the range and the time without its leading zero", () => {
    const rule = weekly(["mon", "tue", "wed", "thu", "fri"]);

    expect(label(rule, "en")).toBe("Mon-Fri at 8:30");
    expect(label(rule, "cs")).toBe("Po-Pá v 8:30");
  });

  it("keeps the minutes as stored and reads midnight as 0", () => {
    expect(label({ kind: "dailyTime", at: "00:05" }, "en")).toBe("Every day at 0:05");
    expect(label({ kind: "dailyTime", at: "23:59" }, "cs")).toBe("Každý den v 23:59");
  });

  describe("the days of a weekly rule", () => {
    it("lists one or two days one by one, in week order", () => {
      expect(label(weekly(["wed"]), "en")).toBe("Wed at 8:30");
      expect(label(weekly(["tue", "mon"]), "en")).toBe("Mon, Tue at 8:30");
      expect(label(weekly(["sun", "sat"]), "cs")).toBe("So, Ne v 8:30");
    });

    it("turns three consecutive days into a range, the shortest one", () => {
      expect(label(weekly(["mon", "tue", "wed"]), "en")).toBe("Mon-Wed at 8:30");
    });

    it("keeps days that are not consecutive apart and ranges only the run", () => {
      expect(label(weekly(["mon", "wed", "fri"]), "en")).toBe("Mon, Wed, Fri at 8:30");
      expect(label(weekly(["fri", "mon", "tue", "wed"]), "en")).toBe("Mon-Wed, Fri at 8:30");
      expect(label(weekly(["mon", "tue", "thu", "fri", "sat"]), "en")).toBe("Mon, Tue, Thu-Sat at 8:30");
    });

    it("counts a repeated day once", () => {
      expect(label(weekly(["mon", "mon", "tue", "tue"]), "en")).toBe("Mon, Tue at 8:30");
    });

    it("does not wrap a run from Sunday to Monday", () => {
      expect(label(weekly(["sun", "mon", "tue"]), "en")).toBe("Mon, Tue, Sun at 8:30");
    });

    it("reads all seven days as one range", () => {
      expect(label(weekly(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]), "cs")).toBe("Po-Ne v 8:30");
    });
  });

  describe("the other core kinds", () => {
    it("reads every n days at a time, and every single day as the daily label", () => {
      expect(label({ kind: "everyNDays", n: 3, at: "07:00" }, "en")).toBe("Every 3 days at 7:00");
      expect(label({ kind: "everyNDays", n: 3, at: "07:00" }, "cs")).toBe("Každé 3 dny v 7:00");
      expect(label({ kind: "everyNDays", n: 1, at: "07:00" }, "en")).toBe("Every day at 7:00");
    });

    it.each([
      [2, "Každé 2 dny v 7:00"],
      [3, "Každé 3 dny v 7:00"],
      [4, "Každé 4 dny v 7:00"],
      [5, "Každých 5 dní v 7:00"],
      [14, "Každých 14 dní v 7:00"],
    ])("declines the Czech every-%i-days label by its count", (n, expected) => {
      expect(label({ kind: "everyNDays", n, at: "07:00" }, "cs")).toBe(expected);
      expect(label({ kind: "everyNDays", n, at: "07:00" }, "en")).toBe(`Every ${n} days at 7:00`);
    });

    it("reads an interval in minutes", () => {
      expect(label({ kind: "interval", minutes: 90 }, "en")).toBe("Every 90 min");
      expect(label({ kind: "interval", minutes: 5 }, "cs")).toBe("Každých 5 min");
    });

    it("reads each item event on its own", () => {
      const databaseId = "11111111-1111-4111-8111-111111111111";
      expect(label({ kind: "onItemEvent", databaseId, event: "create" }, "en")).toBe("When an item is created");
      expect(label({ kind: "onItemEvent", databaseId, event: "update" }, "en")).toBe("When an item changes");
      expect(label({ kind: "onItemEvent", databaseId, event: "delete" }, "cs")).toBe("Při smazání položky");
    });
  });

  describe("a rule it cannot read", () => {
    it.each([
      ["a kind no core rule has", { kind: "fixtureGood.onWidgetTick", everyMinutes: 5 }],
      ["a core kind with fields that do not parse", { kind: "weekly", days: [], at: "08:30" }],
      ["a time that is no wall-clock time", { kind: "dailyTime", at: "8:30" }],
      ["a value that is no object", null],
    ])("reads %s as a custom schedule", (_name, rule) => {
      expect(label(rule, "en")).toBe("Custom schedule");
      expect(label(rule, "cs")).toBe("Vlastní plán");
    });
  });

  it("has every label key in both the Czech and the English catalog", () => {
    const keysOf = (catalog: Record<string, string>) =>
      Object.keys(catalog)
        .filter((key) => key.startsWith("heartbeat."))
        .sort();

    expect(keysOf(catalogs.cs)).toEqual(keysOf(catalogs.en));
    expect(keysOf(catalogs.en)).toHaveLength(17);
  });
});

describe("lastOccurrenceStatusOf (issue gh-1910)", () => {
  it("names the display status of a finished run as ok, waiting_approval or failed", () => {
    expect(lastOccurrenceStatusOf("done")).toBe("ok");
    expect(lastOccurrenceStatusOf("waiting_approval")).toBe("waiting_approval");
    expect(lastOccurrenceStatusOf("error")).toBe("failed");
  });

  it("refuses a run that is still running instead of reporting it as one of the three", () => {
    expect(() => lastOccurrenceStatusOf("running")).toThrow("still running");
  });
});
