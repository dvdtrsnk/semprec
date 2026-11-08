export const MAX_RESTORE_LEDGER_BYTES = 8 * 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Validates the strict backup artifact without changing the manual replay parser. */
export function parseRestoreReplayLedger(bytes: Uint8Array): string[] {
  if (bytes.byteLength > MAX_RESTORE_LEDGER_BYTES) throw new Error("Invalid restore ledger");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const ids = new Set<string>();
  for (const line of lines) {
    if (!UUID_PATTERN.test(line) || ids.has(line)) throw new Error("Invalid restore ledger");
    ids.add(line);
  }
  return [...ids];
}
