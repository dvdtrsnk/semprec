/**
 * Importing `embedded-postgres` registers `async-exit-hook`, whose `beforeExit` handler ends the
 * process with `process.exit(0)` once its shutdown hook is done. That overwrites the non-zero
 * `process.exitCode` vitest sets when a test fails, so a tier with failing tests exits 0 and its
 * CI job reports success. This records the exit code as it stood when `beforeExit` fired —
 * prepended, so before that handler runs — and puts it back in the `exit` event, which Node
 * emits before it reads `process.exitCode` for the last time.
 */
export function preserveFailingExitCode(): void {
  let exitCodeAtBeforeExit: typeof process.exitCode;
  process.prependListener("beforeExit", () => {
    exitCodeAtBeforeExit = process.exitCode;
  });
  process.on("exit", () => {
    if (!process.exitCode && exitCodeAtBeforeExit) process.exitCode = exitCodeAtBeforeExit;
  });
}
