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
 * Approval-gated (`requiresApproval`): a call becomes a `moduleTool` request and the handler runs only after a
 * person approves. Each tool's snapshot is hashed with the request and re-checked before the handler runs.
 */

const heartbeatNameSchema = z.string().trim().min(1).max(HEARTBEAT_NAME_MAX_LENGTH);
const heartbeatTaskSchema = z.string().trim().min(1).max(HEARTBEAT_TASK_MAX_LENGTH);

/** Module rule kinds are only known at run time; `parseHeartbeatRule` does the real validation. */
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

/** Inside the run's scope and a user (not system) automation. */
function requireChangeable(heartbeat: HeartbeatRow | null, heartbeatId: string): HeartbeatRow {
  if (!heartbeat) throw new NotFoundError(`Heartbeat ${heartbeatId} not found`);
  if (heartbeat.origin !== "user") throw new ForbiddenError(SYSTEM_HEARTBEAT_MESSAGE, undefined, "owner_violation");
  return heartbeat;
}

/** `FOR UPDATE`, then re-read inside `readScope`, so the write acts on the current row. */
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

/** Known refusals become the tool's error result (nothing written); other errors propagate. */
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

/** A heartbeat gets its tick thread on its first run; one that never ran has nothing to announce. */
async function announceTickThread(client: PoolClient, heartbeatId: string): Promise<void> {
  const thread = await findTickThread(client, heartbeatId);
  if (thread) publishSempThreadInvalidation(client, thread.tenantId, thread.id);
}

function changed(heartbeatId: string): HeartbeatAgentToolResult {
  return { error: false, result: JSON.stringify({ heartbeatId }) };
}

/**
 * `heartbeat.create`: a user `core.agentRun` heartbeat with the task as `action_config.task`, in a project
 * the run's scope reaches (else `Project <id> not found`). Announces `projectAgent` after commit.
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
 * `heartbeat.update`: changes fields of an in-scope user automation under the row lock. Announces
 * `projectAgent` and the tick thread (`sempThread`) after commit.
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

/** Switching on needs the rule to parse (the next fire time comes from it); switching off never does. */
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

/** The fields a person approves a change against. `null` for a heartbeat the run cannot reach. */
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

/** `null` when unknown to the run, so a deletion after the request is a conflict. Refuses system automations. */
export function createHeartbeatUpdateSnapshot(pool: Pool, moduleRuleKinds: HeartbeatRuleKindRegistry = new Map()) {
  return async (runId: string, rawArgs: unknown): Promise<HeartbeatChangeSnapshot | null> => {
    const args = heartbeatUpdateArgsSchema.parse(rawArgs);
    if (args.rule !== undefined) requireValidRule(args.rule, moduleRuleKinds);
    return readChangeSnapshot(pool, moduleRuleKinds, runId, args.heartbeatId);
  };
}

/** Same fields as `createHeartbeatUpdateSnapshot`; refuses a system automation. */
export function createHeartbeatSetEnabledSnapshot(pool: Pool, moduleRuleKinds: HeartbeatRuleKindRegistry = new Map()) {
  return async (runId: string, rawArgs: unknown): Promise<HeartbeatChangeSnapshot | null> => {
    const args = heartbeatSetEnabledArgsSchema.parse(rawArgs);
    return readChangeSnapshot(pool, moduleRuleKinds, runId, args.heartbeatId);
  };
}

/** The source is the target project `{projectItemId, exists}`; refuses out-of-scope projects and bad rules. */
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
