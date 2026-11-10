import type { PoolClient } from "pg";
import {
  composeProjectAgentGuidanceMarkdown,
  MAX_PROJECT_AGENT_GUIDANCE_MARKDOWN_BYTES,
  type ProjectAgentGuidanceSectionKey,
  type ProjectAgentGuidanceSections,
} from "@semprec/shared";
import { requireSingleRow } from "../db/pool.js";
import { guidanceDriftHeartbeatStore } from "../guidanceDrift/guidanceDriftHeartbeatStore.js";
import { logger } from "../tenancy/logger.js";
import { projectAgentGuidanceVersionStore } from "../projectAgentGuidanceVersionStore.js";

/** The legacy labels of the `agents` property text, each with the section it fills (issue #1449). */
const LEGACY_MARKERS: ReadonlyArray<{ label: string; key: ProjectAgentGuidanceSectionKey }> = [
  { label: "Purpose", key: "purpose" },
  { label: "Allowed", key: "allowed" },
  { label: "Not allowed", key: "notAllowed" },
  { label: "General instructions", key: "generalInstructions" },
];

/**
 * Splits a legacy `agents` text into the four guidance sections. A line that starts with a label followed by a
 * colon (`Purpose:`, `Allowed:`, `Not allowed:`, `General instructions:`, matched case-sensitively, with an optional
 * space after the colon) opens its section, which runs until the next label. Lines before the first label, and a
 * text with no label at all, belong to General instructions. A repeated label appends to its section.
 */
export function legacyAgentsTextToSections(text: string): ProjectAgentGuidanceSections {
  const lines: Record<ProjectAgentGuidanceSectionKey, string[]> = {
    purpose: [],
    allowed: [],
    notAllowed: [],
    generalInstructions: [],
  };
  let current: ProjectAgentGuidanceSectionKey = "generalInstructions";
  for (const line of text.split(/\r?\n/)) {
    const marker = LEGACY_MARKERS.find(({ label }) => line.startsWith(`${label}:`));
    if (marker) {
      current = marker.key;
      lines[current].push(line.slice(marker.label.length + 1).replace(/^ /, ""));
    } else {
      lines[current].push(line);
    }
  }
  const section = (key: ProjectAgentGuidanceSectionKey): string => lines[key].join("\n").trim();
  return {
    purpose: section("purpose"),
    allowed: section("allowed"),
    notAllowed: section("notAllowed"),
    generalInstructions: section("generalInstructions"),
  };
}

/**
 * Writes the guidance row of one project from its legacy `agents` text (issue #1449). The row is inserted only when
 * the project has none, so a repeated call, or one after the user edited the row, changes nothing. An inserted row
 * also gets its `core.agentGuidanceDrift` heartbeat in the same transaction, because migration 0035 backfilled
 * heartbeats only for rows that existed then.
 *
 * Resolves `true` when this call inserted the row. A text that converts to no section text writes nothing, and a
 * converted document above `MAX_PROJECT_AGENT_GUIDANCE_MARKDOWN_BYTES` is skipped with a warning that names the tenant
 * and the project id only, never the text. Both resolve `false`.
 */
export async function seedProjectAgentGuidanceFromLegacyText(
  client: PoolClient,
  input: { projectItemId: string; ownerUserId: string; text: string },
): Promise<boolean> {
  const markdown = composeProjectAgentGuidanceMarkdown(legacyAgentsTextToSections(input.text));
  if (markdown === "") return false;
  if (Buffer.byteLength(markdown, "utf8") > MAX_PROJECT_AGENT_GUIDANCE_MARKDOWN_BYTES) {
    const { rows } = await client.query<{ tenant_id: string | null }>("SELECT app_tenant_default()::text AS tenant_id");
    logger.warn(
      { tenantId: requireSingleRow(rows, "tenant id").tenant_id, projectItemId: input.projectItemId },
      "project_agent_guidance_too_large",
    );
    return false;
  }

  // The owner is set only on the first insert: `owner_user_id` never changes through this path (only `transfer` may).
  await projectAgentGuidanceVersionStore.lock(client, input.projectItemId);
  const existing = await client.query<{ project_item_id: string }>(
    "SELECT project_item_id FROM project_agent_guidance WHERE project_item_id = $1 FOR UPDATE",
    [input.projectItemId],
  );
  if (existing.rows.length) return false;
  const version = await projectAgentGuidanceVersionStore.propose(client, input.projectItemId, null);
  const inserted = await client.query(
    `INSERT INTO project_agent_guidance (project_item_id, owner_user_id, markdown, updated_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (project_item_id) DO NOTHING`,
    [input.projectItemId, input.ownerUserId, markdown, version],
  );
  if ((inserted.rowCount ?? 0) === 0) return false;

  await projectAgentGuidanceVersionStore.record(client, input.projectItemId, version);

  await guidanceDriftHeartbeatStore.upsertDriftHeartbeat(client, input.projectItemId);
  return true;
}
