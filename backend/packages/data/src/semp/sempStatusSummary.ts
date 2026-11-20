import type { Pool } from "pg";
import { readSempStatusReport } from "./sempStatusReport.js";

/** What Semp cannot do while a banner problem is active; an unlisted kind falls back to its category's key. */
const IMPACT_KEYS = {
  mail: {
    fallback: "mailNotSyncing",
    kinds: { mailSyncError: "mailNotSyncing", calendarSyncError: "calendarsNotSyncing" },
  },
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
   * Changes when a hidden notice should reappear: a recurring stored problem is a new row, and the AI budget
   * problem's id carries its window's reset instant.
   */
  instanceId: string;
}

/**
 * Active count and banner, from one report read. The banner is the first critical `mail` or `agents` problem in
 * report order: the AI budget problem first, then stored problems by severity, latest `last_seen_at`, id.
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
