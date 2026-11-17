/**
 * Log fields for a failed send: only the error class and SMTP codes. A recipient refusal carries
 * the address in `message`, `response` and `rejected`, and logs are not tenant-scoped.
 */
export function describeMailFailure(err: unknown): { errorName: string; errorCode?: string; responseCode?: number } {
  if (!(err instanceof Error)) return { errorName: typeof err };
  return {
    errorName: err.name,
    ...("code" in err && typeof err.code === "string" ? { errorCode: err.code } : {}),
    ...("responseCode" in err && typeof err.responseCode === "number" ? { responseCode: err.responseCode } : {}),
  };
}
