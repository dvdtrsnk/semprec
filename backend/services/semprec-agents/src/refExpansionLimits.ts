/** Maximum ephemeral context contributed by one reference and by the complete turn. */
export const MAX_REF_CONTEXT_CHARS = 8_000;
export const MAX_TURN_REF_CONTEXT_CHARS = 32_000;
const TRUNCATED = "\n[truncated]";

/** Bound each rendered section and the combined block, including the truncation notices. */
export function boundRefSections(sections: readonly string[]): string {
  if (sections.length === 0) return "";
  let remaining = MAX_TURN_REF_CONTEXT_CHARS - (sections.length - 1) * 2;
  const sizes = sections.map((section) => Math.min(section.length, MAX_REF_CONTEXT_CHARS)).sort((a, b) => a - b);
  let remainingSections = sections.length;
  let perSection = MAX_REF_CONTEXT_CHARS;
  for (const size of sizes) {
    const share = Math.floor(remaining / remainingSections);
    if (size > share) {
      perSection = share;
      break;
    }
    remaining -= size;
    remainingSections -= 1;
  }
  if (perSection < TRUNCATED.length) throw new Error("Too many reference sections");
  return sections
    .map((section) =>
      section.length <= perSection ? section : section.slice(0, perSection - TRUNCATED.length) + TRUNCATED,
    )
    .join("\n\n");
}
