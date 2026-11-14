/** The longest `message` of a revise, in UTF-16 code units: it becomes one entry of the card's stored history. */
export const MAX_REVISE_MESSAGE_LENGTH = 2000;

/**
 * Whether a JSON value holds U+0000 in any string or object key. Postgres cannot store it in jsonb or text (22P05), so
 * the revise route and the revise tool refuse such a value before writing it. The walk is iterative and visits every
 * node of the value once, so a deeply nested value cannot exhaust the stack; the size cap of the request or of the
 * tool call bounds its length.
 */
export function containsNul(root: unknown): boolean {
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string") {
      if (value.includes("\u0000")) return true;
    } else if (Array.isArray(value)) {
      for (const entry of value as unknown[]) pending.push(entry);
    } else if (typeof value === "object" && value !== null) {
      for (const [key, entry] of Object.entries(value)) {
        if (key.includes("\u0000")) return true;
        pending.push(entry);
      }
    }
  }
  return false;
}
