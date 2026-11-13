import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { withTransaction } from "../db/pool.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors.js";
import { publishProjectAgentInvalidation } from "../projectAgent/projectAgentInvalidation.js";
import { publishSempThreadInvalidation } from "../realtimeHook.js";
import { findTickThread } from "../semp/sempTickThreadStore.js";
import { CORE_AGENT_RUN_ACTION_ID } from "./actions.js";
import type { HeartbeatAgentToolResult } from "./heartbeatAgentTools.js";
import {
  findHeartbeatInScope,
  findLiveProject,
  requireProjectInRunScope,
  resolveHeartbeatReadScope,
  type HeartbeatReadScope,
} from "./heartbeatRunScope.js";
import { parseHeartbeatRule, type HeartbeatRuleKindRegistry } from "./rule.js";
import {
  HEARTBEAT_NAME_MAX_LENGTH,
  HEARTBEAT_TASK_MAX_LENGTH,
  createHeartbeat,
  lockHeartbeatForManualFire,
  setHeartbeatEnabled,
  updateHeartbeatName,
  updateHeartbeatRule,
  updateHeartbeatTask,
  type HeartbeatRow,
} from "./schedulerStore.js";

/*
 * The approval-gated write tools of the heartbeat (automation) setup (issue #1846). The manifest of
 * `schemaCore` declares them with `requiresApproval`, so an agent session never runs these handlers:
 * a call becomes a `moduleTool` approval request and the handler runs once, after a person approved it
 * (`docs/adr/2026-11-12-module-agent-tools-that-require-approval-run-through-a-moduletool-request.md`).
 * Each tool also has a snapshot export; the request stores the hash of what it returns and the
 * executor compares it again before the handler runs.
 */

const heartbeatNameSchema = z.string().trim().min(1).max(HEARTBEAT_NAME_MAX_LENGTH);
const heartbeatTaskSchema = z.string().trim().min(1).max(HEARTBEAT_TASK_MAX_LENGTH);

/**
 * The rule is validated against the core kinds and the kinds of the active modules by `parseHeartbeatRule`
 * (the module kinds are known only at run time), so the schema the model reads describes the core kinds
 * and accepts any object with a `kind`.
 */
const heartbeatRuleArgSchema = z
  .looseObject({ kind: z.string().min(1) })
  .describe(
    'The schedule of the automation, one of {"kind":"dailyTime","at":"HH:MM"}, ' +
      '{"kind":"weekly","days":["mon","tue","wed","thu","fri","sat","sun"],"at":"HH:MM"}, ' +
      '{"kind":"everyNDays","n":2,"at":"HH:MM"}, {"kind":"interval","minutes":60}, ' +
      '{"kind":"onItemEvent","databaseId":"<database id>","event":"create"|"update"|"delete"} ' +
      "or the rule kind of an active module.",
  );

export const heartbeatCreateArgsSchema = z
  .object({
    projectItemId: z.string().uuid(),
    name: heartbeatNameSchema,
    rule: heartbeatRuleArgSchema,
    task: heartbeatTaskSchema,
  })
  .strict();
export type HeartbeatCreateArgs = z.infer<typeof heartbeatCreateArgsSchema>;

export const heartbeatUpdateArgsSchema = z
  .object({
    heartbeatId: z.string().uuid(),
    name: heartbeatNameSchema.optional(),
    rule: heartbeatRuleArgSchema.optional(),
    task: heartbeatTaskSchema.optional(),
  })
  .strict()
  .refine((args) => args.name !== undefined || args.rule !== undefined || args.task !== undefined, {
    message: "Give at least one of name, rule and task",
  });
export type HeartbeatUpdateArgs = z.infer<typeof heartbeatUpdateArgsSchema>;

export const heartbeatSetEnabledArgsSchema = z
  .object({ heartbeatId: z.string().uuid(), enabled: z.boolean() })
  .strict();
export type HeartbeatSetEnabledArgs = z.infer<typeof heartbeatSetEnabledArgsSchema>;

export type HeartbeatCreateTool = (currentRunId: string, args: unknown) => Promise<HeartbeatAgentToolResult>;
export type HeartbeatUpdateTool = (currentRunId: string, args: unknown) => Promise<HeartbeatAgentToolResult>;
export type HeartbeatSetEnabledTool = (currentRunId: string, args: unknown) => Promise<HeartbeatAgentToolResult>;

const SYSTEM_HEARTBEAT_MESSAGE = "A system automation cannot be changed";

/** Throws `ValidationError` for a rule `parseHeartbeatRule` rejects (an unknown kind, a malformed core or module rule). */
function requireValidRule(rule: unknown, moduleRuleKinds: HeartbeatRuleKindRegistry): void {
  try {
    parseHeartbeatRule(rule, moduleRuleKinds);
  } catch (err) {
    // `parseHeartbeatRule` is a pure validator whose every throw is a rejection of the rule.
    throw new ValidationError(`Invalid rule: ${err instanceof Error ? err.message : "rejected"}`, { field: "rule" });
  }
}

async function requireProject(client: PoolClient, projectItemId: string): Promise<void> {
  if (!(await findLiveProject(client, projectItemId))) throw new NotFoundError(`Project ${projectItemId} not found`);
}

/** The heartbeat of the tool call as the run may change it: inside the run's scope and a user automation. */
function requireChangeable(heartbeat: HeartbeatRow | null, heartbeatId: string): HeartbeatRow {
  if (!heartbeat) throw new NotFoundError(`Heartbeat ${heartbeatId} not found`);
  if (heartbeat.origin !== "user") throw new ForbiddenError(SYSTEM_HEARTBEAT_MESSAGE, undefined, "owner_violation");
  return heartbeat;
}

/**
 * Reads the heartbeat `FOR UPDATE` and re-reads it inside `readScope`, in the caller's transaction, so the
 * write that follows acts on the row as it is now and a concurrent change waits for it.
 */
async function lockChangeableHeartbeat(
  client: PoolClient,
  readScope: HeartbeatReadScope,
  heartbeatId: string,
  moduleRuleKinds: HeartbeatRuleKindRegistry,
): Promise<HeartbeatRow> {
  const locked = await lockHeartbeatForManualFire(client, heartbeatId, null, moduleRuleKinds);
  const inScope = locked ? await findHeartbeatInScope(client, readScope, heartbeatId, moduleRuleKinds) : null;
  return requireChangeable(inScope, heartbeatId);
}

/**
 * Runs one write and turns a refusal it raises (unknown or out-of-scope id, a system automation, a rejected
 * value) into the tool's error result, with nothing written because the write was one transaction. Any other
 * error is not a refusal this tool knows and propagates.
 */
async function runWrite(write: () => Promise<HeartbeatAgentToolResult>): Promise<HeartbeatAgentToolResult> {
  try {
    return await write();
  } catch (err) {
    if (err instanceof NotFoundError || err instanceof ForbiddenError || err instanceof ValidationError) {
      return { error: true, result: err.message };
    }
    throw err;
  }
}

/**
 * Announces a changed tick thread. A heartbeat gets its tick thread when it first runs, so a heartbeat that
 * never ran has none and nothing is announced.
 */
async function announceTickThread(client: PoolClient, heartbeatId: string): Promise<void> {
  const thread = await findTickThread(client, heartbeatId);
  if (thread) publishSempThreadInvalidation(client, thread.tenantId, thread.id);
}

function changed(heartbeatId: string): HeartbeatAgentToolResult {
  return { error: false, result: JSON.stringify({ heartbeatId }) };
}

/**
 * `heartbeat.create({projectItemId, name, rule, task})` (issue #1846): creates an automation, a heartbeat
 * with the action `core.agentRun`, the task as its `action_config.task` and the origin `user`. The run's
 * scope decides the project (`resolveHeartbeatReadScope`, `requireProjectInRunScope`): a Semp chat run may
 * create one in any project of its tenant that the sensitive-grant exclusion leaves visible to it, any other
 * run only in its own project; a project outside that scope, an item that is not a project and a project of
 * another tenant all answer `Project <id> not found`. The rule is checked by
 * `parseHeartbeatRule` with the active module kinds. The check of the project and the insert share one
 * transaction; the `projectAgent` invalidation is announced once it has committed.
 */
export function createHeartbeatCreateTool(
  pool: Pool,
  moduleRuleKinds: HeartbeatRuleKindRegistry = new Map(),
): HeartbeatCreateTool {
  return async function heartbeatCreate(currentRunId, rawArgs) {
    const parsedArgs = heartbeatCreateArgsSchema.safeParse(rawArgs);
    if (!parsedArgs.success) return { error: true, result: `Invalid arguments: ${parsedArgs.error.message}` };
    const args = parsedArgs.data;
    const readScope = await resolveHeartbeatReadScope(pool, currentRunId);
    if (!readScope) return { error: true, result: `No project context for run ${currentRunId}` };

    return runWrite(() =>
      withTransaction(pool, async (client) => {
        await requireProjectInRunScope(client, readScope, args.projectItemId);
        requireValidRule(args.rule, moduleRuleKinds);
        await requireProject(client, args.projectItemId);
        const heartbeat = await createHeartbeat(
          client,
          {
            projectItemId: args.projectItemId,
            name: args.name,
            rule: args.rule,
            actionId: CORE_AGENT_RUN_ACTION_ID,
            actionConfig: { task: args.task },
            origin: "user",
          },
          moduleRuleKinds,
        );
        return changed(heartbeat.id);
      }),
    );
  };
}

/**
 * `heartbeat.update({heartbeatId, name?, rule?, task?})` (issue #1846): changes the given fields of a user
 * automation in one transaction, with the heartbeat row locked. The automation must be inside the run's scope
 * (the one `heartbeat.list` reads) and have the origin `user`: a system automation, an unknown id and one
 * outside the scope return a tool error and write nothing. A new rule is checked by `parseHeartbeatRule`
 * with the active module kinds. After the commit the project's agent setup is announced (`projectAgent`;
 * the rule write announces it itself, the name and task writes do not) and the heartbeat's tick thread, when
 * it has one, is announced as changed (`sempThread`), so its header and the thread list show the new name.
 */
export function createHeartbeatUpdateTool(
  pool: Pool,
  moduleRuleKinds: HeartbeatRuleKindRegistry = new Map(),
): HeartbeatUpdateTool {
  return async function heartbeatUpdate(currentRunId, rawArgs) {
    const parsedArgs = heartbeatUpdateArgsSchema.safeParse(rawArgs);
    if (!parsedArgs.success) return { error: true, result: `Invalid arguments: ${parsedArgs.error.message}` };
    const args = parsedArgs.data;
    const readScope = await resolveHeartbeatReadScope(pool, currentRunId);
    if (!readScope) return { error: true, result: `No project context for run ${currentRunId}` };

    return runWrite(async () => {
      if (args.rule !== undefined) requireValidRule(args.rule, moduleRuleKinds);
      return withTransaction(pool, async (client) => {
        const heartbeat = await lockChangeableHeartbeat(client, readScope, args.heartbeatId, moduleRuleKinds);
        if (args.name !== undefined) await updateHeartbeatName(client, heartbeat.id, args.name, moduleRuleKinds);
        if (args.task !== undefined) await updateHeartbeatTask(client, heartbeat.id, args.task, moduleRuleKinds);
        if (args.rule !== undefined) await updateHeartbeatRule(client, heartbeat.id, args.rule, moduleRuleKinds);
        else publishProjectAgentInvalidation(client, heartbeat.projectItemId);
        await announceTickThread(client, heartbeat.id);
        return changed(heartbeat.id);
      });
    });
  };
}

/**
 * `heartbeat.setEnabled({heartbeatId, enabled})` (issue #1846): switches a user automation on or off, under
 * the same scope and origin rules as `heartbeat.update`. Switching on needs the rule to parse with the active
 * module kinds, as `setHeartbeatEnabled` computes the next fire time from it; a rule whose module is inactive
 * is a tool error and the automation stays as it was. Switching off never depends on the rule.
 */
export function createHeartbeatSetEnabledTool(
  pool: Pool,
  moduleRuleKinds: HeartbeatRuleKindRegistry = new Map(),
): HeartbeatSetEnabledTool {
  return async function heartbeatSetEnabled(currentRunId, rawArgs) {
    const parsedArgs = heartbeatSetEnabledArgsSchema.safeParse(rawArgs);
    if (!parsedArgs.success) return { error: true, result: `Invalid arguments: ${parsedArgs.error.message}` };
    const args = parsedArgs.data;
    const readScope = await resolveHeartbeatReadScope(pool, currentRunId);
    if (!readScope) return { error: true, result: `No project context for run ${currentRunId}` };

    return runWrite(() =>
      withTransaction(pool, async (client) => {
        const heartbeat = await lockChangeableHeartbeat(client, readScope, args.heartbeatId, moduleRuleKinds);
        if (args.enabled) requireValidRule(heartbeat.rule, moduleRuleKinds);
        await setHeartbeatEnabled(client, heartbeat.id, args.enabled, moduleRuleKinds);
        await announceTickThread(client, heartbeat.id);
        return changed(heartbeat.id);
      }),
    );
  };
}

/** What a snapshot reads of an automation: the fields a person approves a change against. `null` for a heartbeat the run cannot reach. */
interface HeartbeatChangeSnapshot {
  name: string;
  rule: unknown;
  actionConfig: Record<string, unknown>;
  enabled: boolean;
}

async function readChangeSnapshot(
  pool: Pool,
  moduleRuleKinds: HeartbeatRuleKindRegistry,
  runId: string,
  heartbeatId: string,
): Promise<HeartbeatChangeSnapshot | null> {
  const readScope = await resolveHeartbeatReadScope(pool, runId);
  if (!readScope) throw new ValidationError(`No project context for run ${runId}`);
  const heartbeat = await findHeartbeatInScope(pool, readScope, heartbeatId, moduleRuleKinds);
  if (!heartbeat) return null;
  requireChangeable(heartbeat, heartbeatId);
  return {
    name: heartbeat.name,
    rule: heartbeat.rule,
    actionConfig: heartbeat.actionConfig,
    enabled: heartbeat.enabled,
  };
}

/**
 * The snapshot of `heartbeat.update` (issue #1846): the automation's `name`, `rule`, `action_config` and
 * `enabled`, or `null` when it is unknown to the run (a missing source is a value, so an automation deleted
 * after the request is a conflict). It refuses, which creates no request, a system automation and a rule that
 * `parseHeartbeatRule` rejects.
 */
export function createHeartbeatUpdateSnapshot(pool: Pool, moduleRuleKinds: HeartbeatRuleKindRegistry = new Map()) {
  return async (runId: string, rawArgs: unknown): Promise<HeartbeatChangeSnapshot | null> => {
    const args = heartbeatUpdateArgsSchema.parse(rawArgs);
    if (args.rule !== undefined) requireValidRule(args.rule, moduleRuleKinds);
    return readChangeSnapshot(pool, moduleRuleKinds, runId, args.heartbeatId);
  };
}

/** The snapshot of `heartbeat.setEnabled`: the same fields as `createHeartbeatUpdateSnapshot`, and it refuses a system automation. */
export function createHeartbeatSetEnabledSnapshot(pool: Pool, moduleRuleKinds: HeartbeatRuleKindRegistry = new Map()) {
  return async (runId: string, rawArgs: unknown): Promise<HeartbeatChangeSnapshot | null> => {
    const args = heartbeatSetEnabledArgsSchema.parse(rawArgs);
    return readChangeSnapshot(pool, moduleRuleKinds, runId, args.heartbeatId);
  };
}

/**
 * The snapshot of `heartbeat.create` (issue #1846): there is no automation to compare, so the source is the
 * project it is created in, `{projectItemId, exists}`; a project removed after the request is a conflict.
 * It refuses, which creates no request, a project outside the run's scope (including, for a chat run, one the
 * sensitive-grant exclusion leaves out) and a rule that `parseHeartbeatRule` rejects.
 */
export function createHeartbeatCreateSnapshot(pool: Pool, moduleRuleKinds: HeartbeatRuleKindRegistry = new Map()) {
  return async (runId: string, rawArgs: unknown): Promise<{ projectItemId: string; exists: boolean }> => {
    const args = heartbeatCreateArgsSchema.parse(rawArgs);
    const readScope = await resolveHeartbeatReadScope(pool, runId);
    if (!readScope) throw new ValidationError(`No project context for run ${runId}`);
    requireValidRule(args.rule, moduleRuleKinds);
    return withTransaction(pool, async (client) => {
      await requireProjectInRunScope(client, readScope, args.projectItemId);
      const exists = (await findLiveProject(client, args.projectItemId)) !== null;
      return { projectItemId: args.projectItemId, exists };
    });
  };
}
