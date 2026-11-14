import type { PoolClient } from "pg";
import { getAgentRunsByIds, type AgentRunRow } from "../agentRuns/agentRunsStore.js";
import { deriveRunDisplayStatus } from "../agentRuns/agentRunDisplayStatus.js";
import { replyOutcomeOfStoredSteps, type ReplyOutcome } from "../agentRuns/replyOutcome.js";
import { requireSingleRow } from "../db/pool.js";
import { projectAgentGuidanceStore } from "../projectAgentGuidanceStore.js";
import { listHeartbeatsByProject, listLastFinishedOccurrenceRuns } from "../scheduler/schedulerStore.js";
import { countEffectiveMcpGrants, listMcpToolGrantsForProject } from "./mcpAgentPageGrants.js";

/**
 * The three signals that make a project's "Semp in this project" row show its attention dot, each as a count
 * (issue gh-1935). `needsAttention` is true when any of the three is greater than zero.
 */
export interface ProjectAgentAttention {
  /** Rows of `agent_guidance_drift_findings` of the project with status `active`. */
  activeDriftFindings: number;
  /** User-origin heartbeats whose last occurrence reads `failed` in `GET /api/projects/:id/heartbeats`. */
  failingHeartbeats: number;
  /** `approval_requests` with status `pending` whose run belongs to the project. */
  pendingApprovals: number;
  needsAttention: boolean;
}

/** What `GET /api/projects/:id/agent-summary` returns (issue gh-1935). */
export interface ProjectAgentSummary {
  /** A guidance record exists and its Markdown is not blank. */
  hasGuidance: boolean;
  /** `updated_at` of the guidance record as an ISO timestamp; `null` when the project has no record. */
  guidanceUpdatedAt: string | null;
  /** `counts.effective` of the project's tool grants: granted, registration active, server active. */
  grantedToolCount: number;
  /** User-origin heartbeats of the project that are enabled; system heartbeats are not counted. */
  enabledHeartbeatCount: number;
  attention: ProjectAgentAttention;
}

/**
 * The runs of `runIds` that have a pending approval request, with the number of requests, in one statement.
 * A run without one is absent.
 */
async function readPendingApprovalCounts(client: PoolClient, runIds: readonly string[]): Promise<Map<string, number>> {
  const { rows } = await client.query<{ agent_run_id: string; pending: number }>(
    `SELECT agent_run_id, count(*)::int AS pending
     FROM approval_requests
     WHERE agent_run_id = ANY($1::uuid[]) AND status = 'pending'
     GROUP BY agent_run_id`,
    [runIds],
  );
  return new Map(rows.map((row) => [row.agent_run_id, row.pending]));
}

/**
 * The reply outcome of every run of `runs` that has a single reply to judge, by run id, in one statement. It is
 * the batched form of `getAgentRunReplyOutcome` (same rule: only a run that closed as `done`, is no MCP run and
 * has a thread, and only when its assistant message in that thread is the one and only), which that function
 * reads with one statement per run.
 */
async function readReplyOutcomes(client: PoolClient, runs: readonly AgentRunRow[]): Promise<Map<string, ReplyOutcome>> {
  const judged = runs.filter((run) => run.status === "done" && run.triggeredBy !== "mcp" && run.threadId !== null);
  if (judged.length === 0) return new Map();
  const { rows } = await client.query<{ agent_run_id: string; thread_id: string; steps: unknown }>(
    `SELECT agent_run_id, thread_id, steps
     FROM semp_messages
     WHERE agent_run_id = ANY($1::uuid[]) AND role = 'assistant'`,
    [judged.map((run) => run.id)],
  );
  const outcomes = new Map<string, ReplyOutcome>();
  for (const run of judged) {
    const replies = rows.filter((row) => row.agent_run_id === run.id && row.thread_id === run.threadId);
    const [reply, other] = replies;
    if (reply !== undefined && other === undefined) outcomes.set(run.id, replyOutcomeOfStoredSteps(reply.steps));
  }
  return outcomes;
}

/**
 * How many of `heartbeatIds` have a last occurrence that reads `failed` on `GET /api/projects/:id/heartbeats`
 * (issue gh-1910): the latest finished run of the latest finished occurrence (`listLastFinishedOccurrenceRuns`)
 * whose display status (`deriveRunDisplayStatus`, with the reply outcome of issue #1890) is `error`. The runs, their
 * pending approvals and their replies are each read in one statement however many heartbeats there are.
 */
async function countFailingHeartbeats(client: PoolClient, heartbeatIds: readonly string[]): Promise<number> {
  const lastRuns = await listLastFinishedOccurrenceRuns(client, heartbeatIds);
  if (lastRuns.length === 0) return 0;
  const runIds = lastRuns.map((last) => last.runId);
  const runs = await getAgentRunsByIds(client, runIds);
  const pending = await readPendingApprovalCounts(client, runIds);
  const replyOutcomes = await readReplyOutcomes(client, runs);
  return runs.filter(
    (run) =>
      deriveRunDisplayStatus(
        { status: run.status, replyOutcome: replyOutcomes.get(run.id)?.outcome ?? null },
        { pending: pending.get(run.id) ?? 0 },
      ) === "error",
  ).length;
}

/**
 * The project's agent setup and what needs a person, for the project detail's "Semp in this project" row
 * (issue gh-1935). Read-only; every source is read in the caller's tenant scope and each in a constant number of
 * statements, whatever the number of tools, heartbeats or runs. It does not check that `projectItemId` is a live
 * project: a caller that needs that (the route handler) checks it first. A project that has nothing reads all zeros.
 *
 * - `hasGuidance` and `guidanceUpdatedAt` come from the guidance record (`projectAgentGuidanceStore.load`).
 * - `grantedToolCount` is `countEffectiveMcpGrants` over `listMcpToolGrantsForProject`, the rule of the grants list.
 *   The locale only picks tool labels, which the count ignores.
 * - `enabledHeartbeatCount` and `failingHeartbeats` count the project's heartbeats of origin `user`; a switched-off
 *   heartbeat whose last occurrence failed still counts as failing, as it is listed that way.
 */
export async function getProjectAgentSummary(client: PoolClient, projectItemId: string): Promise<ProjectAgentSummary> {
  const guidance = await projectAgentGuidanceStore.load(client, projectItemId);
  const grants = await listMcpToolGrantsForProject(client, projectItemId, "en");
  const heartbeats = await listHeartbeatsByProject(client, projectItemId, new Map(), "user");
  const failingHeartbeats = await countFailingHeartbeats(
    client,
    heartbeats.map((heartbeat) => heartbeat.id),
  );
  const drift = await client.query<{ active: number }>(
    `SELECT count(*)::int AS active FROM agent_guidance_drift_findings WHERE project_item_id = $1 AND status = 'active'`,
    [projectItemId],
  );
  const approvals = await client.query<{ pending: number }>(
    `SELECT count(*)::int AS pending
     FROM approval_requests ar
     JOIN agent_runs r ON r.id = ar.agent_run_id
     WHERE r.project_item_id = $1 AND ar.status = 'pending'`,
    [projectItemId],
  );
  const activeDriftFindings = requireSingleRow(drift.rows, "the active drift finding count").active;
  const pendingApprovals = requireSingleRow(approvals.rows, "the pending approval count").pending;
  return {
    hasGuidance: guidance !== null && guidance.markdown.trim() !== "",
    guidanceUpdatedAt: guidance?.updatedAt ?? null,
    grantedToolCount: countEffectiveMcpGrants(grants).effective,
    enabledHeartbeatCount: heartbeats.filter((heartbeat) => heartbeat.enabled).length,
    attention: {
      activeDriftFindings,
      failingHeartbeats,
      pendingApprovals,
      needsAttention: activeDriftFindings > 0 || failingHeartbeats > 0 || pendingApprovals > 0,
    },
  };
}
