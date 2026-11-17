import { beforeAll, describe, expect, it } from "vitest";
import { loadModuleCatalogs, type ModuleCatalogs } from "@semprec/module-registry";
import { renderResolutionTitle } from "../sempResolutionTitles.js";

let catalogs: ModuleCatalogs;

beforeAll(async () => {
  catalogs = await loadModuleCatalogs(new URL("../sempStatusReport.js", import.meta.url).href);
});

describe("renderResolutionTitle (issue gh-1919)", () => {
  const cases = [
    {
      kind: "mailSyncError",
      params: { mailbox: "Inbox" },
      en: "Mailbox Inbox is syncing again",
      cs: "Schránka Inbox se opět synchronizuje",
    },
    {
      kind: "reply",
      params: { title: "Client meeting summary" },
      en: "Task 'Client meeting summary' completed",
      cs: "Úkol „Client meeting summary“ byl dokončen",
    },
    {
      kind: "agentHeartbeat",
      params: { name: "Daily digest" },
      en: "Automatic task 'Daily digest' ran successfully",
      cs: "Automatický úkol „Daily digest“ proběhl úspěšně",
    },
    {
      kind: "guidanceDrift",
      params: { project: "Home", findingKind: "permission" },
      en: "Instructions of project Home match the permissions again",
      cs: "Pokyny projektu Home opět odpovídají oprávněním",
    },
    {
      kind: "guidanceDrift",
      params: { project: "Home" },
      en: "Instructions of project Home match the permissions again",
      cs: "Pokyny projektu Home opět odpovídají oprávněním",
    },
    {
      kind: "guidanceDrift",
      params: { project: "Home", findingKind: "behavior" },
      en: "Instructions of project Home match what Semp does again",
      cs: "Pokyny projektu Home opět odpovídají tomu, co Semp dělá",
    },
    {
      kind: "transcriptionFailed",
      params: { name: "Quarterly planning" },
      en: "Transcript 'Quarterly planning' completed",
      cs: "Přepis „Quarterly planning“ byl dokončen",
    },
    {
      kind: "backupRestore",
      params: {},
      en: "Monthly backup restore test passed",
      cs: "Měsíční test obnovy ze zálohy proběhl úspěšně",
    },
    { kind: "processStale", params: {}, en: "Semp is running again", cs: "Semp opět běží" },
    {
      kind: "libraryAutomation",
      params: { database: "Books" },
      en: "Automation of Books works again",
      cs: "Automatizace v databázi Books opět funguje",
    },
  ];
  for (const entry of cases) {
    it(`renders ${entry.kind}${"findingKind" in entry.params ? ` (${entry.params.findingKind})` : ""} in English and Czech`, () => {
      expect(renderResolutionTitle(catalogs, entry.kind, "recovered", entry.params, "en")).toBe(entry.en);
      expect(renderResolutionTitle(catalogs, entry.kind, "recovered", entry.params, "cs")).toBe(entry.cs);
    });
  }

  it("replaces a name that is absent, null or blank by the neutral word, never an empty gap", () => {
    expect(renderResolutionTitle(catalogs, "mailSyncError", "recovered", {}, "en")).toBe(
      "Mailbox (unnamed) is syncing again",
    );
    expect(renderResolutionTitle(catalogs, "mailSyncError", "recovered", { mailbox: null }, "cs")).toBe(
      "Schránka (bez názvu) se opět synchronizuje",
    );
    expect(renderResolutionTitle(catalogs, "reply", "recovered", { title: " \n\t " }, "en")).toBe(
      "Task '(unnamed)' completed",
    );
  });

  it("writes a name literally: a placeholder or a replacement pattern inside it is not interpreted", () => {
    expect(renderResolutionTitle(catalogs, "mailSyncError", "recovered", { mailbox: "{mailbox} $& $1" }, "en")).toBe(
      "Mailbox {mailbox} $& $1 is syncing again",
    );
  });

  it("collapses whitespace inside a name", () => {
    expect(renderResolutionTitle(catalogs, "reply", "recovered", { title: "A\n  B" }, "en")).toBe(
      "Task 'A B' completed",
    );
  });

  it("gives a problem kind without an entry the generic title in the requested locale", () => {
    expect(renderResolutionTitle(catalogs, "agentRun", "recovered", {}, "en")).toBe("A problem was resolved");
    expect(renderResolutionTitle(catalogs, "agentRun", "recovered", {}, "cs")).toBe("Problém byl vyřešen");
  });

  it("gives a resolution kind without an entry the generic title", () => {
    expect(renderResolutionTitle(catalogs, "mailSyncError", "somethingElse", { mailbox: "Inbox" }, "en")).toBe(
      "A problem was resolved",
    );
  });

  it("keeps the same resolved titles in both catalogs", () => {
    const keys = (catalog: Record<string, string>) =>
      Object.keys(catalog).filter((key) => key.startsWith("status.resolved."));
    expect(keys(catalogs.cs).sort()).toEqual(keys(catalogs.en).sort());
    expect(keys(catalogs.en).length).toBeGreaterThan(0);
  });
});
