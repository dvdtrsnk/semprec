import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { parseLinkRuleResolver } from "../linkResolver.js";

const client = {} as PoolClient;
const fn = (): number => 1;
const inputs = { edges: [{ databaseKey: "people", relationKey: "companies" }], properties: [] };

describe("parseLinkRuleResolver", () => {
  it("wraps a resolver and passes what it returns on", async () => {
    const valueId = randomUUID();
    const sourceId = randomUUID();
    const resolver = parseLinkRuleResolver("rule", {
      inputs,
      resolve: () =>
        Promise.resolve({
          values: [valueId],
          sources: [
            { kind: "item", sourceItemId: sourceId, sourcePropertyKey: "companies" },
            { kind: "senderDomain", domain: "acme.cz", sourcePropertyKey: "web" },
          ],
        }),
      affectedItemIds: () => Promise.resolve([sourceId]),
    });
    expect(resolver.inputs).toEqual(inputs);
    expect(await resolver.resolve(client, randomUUID())).toEqual({
      values: [valueId],
      sources: [
        { kind: "item", sourceItemId: sourceId, sourcePropertyKey: "companies" },
        { kind: "senderDomain", domain: "acme.cz", sourcePropertyKey: "web" },
      ],
    });
    expect(await resolver.affectedItemIds(client, valueId, null, 10)).toEqual([sourceId]);
  });

  it("calls the resolver's functions with the resolver as `this`", async () => {
    const holder = {
      inputs,
      calls: 0,
      resolve(): Promise<{ values: string[]; sources: never[] }> {
        this.calls++;
        return Promise.resolve({ values: [], sources: [] });
      },
      affectedItemIds(): Promise<string[]> {
        this.calls++;
        return Promise.resolve([]);
      },
    };
    const resolver = parseLinkRuleResolver("rule", holder);
    await resolver.resolve(client, randomUUID());
    await resolver.affectedItemIds(client, randomUUID(), null, 1);
    expect(holder.calls).toBe(2);
  });

  it.each([
    ["inputs", { resolve: fn, affectedItemIds: fn }],
    ["resolve", { inputs, affectedItemIds: fn }],
    ["affectedItemIds", { inputs, resolve: fn }],
    ["a resolve that is not a function", { inputs, resolve: 1, affectedItemIds: fn }],
    ["an affectedItemIds that is not a function", { inputs, resolve: fn, affectedItemIds: "x" }],
  ])("refuses an export without %s", (_name, value) => {
    expect(() => parseLinkRuleResolver("rule", value)).toThrow(/Link rule "rule" resolver must declare/);
  });

  it("refuses inputs of the wrong shape", () => {
    const base = { resolve: fn, affectedItemIds: fn };
    expect(() => parseLinkRuleResolver("rule", { ...base, inputs: { edges: [] } })).toThrow();
    expect(() =>
      parseLinkRuleResolver("rule", { ...base, inputs: { edges: [{ databaseKey: "" }], properties: [] } }),
    ).toThrow();
    expect(() => parseLinkRuleResolver("rule", { ...base, inputs: { ...inputs, extra: 1 } })).toThrow();
    expect(() =>
      parseLinkRuleResolver("rule", {
        ...base,
        inputs: { edges: [], properties: [{ databaseKey: "companies", propertyKey: "web", onAppear: "yes" }] },
      }),
    ).toThrow();
  });

  it("keeps the onAppear flag of a declared property", () => {
    const flagged = { edges: [], properties: [{ databaseKey: "companies", propertyKey: "web", onAppear: true }] };
    const resolver = parseLinkRuleResolver("rule", { inputs: flagged, resolve: fn, affectedItemIds: fn });
    expect(resolver.inputs).toEqual(flagged);
  });

  it("refuses a resolution that is not what the engine writes", async () => {
    const answer = (value: unknown) =>
      parseLinkRuleResolver("rule", {
        inputs,
        resolve: () => Promise.resolve(value),
        affectedItemIds: () => Promise.resolve([]),
      }).resolve(client, randomUUID());
    await expect(answer({ values: ["not-a-uuid"], sources: [] })).rejects.toThrow();
    await expect(
      answer({ values: [], sources: [{ kind: "item", sourceItemId: "x", sourcePropertyKey: "p" }] }),
    ).rejects.toThrow();
    await expect(
      answer({ values: [], sources: [{ kind: "other", domain: "acme.cz", sourcePropertyKey: "p" }] }),
    ).rejects.toThrow();
    await expect(answer({ values: [] })).rejects.toThrow();
    await expect(answer({ values: [], sources: [], extra: 1 })).rejects.toThrow();
  });

  it("refuses a list of affected items that holds anything but ids", async () => {
    const resolver = parseLinkRuleResolver("rule", {
      inputs,
      resolve: () => Promise.resolve({ values: [], sources: [] }),
      affectedItemIds: () => Promise.resolve(["not-a-uuid"]),
    });
    await expect(resolver.affectedItemIds(client, randomUUID(), null, 1)).rejects.toThrow();
  });
});
