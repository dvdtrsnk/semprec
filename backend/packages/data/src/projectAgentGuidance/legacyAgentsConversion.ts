import type { PoolClient } from "pg";
import {
  composeProjectAgentGuidanceMarkdown,
  MAX_PROJECT_AGENT_GUIDANCE_MARKDOWN_BYTES,
  type ProjectAgentGuidanceSectionKey,
  type ProjectAgentGuidanceSections,
} from "@alldots/shared";
import { requireSingleRow } from "../db/pool.js";
import { guidanceDriftHeartbeatStore } from "../guidanceDrift/guidanceDriftHeartbeatStore.js";
import { logger } from "../tenancy/logger.js";
import { projectAgentGuidanceVersionStore } from "../projectAgentGuidanceVersionStore.js";

/** Labels of the legacy `agents` property text, each with the section it fills. */
const LEGACY_MARKERS: ReadonlyArray<{ label: string; key: ProjectAgentGuidanceSectionKey }> = [
  { label: "Purpose", key: "purpose" },
  { label: "Allowed", key: "allowed" },
  { label: "Not allowed", key: "notAllowed" },
  { label: "General instructions", key: "generalInstructions" },
];

/**
 * A line starting with `Label:` (case-sensitive, optional space after the colon) opens that section until the next
 * label. Text before the first label, or with no label, belongs to General instructions; a repeated label appends.
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
 * Inserts a project's guidance row from its legacy `agents` text only when it has none (idempotent, never
 * overwrites a user edit), plus its drift heartbeat in the same transaction. Resolves `true` when it inserted. Empty
 * conversions write nothing; oversized ones are skipped with a warning naming only tenant and project, never text.
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

  // The owner is set only on first insert; only `transfer` may change it.
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
