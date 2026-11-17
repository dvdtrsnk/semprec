/**
 * `embedded-postgres` registers `async-exit-hook`, whose `beforeExit` handler calls `process.exit(0)` and so hides
 * vitest's failing exit code from CI. This records the code in a prepended `beforeExit` listener and restores it in
 * `exit`, which Node emits before reading `process.exitCode` for the last time.
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
