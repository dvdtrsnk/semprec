import type { Pool, PoolClient } from "pg";
import { requireAffectedRows, requireSingleRow, type Queryable } from "../db/pool.js";
import { ForbiddenError } from "../errors.js";
import { assertKnownValue } from "../dbRowValidation.js";
import { PROJECTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";

/**
 * `reserved` at the caller's estimate before the provider call, then `settled` with real usage or
 * `failed` at cost 0.
 */
export type AiGatewayCallStatus = "reserved" | "settled" | "failed";

const AI_GATEWAY_CALL_STATUSES: readonly AiGatewayCallStatus[] = ["reserved", "settled", "failed"];

export interface AiGatewayCallRow {
  id: string;
  at: string;
  provider: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  audioSeconds: number | null;
  costUsd: number;
  agentRunId: string | null;
  sempMessageId: string | null;
  /** Set only by the `POST /internal/complete` route. */
  projectItemId: string | null;
  operation: string | null;
  status: AiGatewayCallStatus;
}

export interface RecordTokenCallInput {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  agentRunId?: string | null;
  /** Set together with `operation`, or not at all. */
  projectItemId?: string | null;
  operation?: string | null;
}

/** Audio calls carry no agent-run attribution. */
export interface RecordAudioCallInput {
  provider: string;
  model: string;
  audioSeconds: number;
  costUsd: number;
}

type AiGatewayCallDbRow = {
  id: string;
  at: Date;
  provider: string;
  model: string;
  input_tokens: number | null;
  output_tokens: number | null;
  audio_seconds: string | null;
  cost_usd: string;
  agent_run_id: string | null;
  semp_message_id: string | null;
  project_item_id: string | null;
  operation: string | null;
  status: string;
};

function mapRow(row: AiGatewayCallDbRow): AiGatewayCallRow {
  return {
    id: row.id,
    at: row.at.toISOString(),
    provider: row.provider,
    model: row.model,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    audioSeconds: row.audio_seconds === null ? null : Number(row.audio_seconds),
    costUsd: Number(row.cost_usd),
    agentRunId: row.agent_run_id,
    sempMessageId: row.semp_message_id,
    projectItemId: row.project_item_id,
    operation: row.operation,
    status: assertKnownValue(AI_GATEWAY_CALL_STATUSES, row.status, "ai_gateway_calls status"),
  };
}

/** Token accounting; `audio_seconds` stays NULL (not 0) because no audio concept applies. */
export async function recordTokenGatewayCall(
  client: Pool | PoolClient,
  input: RecordTokenCallInput,
): Promise<AiGatewayCallRow> {
  const { rows } = await client.query<AiGatewayCallDbRow>(
    `INSERT INTO ai_gateway_calls (provider, model, input_tokens, output_tokens, audio_seconds, cost_usd, agent_run_id, project_item_id, operation)
     VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, $8)
     RETURNING id, at, provider, model, input_tokens, output_tokens, audio_seconds, cost_usd, agent_run_id, project_item_id, operation, status, semp_message_id`,
    [
      input.provider,
      input.model,
      input.inputTokens,
      input.outputTokens,
      input.costUsd,
      input.agentRunId ?? null,
      input.projectItemId ?? null,
      input.operation ?? null,
    ],
  );
  return mapRow(requireSingleRow(rows, "ai_gateway_calls row"));
}

/** Audio accounting; token columns stay NULL (not 0) because no token concept applies. */
export async function recordAudioGatewayCall(
  client: Pool | PoolClient,
  input: RecordAudioCallInput,
): Promise<AiGatewayCallRow> {
  const { rows } = await client.query<AiGatewayCallDbRow>(
    `INSERT INTO ai_gateway_calls (provider, model, input_tokens, output_tokens, audio_seconds, cost_usd, agent_run_id, project_item_id, operation)
     VALUES ($1, $2, NULL, NULL, $3, $4, NULL, NULL, NULL)
     RETURNING id, at, provider, model, input_tokens, output_tokens, audio_seconds, cost_usd, agent_run_id, project_item_id, operation, status, semp_message_id`,
    [input.provider, input.model, input.audioSeconds, input.costUsd],
  );
  return mapRow(requireSingleRow(rows, "ai_gateway_calls row"));
}

export interface ReserveGatewayCallInput {
  provider: string;
  model: string;
  /** Upper-bound estimate; counts against the budget until settled or failed. */
  estimatedCostUsd: number;
  agentRunId?: string | null;
  sempMessageId?: string | null;
  projectItemId?: string | null;
  operation?: string | null;
}

/** One detail-free refusal, so callers cannot tell the unattributable cases apart. */
function attributionRefused(): ForbiddenError {
  return new ForbiddenError(
    "AI gateway call is not attributable to the caller's tenant",
    undefined,
    "attribution_refused",
  );
}

/**
 * Runs before the budget check so unknown and inactive tenants get the same refusal; otherwise
 * `budget_exceeded` vs `attribution_refused` would reveal which tenant ids exist.
 * `reserveGatewayCall` keeps its own `status = 'active'` predicate as the write-time guard.
 */
export async function assertGatewayTenantActive(client: Pool | PoolClient): Promise<void> {
  const { rows } = await client.query<{ active: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM tenants WHERE id = app_tenant_default() AND status = 'active') AS active",
  );
  if (rows[0]?.active !== true) throw attributionRefused();
}

/**
 * One conditional INSERT so check and write cannot race: a row is produced only when the ambient
 * tenant is active and every referenced run/message/Projects item is visible under RLS. Otherwise
 * `attribution_refused` with no details, so foreign and unknown ids answer identically.
 */
export async function reserveGatewayCall(
  client: Pool | PoolClient,
  input: ReserveGatewayCallInput,
): Promise<AiGatewayCallRow> {
  const { rows } = await client.query<AiGatewayCallDbRow>(
    `INSERT INTO ai_gateway_calls (provider, model, input_tokens, output_tokens, audio_seconds, cost_usd, agent_run_id, project_item_id, operation, status, semp_message_id)
     SELECT $1, $2, NULL, NULL, NULL, $3, $4::uuid, $5::uuid, $6, 'reserved', $8::uuid
     WHERE EXISTS (SELECT 1 FROM tenants WHERE id = app_tenant_default() AND status = 'active')
       AND ($4::uuid IS NULL OR EXISTS (SELECT 1 FROM agent_runs WHERE id = $4::uuid))
       AND ($8::uuid IS NULL OR EXISTS (SELECT 1 FROM semp_messages WHERE id = $8::uuid))
       AND ($5::uuid IS NULL OR EXISTS (
         SELECT 1 FROM items i JOIN databases d ON d.id = i.database_id
         WHERE i.id = $5::uuid AND d.system AND d.owner_module_id = $7
       ))
     RETURNING id, at, provider, model, input_tokens, output_tokens, audio_seconds, cost_usd, agent_run_id, project_item_id, operation, status, semp_message_id`,
    [
      input.provider,
      input.model,
      input.estimatedCostUsd,
      input.agentRunId ?? null,
      input.projectItemId ?? null,
      input.operation ?? null,
      PROJECTS_MODULE_ID,
      input.sempMessageId ?? null,
    ],
  );
  const row = rows[0];
  if (!row) throw attributionRefused();
  return mapRow(row);
}

/**
 * Sets `semp_message_id` regardless of status (a speech-to-text stream has settled chunks and one
 * open `reserved` chunk). One conditional UPDATE: all-or-nothing, refused with
 * `attribution_refused` when the message or any row is not visible under RLS. Ids must be distinct.
 */
export async function attributeGatewayCallsToSempMessage(
  client: Pool | PoolClient,
  callIds: readonly string[],
  sempMessageId: string,
): Promise<void> {
  if (callIds.length === 0) return;
  const result = await client.query(
    `UPDATE ai_gateway_calls SET semp_message_id = $2::uuid
     WHERE id = ANY($1::bigint[])
       AND EXISTS (SELECT 1 FROM semp_messages WHERE id = $2::uuid)
       AND (SELECT count(*) FROM ai_gateway_calls WHERE id = ANY($1::bigint[])) = cardinality($1::bigint[])`,
    [callIds, sempMessageId],
  );
  if (result.rowCount !== callIds.length) throw attributionRefused();
}

/** Returns `null` when no `reserved` row matched; the caller decides what that means. */
export async function settleTokenGatewayCall(
  client: Pool | PoolClient,
  id: string,
  input: { inputTokens: number; outputTokens: number; costUsd: number },
): Promise<AiGatewayCallRow | null> {
  const result = await client.query<AiGatewayCallDbRow>(
    `UPDATE ai_gateway_calls SET status = 'settled', input_tokens = $2, output_tokens = $3, cost_usd = $4
     WHERE id = $1 AND status = 'reserved'
     RETURNING id, at, provider, model, input_tokens, output_tokens, audio_seconds, cost_usd, agent_run_id, project_item_id, operation, status, semp_message_id`,
    [id, input.inputTokens, input.outputTokens, input.costUsd],
  );
  if (!result.rowCount) return null;
  return mapRow(requireSingleRow(result.rows, `reserved ai_gateway_calls row ${id}`));
}

/** Returns `null` when no `reserved` row matched. */
export async function settleAudioGatewayCall(
  client: Pool | PoolClient,
  id: string,
  input: { audioSeconds: number; costUsd: number },
): Promise<AiGatewayCallRow | null> {
  const result = await client.query<AiGatewayCallDbRow>(
    `UPDATE ai_gateway_calls SET status = 'settled', audio_seconds = $2, cost_usd = $3
     WHERE id = $1 AND status = 'reserved'
     RETURNING id, at, provider, model, input_tokens, output_tokens, audio_seconds, cost_usd, agent_run_id, project_item_id, operation, status, semp_message_id`,
    [id, input.audioSeconds, input.costUsd],
  );
  if (!result.rowCount) return null;
  return mapRow(requireSingleRow(result.rows, `reserved ai_gateway_calls row ${id}`));
}

/**
 * Cost 0 lets every `SUM(cost_usd)` exclude failed rows without a status filter. Auto-committed on
 * the `Pool` so the record survives the caller's rollback; otherwise the estimate would keep
 * counting against the budget.
 */
export async function failGatewayCall(pool: Pool, id: string): Promise<void> {
  const result = await pool.query(
    `UPDATE ai_gateway_calls SET status = 'failed', cost_usd = 0 WHERE id = $1 AND status = 'reserved'`,
    [id],
  );
  requireAffectedRows(result, `failing reserved ai_gateway_calls row ${id}`);
}

/** Only `settled` calls count: a reserved call has only an estimate, a failed one used nothing. */
export async function sumSettledSempMessageTokens(
  client: Pool | PoolClient,
  sempMessageId: string,
): Promise<{ input: number; output: number }> {
  const { rows } = await client.query<{ input: string; output: string }>(
    `SELECT COALESCE(sum(input_tokens), 0) AS input, COALESCE(sum(output_tokens), 0) AS output
     FROM ai_gateway_calls WHERE semp_message_id = $1::uuid AND status = 'settled'`,
    [sempMessageId],
  );
  const row = requireSingleRow(rows, "Semp message token sums");
  return { input: Number(row.input), output: Number(row.output) };
}

/**
 * Same total as `getAgentRunUsage.totalCostUsd`, batched. Delegated runs are not included; every id
 * gets an entry, `0` when it has no visible calls.
 */
export async function getAgentRunCosts(
  client: Pool | PoolClient,
  agentRunIds: readonly string[],
): Promise<Map<string, number>> {
  const costs = new Map<string, number>(agentRunIds.map((id) => [id, 0]));
  if (agentRunIds.length === 0) return costs;
  const { rows } = await client.query<{ agent_run_id: string; cost_usd: string }>(
    `SELECT agent_run_id, SUM(cost_usd)::text AS cost_usd
     FROM ai_gateway_calls
     WHERE agent_run_id = ANY($1::uuid[])
     GROUP BY agent_run_id`,
    [agentRunIds],
  );
  for (const row of rows) costs.set(row.agent_run_id, Number(row.cost_usd));
  return costs;
}

/** Batched per-message cost, whichever run a call names; every id gets an entry, `0` when none visible. */
export async function getSempMessageCosts(
  client: Pool | PoolClient,
  sempMessageIds: readonly string[],
): Promise<Map<string, number>> {
  const costs = new Map<string, number>(sempMessageIds.map((id) => [id, 0]));
  if (sempMessageIds.length === 0) return costs;
  const { rows } = await client.query<{ semp_message_id: string; cost_usd: string }>(
    `SELECT semp_message_id, SUM(cost_usd)::text AS cost_usd
     FROM ai_gateway_calls
     WHERE semp_message_id = ANY($1::uuid[])
     GROUP BY semp_message_id`,
    [sempMessageIds],
  );
  for (const row of rows) costs.set(row.semp_message_id, Number(row.cost_usd));
  return costs;
}

export interface GatewaySpend {
  spentToday: number;
  spentMonth: number;
}

/**
 * Day and month spend of the RLS-scoped tenant. Boundaries are local midnight in `timezone`, not
 * the session timezone: the double `AT TIME ZONE` truncates on the local wall clock and converts
 * back to an instant. Reserved rows count at their estimate so in-flight calls count against caps.
 */
export async function getGatewaySpend(client: Pool | PoolClient, timezone: string): Promise<GatewaySpend> {
  const { rows } = await client.query<{ spent_today: string; spent_month: string }>(
    `SELECT
       COALESCE(SUM(cost_usd) FILTER (WHERE at >= date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1), 0)  AS spent_today,
       COALESCE(SUM(cost_usd), 0)                                                                               AS spent_month
     FROM ai_gateway_calls
     WHERE at >= date_trunc('month', now() AT TIME ZONE $1) AT TIME ZONE $1`,
    [timezone],
  );
  const totals = requireSingleRow(rows, "ai_gateway_calls spend totals");
  return { spentToday: Number(totals.spent_today), spentMonth: Number(totals.spent_month) };
}

/**
 * All-tenant spend in UTC via `ai_global_spend()`, a `alldots_router` function that bypasses RLS
 * and exposes only these two sums.
 */
export async function getGlobalGatewaySpend(client: Queryable): Promise<GatewaySpend> {
  const { rows } = await client.query<{ spent_today: string; spent_month: string }>(
    `SELECT spent_today, spent_month FROM ai_global_spend()`,
  );
  const totals = requireSingleRow(rows, "ai_global_spend totals");
  return { spentToday: Number(totals.spent_today), spentMonth: Number(totals.spent_month) };
}
