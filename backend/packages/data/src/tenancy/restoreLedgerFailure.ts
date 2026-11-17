import { RestoreLedgerMismatchError } from "./validateRestoreLedger.js";

const PRIVILEGE_MESSAGE = "Restore ledger validation failed: the restore role lacks a privilege";
const UNREACHABLE_MESSAGE =
  "Restore ledger validation failed: the restore database is unreachable or refused the login";
const MISMATCH_MESSAGE = "Restore ledger validation failed: the ledger does not cover the restored snapshot";
const GENERIC_MESSAGE = "Restore ledger validation failed";

const INSUFFICIENT_PRIVILEGE = "42501";
// SQLSTATE class 08 is a connection exception and class 28 an invalid authorization specification.
const CONNECTION_OR_LOGIN_SQLSTATE = /^(?:08|28)[0-9A-Z]{3}$/;
const NODE_CONNECTION_CODES: ReadonlySet<string> = new Set(["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND"]);
// node-postgres raises its connection timeouts as codeless errors with these fixed messages.
const CONNECTION_TIMEOUT_MESSAGES: ReadonlySet<string> = new Set([
  "timeout exceeded when trying to connect",
  "Connection terminated due to connection timeout",
]);
// Bounds the walk over a failure that came from a dependency: an aggregate or a cause chain may be deep or cyclic.
const MAX_INSPECTED_FAILURES = 64;

type Failure = "privilege" | "unreachable" | "mismatch";

function classify(error: unknown): Failure | undefined {
  if (error instanceof RestoreLedgerMismatchError) return "mismatch";
  if (typeof error !== "object" || error === null) return undefined;
  const code: unknown = Reflect.get(error, "code");
  if (code === INSUFFICIENT_PRIVILEGE) return "privilege";
  if (typeof code === "string" && (CONNECTION_OR_LOGIN_SQLSTATE.test(code) || NODE_CONNECTION_CODES.has(code)))
    return "unreachable";
  const message: unknown = Reflect.get(error, "message");
  if (typeof message === "string" && CONNECTION_TIMEOUT_MESSAGES.has(message)) return "unreachable";
  return undefined;
}

/** Every failure reachable from `root` through `AggregateError.errors` and `cause`, each visited once. */
function inspectedFailures(root: unknown): Failure[] {
  const found: Failure[] = [];
  const seen = new Set<unknown>();
  const pending: unknown[] = [root];
  while (pending.length > 0 && seen.size < MAX_INSPECTED_FAILURES) {
    const current = pending.pop();
    if (seen.has(current)) continue;
    seen.add(current);
    const failure = classify(current);
    if (failure) found.push(failure);
    if (typeof current !== "object" || current === null) continue;
    const cause: unknown = Reflect.get(current, "cause");
    if (cause !== undefined) pending.push(cause);
    if (current instanceof AggregateError) {
      const inner: readonly unknown[] = current.errors;
      pending.push(...inner);
    }
  }
  return found;
}

/**
 * Maps a validator failure to a fixed line with no tenant id, SQL or message, safe for a journal that is
 * not tenant-scoped. The validator's verdict wins (a mismatch is raised only after the query ran, so a
 * connection error beside it is incidental), then a missing privilege, then an unreachable database;
 * anything else gets the generic line.
 */
export function restoreLedgerFailureMessage(error: unknown): string {
  const failures = inspectedFailures(error);
  if (failures.includes("mismatch")) return MISMATCH_MESSAGE;
  if (failures.includes("privilege")) return PRIVILEGE_MESSAGE;
  if (failures.includes("unreachable")) return UNREACHABLE_MESSAGE;
  return GENERIC_MESSAGE;
}
