import type { Pool } from "pg";
import { readSempRefContext, withTransaction } from "@semprec/data";
import { labeledSempMessageRefSchema, sempMessageRefSchema, type LabeledSempMessageRef } from "@semprec/shared";
import { boundRefSections } from "./refExpansionLimits.js";

/** Resolve each stored reference independently; only labels and refs are retained for replay. */
export async function expandSempRefs(
  pool: Pool,
  stored: unknown,
): Promise<{ context: LabeledSempMessageRef[]; text: string }> {
  if (!Array.isArray(stored)) return { context: [], text: "" };
  const entries: unknown[] = stored;
  const context: LabeledSempMessageRef[] = [];
  const sections: string[] = [];
  for (const entry of entries) {
    const old = labeledSempMessageRefSchema.safeParse(entry);
    const fresh = old.success ? null : sempMessageRefSchema.safeParse(entry);
    const ref = old.success ? old.data : fresh?.success ? fresh.data : null;
    if (!ref) {
      sections.push("Reference unavailable.");
      continue;
    }
    let label = old.success ? old.data.label : ref.kind;
    try {
      const resolved = await withTransaction(pool, (client) => readSempRefContext(client, ref));
      if (!resolved) {
        sections.push(`${ref.kind}: no longer exists or is unavailable.`);
      } else {
        if (!old.success) label = resolved.label.slice(0, 500);
        sections.push(
          `${ref.kind}: ${resolved.state === "trashed" ? "[trashed] " : ""}${resolved.label}\n${JSON.stringify(resolved.details)}`,
        );
      }
    } catch {
      sections.push(`${ref.kind}: unavailable.`);
    }
    context.push({ ...ref, label });
  }
  return { context, text: boundRefSections(sections) };
}
