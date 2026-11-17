import { z } from "zod";
import { registerViewType, type ViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { JOURNAL_PERIOD_TYPES } from "../journal/journalStore.js";

/** Journal's year -> quarter -> month -> week -> day switcher. */
export const TEMPORAL_SWITCHER_VIEW_TYPE = "temporal-switcher";

const temporalSwitcherConfigSchema = z.object({
  granularity: z.enum(JOURNAL_PERIOD_TYPES).default("month"),
  /** ISO 'YYYY-MM-DD'; the client defaults to today when absent. */
  anchor: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "anchor must be an ISO 'YYYY-MM-DD' date")
    .optional(),
});

export function registerTemporalSwitcherViewType(registry: ViewTypeRegistry): void {
  registerViewType(registry, TEMPORAL_SWITCHER_VIEW_TYPE, {
    configSchema: temporalSwitcherConfigSchema,
    // Opaque to the backend; the client resolves this to its renderer component.
    clientComponent: "journalTemporalSwitcher",
  });
}
