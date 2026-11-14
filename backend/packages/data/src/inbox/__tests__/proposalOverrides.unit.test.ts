import { describe, expect, it } from "vitest";
import { ValidationError } from "../../errors.js";
import type { ProposalEnvelope, ProposalStep } from "../proposalEnvelope.js";
import {
  composeEffectiveEnvelope,
  computeUserEditedKeys,
  fieldOverridesOf,
  mergeUserOverrides,
  parseUserOverrides,
  retainOverridesForEnvelope,
  retainOverridesForThreadRevision,
} from "../proposalOverrides.js";

const TASKS = "00000000-0000-4000-8000-000000000001";

const single = (properties: Record<string, unknown>): ProposalEnvelope => ({
  entityKind: "database",
  target: TASKS,
  properties,
});

const companyStep: ProposalStep = {
  ref: "company",
  op: "create",
  databaseKey: "companies",
  role: "primary",
  properties: { name: "Acme" },
};
const personStep: ProposalStep = {
  ref: "person",
  op: "create",
  databaseKey: "people",
  role: "secondary",
  properties: { name: "Jane" },
  relations: { companies: [{ ref: "company" }] },
};
const updateStep: ProposalStep = {
  ref: "task",
  op: "update",
  itemId: "00000000-0000-4000-8000-000000000002",
  role: "secondary",
  properties: { name: "New name" },
  before: { properties: { name: "Old name" } },
  after: { properties: { name: "New name" } },
};
const multi = (...steps: ProposalStep[]): ProposalEnvelope => ({
  entityKind: "database",
  target: TASKS,
  properties: steps.find((step) => step.role === "primary")?.properties ?? {},
  operations: steps,
});

function refusal(run: () => unknown): ValidationError {
  try {
    run();
  } catch (error) {
    if (error instanceof ValidationError) return error;
    throw error;
  }
  throw new Error("expected a ValidationError");
}

describe("parseUserOverrides", () => {
  it.each([null, undefined])("reads %s as no overrides", (value) => {
    expect(parseUserOverrides(value, "p1")).toEqual({});
  });

  it("returns a stored map of maps", () => {
    expect(parseUserOverrides({ primary: { name: "A", flagged: true } }, "p1")).toEqual({
      primary: { name: "A", flagged: true },
    });
  });

  it.each([[[]], ["text"], [{ primary: "A" }], [{ primary: ["A"] }]])("throws for the malformed value %j", (value) => {
    expect(() => parseUserOverrides(value, "p1")).toThrow("Malformed userOverrides on proposal p1");
  });
});

describe("computeUserEditedKeys", () => {
  it("counts a value that differs from the assistant's", () => {
    expect(computeUserEditedKeys(single({ name: "Buy milk" }), { primary: { name: "Buy oat milk" } })).toEqual([
      "primary.name",
    ]);
  });

  it("does not count a value equal to the assistant's, compared deeply", () => {
    const ai = single({ name: "Buy milk", tags: { list: [1, 2] } });
    expect(computeUserEditedKeys(ai, { primary: { name: "Buy milk", tags: { list: [1, 2] } } })).toEqual([]);
  });

  it("counts a value the assistant did not set, including null", () => {
    expect(computeUserEditedKeys(single({ name: "Buy milk" }), { primary: { date: null } })).toEqual(["primary.date"]);
  });

  it("lists the keys of every ref sorted", () => {
    const ai = multi(companyStep, personStep);
    expect(
      computeUserEditedKeys(ai, { person: { name: "Janet", role: "CEO" }, company: { name: "Acme Corp" } }),
    ).toEqual(["company.name", "person.name", "person.role"]);
  });

  it("returns no keys for no overrides", () => {
    expect(computeUserEditedKeys(single({ name: "Buy milk" }), {})).toEqual([]);
  });

  it("throws for a ref the envelope does not have, naming it", () => {
    const error = refusal(() => computeUserEditedKeys(single({ name: "A" }), { missing: { name: "B" } }));
    expect(error.message).toContain("'missing'");
    expect(error.details).toEqual({ ref: "missing", field: "missing" });
  });
});

describe("mergeUserOverrides", () => {
  it("lays the new values over the current ones", () => {
    const ai = single({ name: "Buy milk" });
    expect(mergeUserOverrides(ai, { primary: { name: "A" } }, { primary: { name: "B", date: "2026-11-13" } })).toEqual({
      primary: { name: "B", date: "2026-11-13" },
    });
  });

  it("keeps the current values of a ref the new set does not mention", () => {
    const ai = multi(companyStep, personStep);
    expect(mergeUserOverrides(ai, { company: { name: "Acme Corp" } }, { person: { name: "Janet" } })).toEqual({
      company: { name: "Acme Corp" },
      person: { name: "Janet" },
    });
  });

  it("drops a value set back to the assistant's, and the ref when nothing is left", () => {
    const ai = single({ name: "Buy milk" });
    expect(mergeUserOverrides(ai, { primary: { name: "Buy oat milk" } }, { primary: { name: "Buy milk" } })).toEqual(
      {},
    );
  });

  it("drops only the value set back and keeps the others of its ref", () => {
    const ai = single({ name: "Buy milk" });
    expect(
      mergeUserOverrides(ai, { primary: { name: "Buy oat milk", flagged: true } }, { primary: { name: "Buy milk" } }),
    ).toEqual({ primary: { flagged: true } });
  });

  it("throws for a ref of the set that the envelope does not have", () => {
    const error = refusal(() => mergeUserOverrides(single({ name: "A" }), {}, { second: { name: "B" } }));
    expect(error.details).toEqual({ ref: "second", field: "second" });
  });

  it("throws for a stored ref that the envelope no longer has", () => {
    expect(() =>
      mergeUserOverrides(single({ name: "A" }), { gone: { name: "B" } }, { primary: { name: "C" } }),
    ).toThrow(ValidationError);
  });

  it("keeps an own key named like an Object member as data", () => {
    const set = JSON.parse('{"primary":{"__proto__":{"polluted":true}}}') as Record<string, Record<string, unknown>>;
    const merged = mergeUserOverrides(single({ name: "A" }), {}, set);
    expect(Object.keys(merged.primary ?? {})).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf(merged.primary)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("composeEffectiveEnvelope", () => {
  it("lays a single-step envelope's overrides over its properties and leaves the rest alone", () => {
    const ai: ProposalEnvelope = { ...single({ name: "Buy milk", flagged: false }), relations: { project: ["p1"] } };
    expect(composeEffectiveEnvelope(ai, { primary: { name: "Buy oat milk" } })).toEqual({
      entityKind: "database",
      target: TASKS,
      properties: { name: "Buy oat milk", flagged: false },
      relations: { project: ["p1"] },
    });
  });

  it("returns an envelope equal to the assistant's for no overrides", () => {
    const ai = single({ name: "Buy milk" });
    expect(composeEffectiveEnvelope(ai, {})).toEqual(ai);
  });

  it("does not change the envelope it is given", () => {
    const ai = single({ name: "Buy milk" });
    composeEffectiveEnvelope(ai, { primary: { name: "Buy oat milk" } });
    expect(ai.properties).toEqual({ name: "Buy milk" });
  });

  it("lays a secondary step's overrides over that step only", () => {
    const ai = multi(companyStep, personStep);
    const effective = composeEffectiveEnvelope(ai, { person: { name: "Janet" } });
    expect(effective.operations).toEqual([companyStep, { ...personStep, properties: { name: "Janet" } }]);
    expect(effective.properties).toEqual({ name: "Acme" });
  });

  it("mirrors the primary step's overrides into the envelope's top-level properties", () => {
    const ai = multi(personStep, companyStep);
    const effective = composeEffectiveEnvelope(ai, { company: { name: "Acme Corp" } });
    expect(effective.properties).toEqual({ name: "Acme Corp" });
    expect(effective.operations).toEqual([personStep, { ...companyStep, properties: { name: "Acme Corp" } }]);
  });

  it("writes an update step's override to its after.properties as well", () => {
    const ai = multi(companyStep, updateStep);
    const effective = composeEffectiveEnvelope(ai, { task: { name: "Typed name" } });
    expect(effective.operations?.[1]).toEqual({
      ...updateStep,
      properties: { name: "Typed name" },
      after: { properties: { name: "Typed name" } },
    });
  });

  it("does not add an after block to a create step", () => {
    const effective = composeEffectiveEnvelope(multi(companyStep), { company: { name: "Acme Corp" } });
    expect(effective.operations?.[0]).not.toHaveProperty("after");
  });

  it("treats a step without properties as empty", () => {
    const bare: ProposalStep = { ref: "bare", op: "create", databaseKey: "people", role: "secondary" };
    const ai = multi(companyStep, bare);
    expect(composeEffectiveEnvelope(ai, { bare: { name: "Typed" } }).operations?.[1]?.properties).toEqual({
      name: "Typed",
    });
  });

  it("throws for a ref a single-step envelope does not have, naming it", () => {
    const error = refusal(() => composeEffectiveEnvelope(single({ name: "A" }), { person: { name: "B" } }));
    expect(error.message).toContain("'person'");
  });

  it("throws for a ref a multi-step envelope does not have", () => {
    expect(() => composeEffectiveEnvelope(multi(companyStep), { primary: { name: "B" } })).toThrow(ValidationError);
  });

  it("lets a pageContent override replace a key the envelope holds", () => {
    const ai: ProposalEnvelope = {
      entityKind: "pageContent",
      target: TASKS,
      properties: { markdown: "- first", placement: "end" },
    };
    expect(composeEffectiveEnvelope(ai, { primary: { markdown: "- second" } }).properties).toEqual({
      markdown: "- second",
      placement: "end",
    });
  });

  it("refuses a pageContent key the envelope does not hold, naming the key", () => {
    const ai: ProposalEnvelope = {
      entityKind: "pageContent",
      target: TASKS,
      properties: { markdown: "- first", placement: "end" },
    };
    const error = refusal(() => composeEffectiveEnvelope(ai, { primary: { heading: "New" } }));
    expect(error.details).toEqual({ ref: "primary", field: "heading" });
  });

  it("refuses a relation key the envelope does not hold", () => {
    const ai: ProposalEnvelope = {
      entityKind: "relation",
      target: TASKS,
      properties: { propertyKey: "event" },
    };
    expect(() => composeEffectiveEnvelope(ai, { primary: { metadata: {} } })).toThrow(ValidationError);
  });
});

describe("retainOverridesForEnvelope", () => {
  const EVENTS = "00000000-0000-4000-8000-000000000003";
  const TASK_KEYS = ["name", "flagged", "date"];

  it("drops every override and reports a reset when the entityKind changes", () => {
    const previous = single({ name: "Buy milk" });
    const next: ProposalEnvelope = { entityKind: "pageContent", target: TASKS, properties: { markdown: "- a" } };
    expect(
      retainOverridesForEnvelope(previous, next, { primary: { name: "Typed", flagged: true } }, ["markdown"]),
    ).toEqual({ userOverrides: {}, userEditedKeys: [], reset: true, droppedKeys: ["primary.flagged", "primary.name"] });
  });

  it("drops every override and reports a reset when the target changes, even for keys the new target also has", () => {
    const next: ProposalEnvelope = { entityKind: "database", target: EVENTS, properties: { name: "Lunch" } };
    expect(
      retainOverridesForEnvelope(single({ name: "Buy milk" }), next, { primary: { name: "Typed" } }, TASK_KEYS),
    ).toEqual({
      userOverrides: {},
      userEditedKeys: [],
      reset: true,
      droppedKeys: ["primary.name"],
    });
  });

  it("drops the overrides of every ref on a reset", () => {
    const next: ProposalEnvelope = { entityKind: "database", target: EVENTS, properties: { name: "Lunch" } };
    const retained = retainOverridesForEnvelope(
      multi(companyStep, personStep),
      next,
      { company: { name: "A" }, person: { name: "B" } },
      TASK_KEYS,
    );
    expect(retained.droppedKeys).toEqual(["company.name", "person.name"]);
  });

  it("keeps the overrides whose keys are properties of the same destination", () => {
    expect(
      retainOverridesForEnvelope(
        single({ name: "Buy milk" }),
        single({ name: "Buy oat milk" }),
        { primary: { name: "Typed", flagged: true } },
        TASK_KEYS,
      ),
    ).toEqual({
      userOverrides: { primary: { name: "Typed", flagged: true } },
      userEditedKeys: ["primary.flagged", "primary.name"],
      reset: false,
      droppedKeys: [],
    });
  });

  it("drops only the override whose key is not a property of the destination", () => {
    expect(
      retainOverridesForEnvelope(
        single({ name: "Buy milk" }),
        single({ name: "Buy oat milk" }),
        { primary: { name: "Typed", colour: "red" } },
        TASK_KEYS,
      ),
    ).toEqual({
      userOverrides: { primary: { name: "Typed" } },
      userEditedKeys: ["primary.name"],
      reset: false,
      droppedKeys: ["primary.colour"],
    });
  });

  it("returns nothing to drop and no reset change for no overrides", () => {
    expect(retainOverridesForEnvelope(single({ name: "A" }), single({ name: "B" }), {}, TASK_KEYS)).toEqual({
      userOverrides: {},
      userEditedKeys: [],
      reset: false,
      droppedKeys: [],
    });
  });

  it("reports a reset with nothing dropped for no overrides on a changed destination", () => {
    const next: ProposalEnvelope = { entityKind: "database", target: EVENTS, properties: { name: "Lunch" } };
    expect(retainOverridesForEnvelope(single({ name: "A" }), next, {}, TASK_KEYS)).toEqual({
      userOverrides: {},
      userEditedKeys: [],
      reset: true,
      droppedKeys: [],
    });
  });

  it("treats a missing previous envelope as no change of destination", () => {
    const retained = retainOverridesForEnvelope(null, single({ name: "A" }), { primary: { name: "Typed" } }, TASK_KEYS);
    expect(retained).toMatchObject({ reset: false, droppedKeys: [], userEditedKeys: ["primary.name"] });
  });

  it("accepts a previous envelope of an entityKind this release does not know", () => {
    const retained = retainOverridesForEnvelope(
      { entityKind: "futureKind", target: TASKS },
      single({ name: "A" }),
      { primary: { name: "Typed" } },
      TASK_KEYS,
    );
    expect(retained).toMatchObject({ reset: true, droppedKeys: ["primary.name"] });
  });

  it("neither keeps nor reports a value that now equals the new assistant value", () => {
    expect(
      retainOverridesForEnvelope(
        single({ name: "Buy milk" }),
        single({ name: "Typed" }),
        { primary: { name: "Typed" } },
        TASK_KEYS,
      ),
    ).toEqual({ userOverrides: {}, userEditedKeys: [], reset: false, droppedKeys: [] });
  });

  it("matches a pageContent envelope's keys against the keys of its properties", () => {
    const previous: ProposalEnvelope = {
      entityKind: "pageContent",
      target: TASKS,
      properties: { flavour: "paragraph" },
    };
    const next: ProposalEnvelope = {
      entityKind: "pageContent",
      target: TASKS,
      properties: { flavour: "paragraph", fields: { content: "B" } },
    };
    const overrides = { primary: { fields: { content: "typed" }, children: ["x"] } };
    expect(retainOverridesForEnvelope(previous, next, overrides, Object.keys(next.properties))).toEqual({
      userOverrides: { primary: { fields: { content: "typed" } } },
      userEditedKeys: ["primary.fields"],
      reset: false,
      droppedKeys: ["primary.children"],
    });
  });

  it("drops the overrides of refs a single-step next envelope does not have", () => {
    const retained = retainOverridesForEnvelope(
      multi(companyStep, personStep),
      single({ name: "Acme" }),
      { company: { name: "A" }, person: { name: "B" }, primary: { name: "C" } },
      TASK_KEYS,
    );
    expect(retained.droppedKeys).toEqual(["company.name", "person.name"]);
    expect(retained.userOverrides).toEqual({ primary: { name: "C" } });
  });

  it("keeps the overrides of the primary step of a multi-step next envelope and drops the other steps'", () => {
    const next = multi(companyStep, personStep);
    const retained = retainOverridesForEnvelope(
      { entityKind: "database", target: TASKS },
      next,
      { company: { name: "Acme Corp" }, person: { name: "Janet" } },
      ["name"],
    );
    expect(retained).toEqual({
      userOverrides: { company: { name: "Acme Corp" } },
      userEditedKeys: ["company.name"],
      reset: false,
      droppedKeys: ["person.name"],
    });
  });

  it("drops everything when a multi-step next envelope has no primary step", () => {
    const next: ProposalEnvelope = { ...multi(personStep), operations: [personStep] };
    const retained = retainOverridesForEnvelope(null, next, { person: { name: "Janet" } }, ["name"]);
    expect(retained).toEqual({ userOverrides: {}, userEditedKeys: [], reset: false, droppedKeys: ["person.name"] });
  });
});

describe("retainOverridesForThreadRevision (issue #1938)", () => {
  const previous = single({ name: "Buy milk", due: "2026-11-14", note: "From the capture" });

  it("keeps the previous assistant value of an edited key and makes the revised value the manual one", () => {
    const retained = retainOverridesForThreadRevision(
      previous,
      single({ name: "Buy oat milk", due: "2026-11-15", note: "From the capture, changed" }),
      { primary: { name: "Buy bio milk" } },
    );

    // `name` is the user's key: the assistant's own value stays, and the instruction's value is the manual one.
    expect(retained.aiProposal.properties).toEqual({
      name: "Buy milk",
      due: "2026-11-15",
      note: "From the capture, changed",
    });
    expect(retained.userOverrides).toEqual({ primary: { name: "Buy oat milk" } });
    expect(retained.userEditedKeys).toEqual(["primary.name"]);
    expect(retained).toMatchObject({ reset: false, droppedKeys: [] });
  });

  it("keeps an edited key that the instruction did not touch protected with the value the assistant saw", () => {
    const retained = retainOverridesForThreadRevision(
      previous,
      single({ name: "Buy bio milk", due: "2026-11-15", note: "x" }),
      {
        primary: { name: "Buy bio milk" },
      },
    );

    expect(retained.userOverrides).toEqual({ primary: { name: "Buy bio milk" } });
    expect(retained.userEditedKeys).toEqual(["primary.name"]);
    expect(retained.aiProposal.properties.name).toBe("Buy milk");
    expect(retained.aiProposal.properties.due).toBe("2026-11-15");
  });

  it("stops treating a key as edited when the instruction sets it back to the assistant's value", () => {
    const retained = retainOverridesForThreadRevision(
      previous,
      single({ name: "Buy milk", due: "2026-11-14", note: "x" }),
      {
        primary: { name: "Buy bio milk" },
      },
    );

    expect(retained.userOverrides).toEqual({});
    expect(retained.userEditedKeys).toEqual([]);
    expect(retained.aiProposal.properties.name).toBe("Buy milk");
    expect(retained.droppedKeys).toEqual([]);
  });

  it("keeps a manual key that the assistant had no value for out of aiProposal", () => {
    const retained = retainOverridesForThreadRevision(
      single({ name: "Buy milk" }),
      single({ name: "Buy milk", due: "2026-12-01" }),
      {
        primary: { due: "2026-12-01" },
      },
    );

    expect(retained.aiProposal.properties).toEqual({ name: "Buy milk" });
    expect(retained.userOverrides).toEqual({ primary: { due: "2026-12-01" } });
    expect(retained.userEditedKeys).toEqual(["primary.due"]);
  });

  it("keeps the manual value of an edited key that the revised envelope leaves out, with the assistant's value beside it", () => {
    const retained = retainOverridesForThreadRevision(previous, single({ name: "Buy milk" }), {
      primary: { due: "2026-12-01" },
    });

    expect(retained.aiProposal.properties).toEqual({ name: "Buy milk", due: "2026-11-14" });
    expect(retained.userOverrides).toEqual({ primary: { due: "2026-12-01" } });
    expect(retained.userEditedKeys).toEqual(["primary.due"]);
    expect(retained.droppedKeys).toEqual([]);
  });

  it("keeps a manual key that the assistant had no value for when the revised envelope leaves it out", () => {
    const retained = retainOverridesForThreadRevision(single({ name: "Buy milk" }), single({ name: "Buy oat milk" }), {
      primary: { due: "2026-12-01" },
    });

    expect(retained.aiProposal.properties).toEqual({ name: "Buy oat milk" });
    expect(retained.userOverrides).toEqual({ primary: { due: "2026-12-01" } });
    expect(retained.userEditedKeys).toEqual(["primary.due"]);
  });

  it("clears an edited key only when the revised envelope holds an explicit null for it", () => {
    const retained = retainOverridesForThreadRevision(previous, single({ name: "Buy milk", due: null }), {
      primary: { due: "2026-12-01" },
    });

    expect(retained.aiProposal.properties).toEqual({ name: "Buy milk", due: "2026-11-14" });
    expect(retained.userOverrides).toEqual({ primary: { due: null } });
    expect(retained.userEditedKeys).toEqual(["primary.due"]);
  });

  it("drops every manual value, and lists them, when the target database changes", () => {
    const other = { ...single({ name: "Meeting" }), target: "00000000-0000-4000-8000-000000000009" };

    const retained = retainOverridesForThreadRevision(previous, other, { primary: { name: "Mine", due: "x" } });

    expect(retained).toEqual({
      aiProposal: other,
      userOverrides: {},
      userEditedKeys: [],
      reset: true,
      droppedKeys: ["primary.due", "primary.name"],
    });
  });

  it("drops every manual value when the entity kind changes and the target does not", () => {
    const page: ProposalEnvelope = { entityKind: "pageContent", target: TASKS, properties: { flavour: "paragraph" } };

    const retained = retainOverridesForThreadRevision(previous, page, { primary: { name: "Mine" } });

    expect(retained).toMatchObject({ reset: true, userOverrides: {}, droppedKeys: ["primary.name"] });
  });

  it("drops and lists the manual values of any other step, which the revised single-step envelope does not have", () => {
    const retained = retainOverridesForThreadRevision(single({ name: "Acme" }), single({ name: "Mine" }), {
      primary: { name: "Mine" },
      person: { name: "Jane" },
    });

    expect(retained.userOverrides).toEqual({ primary: { name: "Mine" } });
    expect(retained.droppedKeys).toEqual(["person.name"]);
  });

  it("maps the overrides of the primary step of a multi-step previous envelope to the single step", () => {
    const retained = retainOverridesForThreadRevision(multi(companyStep, personStep), single({ name: "Mine" }), {
      company: { name: "Mine" },
      person: { name: "Jane" },
    });

    expect(retained.userOverrides).toEqual({ primary: { name: "Mine" } });
    expect(retained.droppedKeys).toEqual(["person.name"]);
  });

  it("has no manual value to keep for a card without a previous envelope", () => {
    const retained = retainOverridesForThreadRevision(null, single({ name: "Buy milk" }), {
      primary: { name: "Mine" },
    });

    expect(retained).toMatchObject({ reset: false, userOverrides: {}, droppedKeys: ["primary.name"] });
    expect(retained.aiProposal).toEqual(single({ name: "Buy milk" }));
  });

  it("leaves its inputs unchanged", () => {
    const revised = single({ name: "Buy oat milk" });
    const overrides = { primary: { name: "Buy bio milk" } };
    const copyOfRevised = structuredClone(revised);
    const copyOfOverrides = structuredClone(overrides);

    retainOverridesForThreadRevision(previous, revised, overrides);

    expect(revised).toEqual(copyOfRevised);
    expect(overrides).toEqual(copyOfOverrides);
  });
});

describe("pseudo editor fields in the overrides (issue #1928)", () => {
  const PSEUDO = new Set(["allDay", "followDate"]);

  describe("computeUserEditedKeys with hidden keys", () => {
    it("leaves a hidden field's override out of the edited keys and counts the others", () => {
      const overrides = { primary: { name: "Milk", followDate: "2026-12-01", allDay: true } };
      expect(computeUserEditedKeys(single({}), overrides, new Set(["followDate"]))).toEqual([
        "primary.allDay",
        "primary.name",
      ]);
      expect(computeUserEditedKeys(single({}), overrides)).toEqual([
        "primary.allDay",
        "primary.followDate",
        "primary.name",
      ]);
    });
  });

  describe("composeEffectiveEnvelope with pseudo keys", () => {
    it("keeps a pseudo value out of a single-step envelope and applies the real one", () => {
      const effective = composeEffectiveEnvelope(
        single({ name: "Milk" }),
        { primary: { name: "Oat", allDay: true } },
        PSEUDO,
      );
      expect(effective.properties).toEqual({ name: "Oat" });
    });

    it("keeps a pseudo value out of every copy of a multi-step envelope's step", () => {
      const envelope = multi(companyStep, updateStep);
      const effective = composeEffectiveEnvelope(
        envelope,
        { company: { allDay: true }, task: { name: "Newer", followDate: "2026-12-01" } },
        PSEUDO,
      );
      expect(effective.operations?.find((step) => step.ref === "company")).toEqual(companyStep);
      expect(effective.operations?.find((step) => step.ref === "task")).toMatchObject({
        properties: { name: "Newer" },
        after: { properties: { name: "Newer" } },
      });
      expect(effective.properties).toEqual({ name: "Acme" });
    });

    it("lets a pageContent envelope take a pseudo key it does not hold, and still refuses another one", () => {
      const page: ProposalEnvelope = {
        entityKind: "pageContent",
        target: TASKS,
        properties: { markdown: "Text", placement: "end" },
      };
      expect(composeEffectiveEnvelope(page, { primary: { day: "2026-11-13" } }, new Set(["day"]))).toEqual(page);
      expect(() => composeEffectiveEnvelope(page, { primary: { day: "2026-11-13" } })).toThrow(ValidationError);
    });

    it("writes a pseudo-named key into a single-step envelope when the key is not declared pseudo", () => {
      const effective = composeEffectiveEnvelope(single({ name: "Milk" }), { primary: { allDay: true } });
      expect(effective.properties).toEqual({ name: "Milk", allDay: true });
    });
  });
});

describe("relation lists and step switches in the overrides (issue #1920)", () => {
  const A = "00000000-0000-4000-8000-0000000000a1";
  const B = "00000000-0000-4000-8000-0000000000b2";
  const C = "00000000-0000-4000-8000-0000000000c3";
  const withRelations = (
    properties: Record<string, unknown>,
    relations: Record<string, string[]>,
  ): ProposalEnvelope => ({
    ...single(properties),
    relations,
  });
  const followupStep: ProposalStep = {
    ref: "followup",
    op: "create",
    databaseKey: "tasks",
    role: "secondary",
    properties: { name: "Follow up" },
  };
  const withFollowup = (extra: Partial<ProposalStep> = {}): ProposalEnvelope =>
    multi(companyStep, { ...followupStep, ...extra });
  const updateRelationStep: ProposalStep = {
    ref: "project",
    op: "update",
    itemId: "00000000-0000-4000-8000-000000000002",
    role: "primary",
    properties: { name: "Move" },
    relations: { area: [A] },
    before: { properties: { name: "Move" }, relations: { area: [B] } },
    after: { properties: { name: "Move" }, relations: { area: [A] } },
  };

  describe("parseUserOverrides", () => {
    it("reads relation lists and a step switch", () => {
      const stored = { primary: { name: "x", relations: { project: [A] }, enabled: false } };
      expect(parseUserOverrides(stored, "p1")).toEqual(stored);
    });

    it.each([
      ["a relation map that is not an object", { primary: { relations: [A] } }],
      ["a relation list that is not an array", { primary: { relations: { project: A } } }],
      ["a relation id that is not a non-empty string", { primary: { relations: { project: [""] } } }],
      ["a step switch that is not a boolean", { primary: { enabled: "no" } }],
    ])("throws on %s", (_label, stored) => {
      expect(() => parseUserOverrides(stored, "p1")).toThrow("Malformed userOverrides on proposal p1");
    });
  });

  describe("fieldOverridesOf", () => {
    it("leaves out the reserved keys and answers {} for a ref with no overrides", () => {
      const overrides = { primary: { name: "x", relations: { project: [A] }, enabled: true } };
      expect(fieldOverridesOf(overrides, "primary")).toEqual({ name: "x" });
      expect(fieldOverridesOf(overrides, "other")).toEqual({});
    });
  });

  describe("mergeUserOverrides", () => {
    it("keeps a relation list that differs from the assistant's and replaces it as a whole", () => {
      const ai = withRelations({ name: "x" }, { project: [A] });
      const first = mergeUserOverrides(ai, {}, { primary: { relations: { project: [B, C] } } });
      expect(first).toEqual({ primary: { relations: { project: [B, C] } } });
      expect(mergeUserOverrides(ai, first, { primary: { relations: { project: [C] } } })).toEqual({
        primary: { relations: { project: [C] } },
      });
    });

    it("keeps the lists of other relation keys, and the field values, beside a newly replaced list", () => {
      const ai = single({ name: "x" });
      const current = { primary: { name: "y", relations: { project: [A] } } };
      expect(mergeUserOverrides(ai, current, { primary: { relations: { people: [B] } } })).toEqual({
        primary: { name: "y", relations: { project: [A], people: [B] } },
      });
    });

    it("drops a list equal to the assistant's, in any order, and a list that is empty where the assistant had none", () => {
      const ai = withRelations({ name: "x" }, { project: [A, B] });
      expect(mergeUserOverrides(ai, {}, { primary: { relations: { project: [B, A] } } })).toEqual({});
      expect(mergeUserOverrides(single({ name: "x" }), {}, { primary: { relations: { project: [] } } })).toEqual({});
    });

    it("counts a list as different from one that holds a step reference, even when it names the same item", () => {
      const ai = multi(companyStep, { ...personStep, relations: { companies: [{ ref: "company" }] } });
      expect(mergeUserOverrides(ai, {}, { person: { relations: { companies: [A] } } })).toEqual({
        person: { relations: { companies: [A] } },
      });
    });

    it.each(["constructor", "toString", "hasOwnProperty"])(
      "treats the relation key '%s', named like an Object member, as a key the assistant holds no list for",
      (key) => {
        const lists = { [key]: [A] };
        for (const ai of [single({ name: "x" }), withFollowup()]) {
          const ref = ai.operations ? "company" : "primary";
          const merged = mergeUserOverrides(ai, {}, { [ref]: { relations: lists } });
          expect(Object.keys(merged)).toEqual([ref]);
          expect(Object.entries(merged[ref]?.relations ?? {})).toEqual([[key, [A]]]);
        }
      },
    );

    it("reads the relations of an update step from its `after`", () => {
      const ai = multi({ ...updateRelationStep });
      expect(mergeUserOverrides(ai, {}, { project: { relations: { area: [A] } } })).toEqual({});
      expect(mergeUserOverrides(ai, {}, { project: { relations: { area: [C] } } })).toEqual({
        project: { relations: { area: [C] } },
      });
    });

    it("keeps a step switch that differs from the assistant's and drops one that equals it", () => {
      const ai = withFollowup();
      expect(mergeUserOverrides(ai, {}, { followup: { enabled: false } })).toEqual({ followup: { enabled: false } });
      expect(mergeUserOverrides(ai, { followup: { enabled: false } }, { followup: { enabled: true } })).toEqual({});
      expect(mergeUserOverrides(withFollowup({ enabled: false }), {}, { followup: { enabled: true } })).toEqual({
        followup: { enabled: true },
      });
      expect(mergeUserOverrides(withFollowup({ enabled: false }), {}, { followup: { enabled: false } })).toEqual({});
    });

    it("takes the switch of the new edit over the stored one, and keeps the stored one when the edit has none", () => {
      const ai = withFollowup();
      const current = { followup: { enabled: false } };
      expect(mergeUserOverrides(ai, current, { followup: { name: "x" } })).toEqual({
        followup: { name: "x", enabled: false },
      });
    });

    it("refuses a list or a switch of a ref the envelope does not have, naming it", () => {
      for (const edits of [{ nowhere: { relations: { project: [A] } } }, { nowhere: { enabled: false } }]) {
        expect(() => mergeUserOverrides(withFollowup(), {}, edits)).toThrow(ValidationError);
      }
    });
  });

  describe("computeUserEditedKeys", () => {
    it("names a relation list as ref.relations.key and a switch as ref.enabled, sorted with the field values", () => {
      const ai = withFollowup();
      const overrides = {
        company: { name: "Acme Corp", relations: { people: [A] } },
        followup: { enabled: true },
      };
      expect(computeUserEditedKeys(ai, overrides)).toEqual(["company.name", "company.relations.people"]);
      expect(computeUserEditedKeys(withFollowup({ enabled: false }), overrides)).toEqual([
        "company.name",
        "company.relations.people",
        "followup.enabled",
      ]);
    });

    it.each(["constructor", "toString", "hasOwnProperty"])(
      "counts a list under the relation key '%s', named like an Object member, as an edit",
      (key) => {
        const lists = { [key]: [A] };
        expect(computeUserEditedKeys(single({ name: "x" }), { primary: { relations: lists } })).toEqual([
          `primary.relations.${key}`,
        ]);
        expect(computeUserEditedKeys(withFollowup(), { company: { relations: lists } })).toEqual([
          `company.relations.${key}`,
        ]);
      },
    );

    it("counts only the switch of a step that is switched off, not its fields or lists", () => {
      const ai = withFollowup();
      const overrides = { followup: { name: "Call", relations: { project: [A] }, enabled: false } };
      expect(computeUserEditedKeys(ai, overrides)).toEqual(["followup.enabled"]);
    });

    it("does not count the fields of a step the assistant switched off and the user did not switch on", () => {
      const ai = withFollowup({ enabled: false });
      expect(computeUserEditedKeys(ai, { followup: { name: "Call" } })).toEqual([]);
    });

    it("leaves a relation list out when its key is hidden, and counts one that is not", () => {
      const overrides = { primary: { relations: { project: [A], people: [B] } } };
      expect(computeUserEditedKeys(single({}), overrides, new Set(["project"]))).toEqual(["primary.relations.people"]);
    });

    it("does not count a list or a switch that equals the assistant's", () => {
      const ai = withRelations({}, { project: [A] });
      expect(computeUserEditedKeys(ai, { primary: { relations: { project: [A] }, enabled: true } })).toEqual([]);
    });
  });

  describe("composeEffectiveEnvelope", () => {
    it("replaces a list of a single-step envelope and keeps the others and the properties", () => {
      const ai = withRelations({ name: "x" }, { project: [A], people: [B] });
      const effective = composeEffectiveEnvelope(ai, { primary: { name: "y", relations: { project: [C] } } });
      expect(effective).toEqual(withRelations({ name: "y" }, { project: [C], people: [B] }));
      expect(ai).toEqual(withRelations({ name: "x" }, { project: [A], people: [B] }));
    });

    it("adds no `relations` to a single-step envelope that has none and gets none", () => {
      expect(composeEffectiveEnvelope(single({ name: "x" }), { primary: { name: "y" } })).not.toHaveProperty(
        "relations",
      );
    });

    it("never writes a reserved key into properties", () => {
      const effective = composeEffectiveEnvelope(single({ name: "x" }), {
        primary: { relations: { project: [A] }, enabled: true },
      });
      expect(effective.properties).toEqual({ name: "x" });
    });

    it("carries a list on a pageContent envelope for the envelope validation to refuse", () => {
      const page: ProposalEnvelope = { entityKind: "pageContent", target: TASKS, properties: { markdown: "x" } };
      expect(composeEffectiveEnvelope(page, { primary: { relations: { project: [A] } } })).toEqual({
        ...page,
        relations: { project: [A] },
      });
    });

    it("replaces the list of a create step whole, dropping its step reference, and leaves other steps alone", () => {
      const ai = multi(companyStep, { ...personStep });
      const effective = composeEffectiveEnvelope(ai, { person: { relations: { companies: [A] } } });
      expect(effective.operations).toEqual([companyStep, { ...personStep, relations: { companies: [A] } }]);
    });

    it("sets the list of an update step in `after`, and in `relations` where the step holds the key", () => {
      const ai = multi({ ...updateRelationStep, relations: undefined });
      const effective = composeEffectiveEnvelope(ai, { project: { relations: { area: [C] } } });
      const step = effective.operations?.[0];
      expect(step?.after?.relations).toEqual({ area: [C] });
      expect(step?.relations).toBeUndefined();
      const holding = composeEffectiveEnvelope(multi(updateRelationStep), { project: { relations: { area: [C] } } });
      expect(holding.operations?.[0]).toMatchObject({ relations: { area: [C] }, after: { relations: { area: [C] } } });
    });

    it("sets a step's switch and leaves the other steps' as they are", () => {
      const effective = composeEffectiveEnvelope(withFollowup(), { followup: { enabled: false } });
      expect(effective.operations?.map((step) => step.enabled)).toEqual([undefined, false]);
      const on = composeEffectiveEnvelope(withFollowup({ enabled: false }), { followup: { enabled: true } });
      expect(on.operations?.map((step) => step.enabled)).toEqual([undefined, true]);
    });

    it("leaves a step with no overrides as the same object", () => {
      const ai = withFollowup();
      const effective = composeEffectiveEnvelope(ai, { followup: { enabled: false } });
      expect(effective.operations?.[0]).toBe(ai.operations?.[0]);
    });
  });
});
