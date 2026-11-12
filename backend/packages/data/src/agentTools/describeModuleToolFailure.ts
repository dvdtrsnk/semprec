const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const CODE_PATTERN = /^[A-Z0-9_]{1,32}$/;

/**
 * The log fields for a failed module agent tool call: only the error's class name and, when it has
 * one, its code (a Postgres SQLSTATE such as `23505`, or a Node code such as `ECONNRESET`). A module
 * handler writes user content, so the error it raises can carry that content: a Postgres `detail`
 * holds the offending column values and a `ZodError` holds the rejected input. The shared `err`
 * serializer writes every enumerable field and redacts only secret-shaped text, and logs are not
 * tenant-scoped, so the error object itself is never logged
 * (`docs/adr/2026-10-18-fatal-shutdown-rejection-and-mail-failure-logs.md` states the same rule for
 * mail). A name or code that is not a short identifier is dropped, because it could hold text.
 */
export function describeModuleToolFailure(err: unknown): { errorName: string; errorCode?: string } {
  if (!(err instanceof Error)) return { errorName: typeof err };
  return {
    errorName: IDENTIFIER_PATTERN.test(err.name) ? err.name : "Error",
    ...("code" in err && typeof err.code === "string" && CODE_PATTERN.test(err.code) ? { errorCode: err.code } : {}),
  };
}
