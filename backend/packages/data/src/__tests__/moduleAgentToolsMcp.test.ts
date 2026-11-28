import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ModuleRegistry } from "@alldots/module-registry";
import { resolveModuleAgentToolsForUser } from "../agentTools/moduleAgentTools.js";
import { ValidationError } from "../errors.js";
import { getTestPool } from "../testSupport/testDb.js";

function fixture(name: string): string {
  return new URL(`../../../module-registry/src/__tests__/fixtures/${name}`, import.meta.url).href;
}

let pool: Pool;

async function registryOf(file: string, active: string[]): Promise<ModuleRegistry> {
  const registry = new ModuleRegistry(() => new Set(active));
  await registry.loadModule(fixture(file));
  return registry;
}

describe("resolveModuleAgentToolsForUser (issue gh-1956)", () => {
  beforeAll(() => {
    pool = getTestPool();
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("offers the tools of an active module that declare mcp, and no other, with their argument schemas", async () => {
    const registry = await registryOf("mcpToolsModule.js", ["mcpTools"]);

    const tools = await resolveModuleAgentToolsForUser(pool, registry, randomUUID(), {});

    expect(tools.map((tool) => tool.name)).toEqual(["mcpTools.exposed", "mcpTools.badResult", "mcpTools.gatedExposed"]);
    expect(tools[0]?.argumentSchema).toMatchObject({ type: "object", additionalProperties: false });
  });

  it("offers a gated tool that declares mcp as a tool that carries no approval flag, and runs it as the user (issue gh-1957)", async () => {
    const registry = await registryOf("mcpToolsModule.js", ["mcpTools"]);
    const userId = randomUUID();
    const names = (await resolveModuleAgentToolsForUser(pool, registry, userId, {})).map((tool) => tool.name);
    const tool = (await resolveModuleAgentToolsForUser(pool, registry, userId, {})).find(
      (candidate) => candidate.name === "mcpTools.gatedExposed",
    );
    if (!tool) throw new Error("Missing mcpTools.gatedExposed");

    expect(names).not.toContain("mcpTools.gatedSessionOnly");
    expect(tool).not.toHaveProperty("requiresApproval");
    expect(JSON.parse((await tool.invoke({ value: "x" })).result)).toMatchObject({ userId, args: { value: "x" } });
  });

  it("offers nothing of a module that is not active", async () => {
    const registry = await registryOf("mcpToolsModule.js", []);

    expect(await resolveModuleAgentToolsForUser(pool, registry, randomUUID(), {})).toEqual([]);
  });

  it("runs the handler as the session's user with the parsed arguments, and builds it with the dependencies it was given", async () => {
    const registry = await registryOf("mcpToolsModule.js", ["mcpTools"]);
    const userId = randomUUID();
    const dependencies = { marker: randomUUID() };
    const tool = (await resolveModuleAgentToolsForUser(pool, registry, userId, dependencies)).find(
      (candidate) => candidate.name === "mcpTools.exposed",
    );
    if (!tool) throw new Error("Missing mcpTools.exposed");

    const answer = await tool.invoke({ value: "x" });

    expect(answer.error).toBe(false);
    expect(JSON.parse(answer.result)).toEqual({ userId, args: { value: "x" }, dependencies });
  });

  it("refuses arguments the schema does not accept before the handler runs", async () => {
    const registry = await registryOf("mcpToolsModule.js", ["mcpTools"]);
    const tool = (await resolveModuleAgentToolsForUser(pool, registry, randomUUID(), {})).find(
      (candidate) => candidate.name === "mcpTools.exposed",
    );
    if (!tool) throw new Error("Missing mcpTools.exposed");

    await expect(tool.invoke({ value: 1 })).rejects.toBeInstanceOf(ValidationError);
    await expect(tool.invoke({ extra: true })).rejects.toBeInstanceOf(ValidationError);
  });

  it("fails a call whose handler answers without the shape every handler promises", async () => {
    const registry = await registryOf("mcpToolsModule.js", ["mcpTools"]);
    const tool = (await resolveModuleAgentToolsForUser(pool, registry, randomUUID(), {})).find(
      (candidate) => candidate.name === "mcpTools.badResult",
    );
    if (!tool) throw new Error("Missing mcpTools.badResult");

    await expect(tool.invoke({})).rejects.toThrow("Invalid module tool result");
  });

  it("fails the resolution of a module whose human handler factory does not return a handler", async () => {
    const registry = await registryOf("mcpBadFactoryModule.js", ["mcpBadFactory"]);

    await expect(resolveModuleAgentToolsForUser(pool, registry, randomUUID(), {})).rejects.toThrow(
      "Invalid module tool human handler factory: mcpBadFactory.tool",
    );
  });
});
