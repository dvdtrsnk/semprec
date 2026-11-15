import { describe, expect, it } from "vitest";
import type { ProposalEnvelope } from "../proposalEnvelope.js";
import { carryNewOptions } from "../proposalNewOptions.js";

// Issue gh-1994: the new options a revise carries over from the previous assistant envelope.

const TARGET = "8f6f2d3e-8b1e-4a0e-9d0b-1c1f0f1a2b3c";
const HERBS = { propertyKey: "tags", label: "Bylinky" };
const DENTIST = { propertyKey: "type", label: "Dentist" };

const envelope = (change: Partial<ProposalEnvelope>): ProposalEnvelope => ({
  entityKind: "database",
  target: TARGET,
  properties: { name: "Herbal tea" },
  ...change,
});

describe("carryNewOptions", () => {
  const previous = envelope({
    properties: { name: "Herbal tea", tags: [{ newOption: "Bylinky" }] },
    newOptions: [HERBS],
  });

  it("carries the option that a value of the revision still names", () => {
    const next = envelope({ properties: { name: "Herbal tea today", tags: [{ newOption: "Bylinky" }] } });

    expect(carryNewOptions(previous, next)).toEqual({ ...next, newOptions: [HERBS] });
    expect(next).not.toHaveProperty("newOptions");
  });

  it("matches the label of a value to the option after trimming, for a select value and a multi_select element", () => {
    const two = envelope({
      properties: { name: "Row", tags: ["medication", { newOption: " Bylinky " }], type: { newOption: "Dentist" } },
      newOptions: [HERBS, DENTIST],
    });

    expect(carryNewOptions(two, envelope({ properties: { tags: [{ newOption: "Bylinky" }] } })).newOptions).toEqual([
      HERBS,
    ]);
    expect(carryNewOptions(two, envelope({ properties: { type: { newOption: "Dentist" } } })).newOptions).toEqual([
      DENTIST,
    ]);
  });

  it("carries only the options a value names, and no field when none is named", () => {
    expect(carryNewOptions(previous, envelope({ properties: { tags: ["medication"] } }))).not.toHaveProperty(
      "newOptions",
    );
    expect(carryNewOptions(previous, envelope({ properties: { type: { newOption: "Bylinky" } } }))).not.toHaveProperty(
      "newOptions",
    );
  });

  it("leaves the options a revision brings of its own", () => {
    const own = [DENTIST];

    expect(
      carryNewOptions(previous, envelope({ properties: { type: { newOption: "Dentist" } }, newOptions: own }))
        .newOptions,
    ).toEqual(own);
  });

  it("carries nothing to another database, another kind or a multi-step revision", () => {
    const named = { name: "Row", tags: [{ newOption: "Bylinky" }] };
    const other = "11111111-2222-4333-8444-555555555555";

    expect(carryNewOptions(previous, envelope({ properties: named, target: other }))).not.toHaveProperty("newOptions");
    expect(carryNewOptions(previous, envelope({ properties: named, entityKind: "pageContent" }))).not.toHaveProperty(
      "newOptions",
    );
    expect(
      carryNewOptions(
        previous,
        envelope({ properties: named, operations: [{ ref: "a", op: "create", role: "primary" }] }),
      ),
    ).not.toHaveProperty("newOptions");
  });

  it("carries nothing from a previous envelope that lists none, is of another kind, or is missing or malformed", () => {
    const next = envelope({ properties: { name: "Row", tags: [{ newOption: "Bylinky" }] } });

    expect(carryNewOptions(envelope({}), next)).not.toHaveProperty("newOptions");
    expect(carryNewOptions({ ...previous, entityKind: "pageContent" }, next)).not.toHaveProperty("newOptions");
    expect(
      carryNewOptions({ ...previous, operations: [{ ref: "a", op: "create", role: "primary" }] }, next),
    ).not.toHaveProperty("newOptions");
    expect(carryNewOptions(null, next)).not.toHaveProperty("newOptions");
    expect(carryNewOptions({ entityKind: "database" }, next)).not.toHaveProperty("newOptions");
  });
});
