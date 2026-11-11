import type { Pool } from "pg";
import { readSempStatusReport } from "./sempStatusReport.js";

/**
 * What Semp cannot do while a banner problem is active, by category and stored problem kind. A kind
 * of a banner category that is not listed falls back to its category's key.
 */
const IMPACT_KEYS = {
  mail: { fallback: "mailNotSyncing", kinds: { mailSyncError: "mailNotSyncing" } },
  agents: {
    fallback: "agentsNotRunning",
    kinds: {
      processStale: "agentsNotRunning",
      agentHeartbeat: "heartbeatsNotRunning",
      agentRun: "agentRunsFailing",
      reply: "repliesNotSent",
    },
  },
} as const satisfies Record<string, { fallback: string; kinds: Record<string, string> }>;

type BannerCategory = keyof typeof IMPACT_KEYS;

function isBannerCategory(category: string): category is BannerCategory {
  return Object.hasOwn(IMPACT_KEYS, category);
}

function impactKey(category: BannerCategory, kind: string | undefined): string {
  const entry: { fallback: string; kinds: Record<string, string> } = IMPACT_KEYS[category];
  return (kind !== undefined && Object.hasOwn(entry.kinds, kind) ? entry.kinds[kind] : undefined) ?? entry.fallback;
}

export interface SempStatusBanner {
  problemId: string;
  title: string;
  shortText: string;
  impactKey: string;
  /**
   * The problem id, so a hidden notice reappears when the id changes: a stored problem that is
   * resolved and occurs again is a new row, and the id of an exhausted AI budget (issue gh-1871)
   * carries the reset instant of its window. An exhaustion that ends and returns inside one window
   * keeps its id.
   */
  instanceId: string;
}

/**
 * The profile and chat summary of the Semp status (issue #1631): the active problem count and the
 * banner, both taken from the one report read of issue #1555. The banner is the first critical
 * `mail` or `agents` problem in the report's order: the AI budget problem of issue gh-1871 when the
 * tenant has one, then the stored problems (critical first, then the latest `last_seen_at`, then
 * id), so of the stored problems the most severe and most recently seen one wins; `null` when
 * there is none.
 */
export async function getSempStatusSummary(
  pool: Pool,
): Promise<{ activeCount: number; banner: SempStatusBanner | null }> {
  const { report, problemKinds } = await readSempStatusReport(pool);
  for (const problem of report.problems) {
    if (problem.severity !== "critical" || !isBannerCategory(problem.category)) continue;
    return {
      activeCount: report.activeCount,
      banner: {
        problemId: problem.id,
        title: problem.title,
        shortText: problem.shortText,
        impactKey: impactKey(problem.category, problemKinds.get(problem.id)),
        instanceId: problem.id,
      },
    };
  }
  return { activeCount: report.activeCount, banner: null };
}
