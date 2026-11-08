/**
 * The log fields for a failed outbound mail send: only the error's class name and the SMTP status
 * codes. A recipient refusal carries the address in `message`, `response` and `rejected`, and logs
 * are not tenant-scoped (docs/adr/2026-10-18-fatal-shutdown-rejection-and-mail-failure-logs.md).
 */
export function describeMailFailure(err: unknown): { errorName: string; errorCode?: string; responseCode?: number } {
  if (!(err instanceof Error)) return { errorName: typeof err };
  return {
    errorName: err.name,
    ...("code" in err && typeof err.code === "string" ? { errorCode: err.code } : {}),
    ...("responseCode" in err && typeof err.responseCode === "number" ? { responseCode: err.responseCode } : {}),
  };
}
