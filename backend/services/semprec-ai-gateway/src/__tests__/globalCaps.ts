import type { GlobalAiCaps } from "@semprec/ai-gateway";

/** Global safety caps far above any test's spend, so only the per-tenant caps are in play. */
export const GENEROUS_GLOBAL_CAPS: GlobalAiCaps = { dailyCapUsd: 1_000_000, monthlyCapUsd: 10_000_000 };
