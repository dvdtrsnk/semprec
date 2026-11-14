import { describe, expect, it } from "vitest";
import { z } from "zod";
import { loadFullModuleRegistry } from "../../manifest/fullModuleRegistry.js";
import {
  createMailDraftCreateTool,
  createMailDraftSendTool,
  createMailDraftUpdateTool,
  createMailThreadGetTool,
  createMailThreadProposeTaskTool,
  mailDraftCreateArgsSchema,
  mailDraftSendArgsSchema,
  mailDraftUpdateArgsSchema,
  mailThreadGetArgsSchema,
  mailThreadProposeTaskArgsSchema,
} from "../mailAgentTools.js";

const MAIL_TOOLS = [
  "mail.thread.get",
  "mail.draft.create",
  "mail.draft.update",
  "mail.draft.send",
  "mail.thread.proposeTask",
];

describe("the agent tools of the mail module manifest (issues gh-1927, gh-1949, gh-2035)", () => {
  it("declares the capabilities mail.read, mail.draft, mail.send and mail.taskProposal over the four mail databases", async () => {
    const registry = await loadFullModuleRegistry();

    expect((await registry.getModuleCapabilityDeclarations()).find((entry) => entry.moduleId === "mailSync")).toEqual({
      moduleId: "mailSync",
      capabilities: ["mail.read", "mail.draft", "mail.send", "mail.taskProposal"],
      databaseKeys: ["mailboxes", "threads", "folders", "emails"],
    });
  });

  it("offers a tool only to a context that holds its capability", async () => {
    const registry = await loadFullModuleRegistry();
    const mailTools = async (granted: string[]) =>
      (await registry.getAgentTools(new Set(granted)))
        .filter((tool) => tool.moduleId === "mailSync")
        .map((tool) => [tool.name, tool.handlerExport]);

    expect(await mailTools([])).toEqual([]);
    expect(await mailTools(["mail.read"])).toEqual([["mail.thread.get", "createMailThreadGetTool"]]);
    expect(await mailTools(["mail.draft"])).toEqual([
      ["mail.draft.create", "createMailDraftCreateTool"],
      ["mail.draft.update", "createMailDraftUpdateTool"],
    ]);
    expect(await mailTools(["mail.send"])).toEqual([["mail.draft.send", "createMailDraftSendTool"]]);
    expect(await mailTools(["mail.taskProposal"])).toEqual([
      ["mail.thread.proposeTask", "createMailThreadProposeTaskTool"],
    ]);
    expect(await mailTools(["mail.read", "mail.draft"])).toHaveLength(3);
    expect(
      (await mailTools(["mail.read", "mail.draft", "mail.send", "mail.taskProposal"])).map(([name]) => name),
    ).toEqual(MAIL_TOOLS);
  });

  it("resolves the five tools to their exported handler factories and strict schemas, none of them deferred by the session", async () => {
    const registry = await loadFullModuleRegistry();

    const definitions = (
      await registry.getAgentToolDefinitions(new Set(["mail.read", "mail.draft", "mail.send", "mail.taskProposal"]))
    ).filter((tool) => tool.moduleId === "mailSync");

    expect(definitions.map((tool) => [tool.name, tool.handler, tool.riskClass, tool.requiresApproval])).toEqual([
      ["mail.thread.get", createMailThreadGetTool, "read", undefined],
      ["mail.draft.create", createMailDraftCreateTool, "write", undefined],
      ["mail.draft.update", createMailDraftUpdateTool, "write", undefined],
      // The send tool files the request of its own kind itself (docs/adr/2026-11-14-the-mail-send-tool-is-declared-...).
      ["mail.draft.send", createMailDraftSendTool, undefined, undefined],
      // It writes a card and no task, so it declares no approval (docs/adr/2026-10-28-module-agent-tools-approval-and-grants.md).
      ["mail.thread.proposeTask", createMailThreadProposeTaskTool, "write", undefined],
    ]);
    expect(definitions.map((tool) => tool.argumentSchema)).toEqual([
      z.toJSONSchema(mailThreadGetArgsSchema),
      z.toJSONSchema(mailDraftCreateArgsSchema),
      z.toJSONSchema(mailDraftUpdateArgsSchema),
      z.toJSONSchema(mailDraftSendArgsSchema),
      z.toJSONSchema(mailThreadProposeTaskArgsSchema),
    ]);
    expect(definitions.every((tool) => tool.argumentSchema.additionalProperties === false)).toBe(true);
  });

  it("tells the model to suggest a task with mail.thread.proposeTask and not to create thread tasks itself, and takes no due date", () => {
    const schema = z.toJSONSchema(mailThreadProposeTaskArgsSchema);

    expect(schema.description).toMatch(/suggest a task from a mail thread/i);
    expect(schema.description).toMatch(/do not create tasks of a thread yourself/i);
    expect(Object.keys(schema.properties ?? {})).toEqual(["threadId", "name"]);
    expect(schema.required).toEqual(["threadId", "name"]);
  });
});
