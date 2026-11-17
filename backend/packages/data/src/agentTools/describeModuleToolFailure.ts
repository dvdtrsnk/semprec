const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const CODE_PATTERN = /^[A-Z0-9_]{1,32}$/;

/**
 * Log fields for a failed module tool call: only the error's class name and code (SQLSTATE, Node code). The error
 * object itself is never logged: a handler writes user content, so a Postgres `detail` or `ZodError` can carry it,
 * the `err` serializer only redacts secret-shaped text, and logs are not tenant-scoped. A name or code that is not a
 * short identifier is dropped.
 */
export function describeModuleToolFailure(err: unknown): { errorName: string; errorCode?: string } {
  if (!(err instanceof Error)) return { errorName: typeof err };
  return {
    errorName: IDENTIFIER_PATTERN.test(err.name) ? err.name : "Error",
    ...("code" in err && typeof err.code === "string" && CODE_PATTERN.test(err.code) ? { errorCode: err.code } : {}),
  };
}
