// Builds the snapshotted description of an approval request for a heartbeat write tool (issue #1846).
// The description is the whole of what the person sees of the call, because a `moduleTool` request exposes
// no argument values, so it names the automation, its project and what will be written: the new name, the new
// rule in the form that will be stored, and the task, which is the instruction every tick runs with the
// project's grants. The task is cut to a fixed length with a marker (the description is a stored snapshot and
// goes into the notification body); the name, the rule and the task are shown as JSON strings, so a value
// cannot pose as part of the sentence around it. The decision is in
// docs/adr/2026-11-13-a-heartbeat-write-tool-approval-shows-what-it-will-write.md.
// Templates and params (the catalogs are `seed/i18n/{cs,en}.json` and `notifications/i18n/{cs,en}.json`):
//   approval.heartbeatCreate      {heartbeatName, projectName, rule, task}   (`rule` is the JSON of the rule as stored, `task` the JSON string of the cut task)
//   approval.heartbeatUpdate      {heartbeatName, projectName, changes}   (`changes` lists the changed fields in the tenant user's language, each with its new value: "name: ...; schedule: ...; task: ...")
//   approval.heartbeatSetEnabled  {heartbeatName, projectName, state}   (`state` is the word for on or off, in the tenant user's language)
// For `update` and `setEnabled` `heartbeatName` is the current name of the automation.
import { loadModuleCatalogs, resolveCatalogLabel } from "@semprec/module-registry";
import type { PoolClient } from "pg";
import { getTenantUserLocale } from "../auth/usersStore.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { toManifestLocale } from "../manifest/catalogResolution.js";
import type { ApprovalDescription } from "../mcp/approvalRequestsStore.js";
import {
  heartbeatCreateArgsSchema,
  heartbeatSetEnabledArgsSchema,
  heartbeatUpdateArgsSchema,
} from "./heartbeatWriteAgentTools.js";
import {
  findHeartbeatInScope,
  findLiveProject,
  requireProjectInRunScope,
  resolveHeartbeatReadScope,
} from "./heartbeatRunScope.js";
import { isCoreHeartbeatRuleKind, parseHeartbeatRule, type HeartbeatRuleKindRegistry } from "./rule.js";

/** The description reads only names, which a rule of an inactive module kind does not hide. */
const NO_RULE_KINDS: HeartbeatRuleKindRegistry = new Map();

/** The length, in characters, at which the task shown to the person is cut. */
export const APPROVAL_TASK_EXCERPT_LENGTH = 500;
/** The length, in characters, at which the rule shown to the person is cut. */
export const APPROVAL_RULE_MAX_LENGTH = 300;
const CUT_MARKER = "…";

/** `text` cut to `max` characters (code points) with a marker when it was longer. */
function cut(text: string, max: number): string {
  const characters = Array.from(text);
  return characters.length <= max ? text : `${characters.slice(0, max).join("")}${CUT_MARKER}`;
}

/** The task as the person sees it: a JSON string of the task cut to `APPROVAL_TASK_EXCERPT_LENGTH`. */
function shownTask(task: string): string {
  return JSON.stringify(cut(task, APPROVAL_TASK_EXCERPT_LENGTH));
}

/**
 * The rule as it will be stored: the JSON of `parseHeartbeatRule`'s result, which drops what a core kind does not
 * declare, cut to `APPROVAL_RULE_MAX_LENGTH`. The module rule kinds of the run are not known here, so a rule of a
 * module kind shows its `kind` alone, never the model's other keys. A rule of a core kind that does not parse is
 * refused, as the tool would refuse it.
 */
function shownRule(rule: { kind: string }): string {
  let shown: unknown;
  try {
    shown = parseHeartbeatRule(rule, NO_RULE_KINDS);
  } catch (err) {
    if (isCoreHeartbeatRuleKind(rule.kind)) {
      // `parseHeartbeatRule` is a pure validator whose every throw is a rejection of the rule.
      throw new ValidationError(`Invalid rule: ${err instanceof Error ? err.message : "rejected"}`, { field: "rule" });
    }
    shown = { kind: rule.kind };
  }
  return cut(JSON.stringify(shown), APPROVAL_RULE_MAX_LENGTH);
}

function nameOf(project: { properties: Record<string, unknown> } | null): string | null {
  return typeof project?.properties.name === "string" ? project.properties.name : null;
}

/** The heartbeat the run may change, as `findHeartbeatInScope` reads it; an unknown or out-of-scope id is `NotFoundError`. */
async function heartbeatOfRun(client: PoolClient, agentRunId: string, heartbeatId: string) {
  const readScope = await resolveHeartbeatReadScope(client, agentRunId);
  if (!readScope) throw new ValidationError(`No project context for run ${agentRunId}`);
  const heartbeat = await findHeartbeatInScope(client, readScope, heartbeatId, NO_RULE_KINDS);
  if (!heartbeat) throw new NotFoundError(`Heartbeat ${heartbeatId} not found`);
  return heartbeat;
}

async function loadLabels(client: PoolClient): Promise<(key: string) => string> {
  const locale = toManifestLocale((await getTenantUserLocale(client)) ?? "cs");
  const catalogs = await loadModuleCatalogs(new URL("../seed/systemDatabasesModuleManifest.js", import.meta.url).href);
  return (key) => resolveCatalogLabel(null, catalogs[locale], catalogs.en, key);
}

/**
 * The description for a call of `heartbeat.create`, `heartbeat.update` or `heartbeat.setEnabled`, read on
 * the transaction client that inserts the request; `null` for any other tool. It refuses, so that no request
 * is created, an automation the run cannot reach and a project the run may not create in: a missing or trashed
 * project, one outside the run's scope, and for a chat run one its sensitive-grant exclusion leaves out
 * (`requireProjectInRunScope`). `args` are the arguments the tool's schema accepted when the call was made.
 */
export async function buildHeartbeatToolApprovalDescription(
  client: PoolClient,
  input: { agentRunId: string; toolName: string; args: Record<string, unknown> },
): Promise<ApprovalDescription | null> {
  switch (input.toolName) {
    case "heartbeat.create": {
      const args = heartbeatCreateArgsSchema.parse(input.args);
      const readScope = await resolveHeartbeatReadScope(client, input.agentRunId);
      if (!readScope) throw new ValidationError(`No project context for run ${input.agentRunId}`);
      await requireProjectInRunScope(client, readScope, args.projectItemId);
      const project = await findLiveProject(client, args.projectItemId);
      if (!project) throw new NotFoundError(`Project ${args.projectItemId} not found`);
      return {
        key: "approval.heartbeatCreate",
        params: {
          heartbeatName: args.name,
          projectName: nameOf(project),
          rule: shownRule(args.rule),
          task: shownTask(args.task),
        },
      };
    }
    case "heartbeat.update": {
      const args = heartbeatUpdateArgsSchema.parse(input.args);
      const heartbeat = await heartbeatOfRun(client, input.agentRunId, args.heartbeatId);
      const label = await loadLabels(client);
      const changes = [
        args.name === undefined ? null : `${label("approval.heartbeatChange.name")}: ${JSON.stringify(args.name)}`,
        args.rule === undefined ? null : `${label("approval.heartbeatChange.rule")}: ${shownRule(args.rule)}`,
        args.task === undefined ? null : `${label("approval.heartbeatChange.task")}: ${shownTask(args.task)}`,
      ].filter((change) => change !== null);
      return {
        key: "approval.heartbeatUpdate",
        params: {
          heartbeatName: heartbeat.name,
          projectName: nameOf(await findLiveProject(client, heartbeat.projectItemId)),
          changes: changes.join("; "),
        },
      };
    }
    case "heartbeat.setEnabled": {
      const args = heartbeatSetEnabledArgsSchema.parse(input.args);
      const heartbeat = await heartbeatOfRun(client, input.agentRunId, args.heartbeatId);
      const label = await loadLabels(client);
      return {
        key: "approval.heartbeatSetEnabled",
        params: {
          heartbeatName: heartbeat.name,
          projectName: nameOf(await findLiveProject(client, heartbeat.projectItemId)),
          state: label(args.enabled ? "approval.heartbeatState.on" : "approval.heartbeatState.off"),
        },
      };
    }
    default:
      return null;
  }
}
