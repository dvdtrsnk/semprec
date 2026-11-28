// The snapshotted description of an approval request for a heartbeat write tool. A `moduleTool` request
// exposes no argument values, so this is all the person sees: the automation, its project, and what will
// be written (name, rule as stored, task). The task is cut with a marker because the snapshot also goes
// into the notification body; values are shown as JSON strings so they cannot pose as part of the sentence.
// Templates (`seed/i18n/{cs,en}.json`, `notifications/i18n/{cs,en}.json`):
//   approval.heartbeatCreate      {heartbeatName, projectName, rule, task}
//   approval.heartbeatUpdate      {heartbeatName, projectName, changes}   (localized "field: value; ..." list)
//   approval.heartbeatSetEnabled  {heartbeatName, projectName, state}     (localized on/off)
// For `update` and `setEnabled`, `heartbeatName` is the current name.
import { loadModuleCatalogs, resolveCatalogLabel } from "@alldots/module-registry";
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

/** In characters. */
export const APPROVAL_TASK_EXCERPT_LENGTH = 500;
/** In characters. */
export const APPROVAL_RULE_MAX_LENGTH = 300;
const CUT_MARKER = "…";

function cut(text: string, max: number): string {
  const characters = Array.from(text);
  return characters.length <= max ? text : `${characters.slice(0, max).join("")}${CUT_MARKER}`;
}

function shownTask(task: string): string {
  return JSON.stringify(cut(task, APPROVAL_TASK_EXCERPT_LENGTH));
}

/**
 * The JSON of `parseHeartbeatRule`'s result, cut to `APPROVAL_RULE_MAX_LENGTH`. Module rule kinds are
 * unknown here, so such a rule shows its `kind` only, never the model's other keys. An unparseable core
 * rule is refused, as the tool would refuse it.
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

/** An unknown or out-of-scope id is `NotFoundError`. */
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
 * The description for `heartbeat.create`/`update`/`setEnabled`, read on the transaction that inserts the
 * request; `null` for other tools. Refuses (so no request is created) an automation the run cannot reach
 * or a project it may not create in (`requireProjectInRunScope`).
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
