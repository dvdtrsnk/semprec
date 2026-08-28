import { z } from "zod";
import { registerViewType, type ViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { JOURNAL_PERIOD_TYPES } from "../journal/journalStore.js";

/**
 * Journal's own view type (issue #24, point 10): a year -> quarter -> month -> week -> day
 * switcher, not the Table/Board views from issue #22. Scoped to Journal's needs only — the
 * "temporal-switcher" view type as a general concept is explicitly out of this issue's scope.
 */
export const TEMPORAL_SWITCHER_VIEW_TYPE = "temporal-switcher";

const temporalSwitcherConfigSchema = z.object({
  granularity: z.enum(JOURNAL_PERIOD_TYPES).default("month"),
  /** ISO date the switcher is currently anchored to; defaults client-side to "today" when absent. */
  anchor: z.string().optional(),
});

export function registerTemporalSwitcherViewType(registry: ViewTypeRegistry): void {
  registerViewType(registry, TEMPORAL_SWITCHER_VIEW_TYPE, {
    configSchema: temporalSwitcherConfigSchema,
    // Opaque to the backend; the client resolves this to its renderer component.
    clientComponent: "journalTemporalSwitcher",
  });
}
