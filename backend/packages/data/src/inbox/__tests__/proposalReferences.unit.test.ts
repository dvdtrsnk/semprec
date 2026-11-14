import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ValidationError } from "../../errors.js";
import type { ProposalEnvelope, ProposalStep } from "../proposalEnvelope.js";
import type { PoolClient } from "pg";
import {
  envelopeReferencesOf,
  isCardBeingConfirmed,
  referencedItemIdsOf,
  runWhileConfirmingCard,
} from "../proposalReferences.js";

const TASKS_DATABASE = "00000000-0000-4000-8000-000000000001";
const ALPHA = "00000000-0000-4000-8000-0000000000a1";
const BETA = "00000000-0000-4000-8000-0000000000b2";
const GAMMA = "00000000-0000-4000-8000-0000000000c3";

const database = (relations?: Record<string, string[]>): ProposalEnvelope => ({
  entityKind: "database",
  target: TASKS_DATABASE,
  properties: { name: "Task" },
  ...(relations === undefined ? {} : { relations }),
});

const company: ProposalStep = {
  ref: "company",
  op: "create",
  databaseKey: "companies",
  role: "primary",
  properties: { name: "Acme" },
};
const person: ProposalStep = {
  ref: "person",
  op: "create",
  databaseKey: "people",
  role: "secondary",
  properties: { name: "Jane" },
};
const multiStep = (...steps: ProposalStep[]): ProposalEnvelope => ({
  entityKind: "database",
  target: TASKS_DATABASE,
  properties: {},
  operations: steps,
});

describe("envelopeReferencesOf and referencedItemIdsOf (issue #1916)", () => {
  it("refers to nothing for a card with no envelope", () => {
    expect(envelopeReferencesOf(null)).toEqual([]);
    expect(referencedItemIdsOf(null)).toEqual([]);
  });

  it("does not list the target database of a database envelope, nor an envelope without relations", () => {
    expect(referencedItemIdsOf(database())).toEqual([]);
  });

  it("lists the targets of a database envelope's relation lists with the relation key as the field", () => {
    const envelope = database({ project: [ALPHA], people: [BETA, GAMMA], companies: [] });

    expect(envelopeReferencesOf(envelope)).toEqual([
      { itemId: ALPHA, field: "project" },
      { itemId: BETA, field: "people" },
      { itemId: GAMMA, field: "people" },
    ]);
  });

  it("lists an item named in two places once in the ids and once per place in the references", () => {
    const envelope = database({ project: [ALPHA], people: [ALPHA] });

    expect(referencedItemIdsOf(envelope)).toEqual([ALPHA]);
    expect(envelopeReferencesOf(envelope)).toHaveLength(2);
  });

  it("lists the page of a pageContent envelope under the field target", () => {
    const envelope: ProposalEnvelope = {
      entityKind: "pageContent",
      target: ALPHA,
      properties: { flavour: "paragraph" },
    };

    expect(envelopeReferencesOf(envelope)).toEqual([{ itemId: ALPHA, field: "target" }]);
  });

  it("lists the target of a relation envelope under the field target, and nothing for a synthetic occurrence id", () => {
    const relation = (target: string): ProposalEnvelope => ({
      entityKind: "relation",
      target,
      properties: { propertyKey: "event" },
    });

    expect(envelopeReferencesOf(relation(ALPHA))).toEqual([{ itemId: ALPHA, field: "target" }]);
    expect(referencedItemIdsOf(relation(`${ALPHA}@2026-11-20`))).toEqual([]);
  });

  it("lists ids in lower case and skips a value that is no item id", () => {
    const envelope = database({ project: [ALPHA.toUpperCase(), "not-an-id"] });

    expect(referencedItemIdsOf(envelope)).toEqual([ALPHA]);
  });

  it("lists the item a step updates and the item ids its relation lists write, under the step's own fields", () => {
    const update: ProposalStep = {
      ref: "task",
      op: "update",
      itemId: ALPHA,
      role: "primary",
      relations: { project: [BETA] },
      after: { relations: { people: [GAMMA, { ref: "person" }] } },
    };
    const link: ProposalStep = { ref: "person", op: "link", itemId: GAMMA, role: "secondary" };

    expect(envelopeReferencesOf(multiStep(update, link))).toEqual([
      { itemId: ALPHA, field: "itemId" },
      { itemId: BETA, field: "project" },
      { itemId: GAMMA, field: "people" },
      { itemId: GAMMA, field: "person.itemId" },
    ]);
  });

  it("names the field of a secondary step's relation list after the step", () => {
    const withProject: ProposalStep = { ...person, relations: { project: [ALPHA], companies: [{ ref: "company" }] } };

    expect(envelopeReferencesOf(multiStep(company, withProject))).toEqual([{ itemId: ALPHA, field: "person.project" }]);
  });

  it("skips a disabled step and an optional step that nothing refers to", () => {
    const disabled: ProposalStep = { ...person, enabled: false, relations: { project: [ALPHA] } };
    const unreferenced: ProposalStep = { ...person, ref: "extra", optional: true, relations: { project: [BETA] } };

    expect(referencedItemIdsOf(multiStep(company, disabled))).toEqual([]);
    expect(referencedItemIdsOf(multiStep(company, unreferenced))).toEqual([]);
  });

  it("lists an optional step that an active step refers to", () => {
    const optional: ProposalStep = { ...person, optional: true, relations: { project: [ALPHA] } };
    const referring: ProposalStep = { ...company, relations: { people: [{ ref: "person" }] } };

    expect(referencedItemIdsOf(multiStep(referring, optional))).toEqual([ALPHA]);
  });

  it("throws the step graph's ValidationError for a multi-step envelope that has no primary step", () => {
    expect(() => referencedItemIdsOf(multiStep(person))).toThrow(ValidationError);
  });
});

/** The source files of the packages and services that can write a Processing proposals card. */
async function productionSources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return entry.name === "__tests__" || entry.name === "node_modules" || entry.name === "dist"
          ? []
          : productionSources(full);
      }
      return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [full] : [];
    }),
  );
  return nested.flat();
}

/** The text of every inline `allowedSystemKeys: [ ... ]` array of `source`, brackets balanced. */
function allowedSystemKeyArrays(source: string): string[] {
  const arrays: string[] = [];
  for (const match of source.matchAll(/allowedSystemKeys:\s*\[/g)) {
    const start = match.index + match[0].length - 1;
    let depth = 0;
    for (let index = start; index < source.length; index += 1) {
      if (source[index] === "[") depth += 1;
      if (source[index] === "]") depth -= 1;
      if (depth === 0) {
        arrays.push(source.slice(start, index + 1));
        break;
      }
    }
  }
  return arrays;
}

describe("the writers of a card's proposal (issue #1916)", () => {
  const dataSrc = fileURLToPath(new URL("../../", import.meta.url));
  const servicesDir = fileURLToPath(new URL("../../../../../services", import.meta.url));

  it("every write that lists proposal among its allowed system keys lists referencedItemIds too", async () => {
    const services = (await readdir(servicesDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(servicesDir, entry.name, "src"));
    const files = (
      await Promise.all([dataSrc, ...services].map((root) => productionSources(root).catch(() => [])))
    ).flat();
    const writers: string[] = [];
    const offenders: string[] = [];
    for (const file of files) {
      for (const keys of allowedSystemKeyArrays(await readFile(file, "utf8"))) {
        if (!/"proposal"/.test(keys)) continue;
        writers.push(path.basename(file));
        if (!/"referencedItemIds"/.test(keys)) offenders.push(path.basename(file));
      }
    }

    expect(offenders).toEqual([]);
    // The scan is not vacuous: it found the writers this issue changed, the tick's four writes among them.
    expect(writers.filter((name) => name === "inboxTickAction.ts")).toHaveLength(4);
    expect([...new Set(writers)].sort()).toEqual([
      "inboxTickAction.ts",
      "proposalActions.ts",
      "proposalReset.ts",
      "proposalSplit.ts",
      "proposalThreadRevision.ts",
      "proposalValueUpdates.ts",
      "transcriptCardRecomputeStore.ts",
      "transcriptEventMatch.ts",
      "transcriptSpeakerSuggestion.ts",
    ]);
  });
});

describe("runWhileConfirmingCard and isCardBeingConfirmed (issue #1916)", () => {
  const client = {} as PoolClient;
  const otherClient = {} as PoolClient;

  it("marks the card on its connection while the confirm runs, and returns what the confirm returns", async () => {
    const seen = await runWhileConfirmingCard(client, ALPHA, async () => ({
      card: isCardBeingConfirmed(client, ALPHA),
      otherCard: isCardBeingConfirmed(client, BETA),
      otherConnection: isCardBeingConfirmed(otherClient, ALPHA),
    }));

    expect(seen).toEqual({ card: true, otherCard: false, otherConnection: false });
    expect(isCardBeingConfirmed(client, ALPHA)).toBe(false);
  });

  it("removes the mark when the confirm fails, so a caller that goes on in the transaction is not left with it", async () => {
    await expect(
      runWhileConfirmingCard(client, ALPHA, async () => {
        throw new ValidationError("refused");
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(isCardBeingConfirmed(client, ALPHA)).toBe(false);
  });

  it("keeps the mark of an outer confirm when an inner one of the same card ends", async () => {
    await runWhileConfirmingCard(client, ALPHA, async () => {
      await runWhileConfirmingCard(client, ALPHA, async () => undefined);
      expect(isCardBeingConfirmed(client, ALPHA)).toBe(true);
    });

    expect(isCardBeingConfirmed(client, ALPHA)).toBe(false);
  });
});
