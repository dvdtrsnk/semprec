import type { Pool } from "pg";
import type { Logger } from "@semprec/shared";

export function createGracefulShutdown(options: {
  queueRuntime: { stop(): Promise<void> };
  pool: Pool;
  logger: Logger;
}) {
  let running: Promise<void> | null = null;
  return (signal: string): Promise<void> =>
    (running ??= (async () => {
      options.logger.info({ signal }, "semprec-transcribe shutting down");
      try {
        await options.queueRuntime.stop();
      } catch (err) {
        options.logger.error({ err, signal }, "queueRuntime.stop() failed");
      }
      await Promise.race([
        options.pool.end().catch((err: unknown) => options.logger.error({ err, signal }, "pool.end() failed")),
        new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
      ]);
      options.logger.info({ signal }, "semprec-transcribe shutdown complete");
    })());
}

export function registerShutdownSignals(shutdown: (signal: string) => Promise<void>): void {
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.on(signal, () => {
      void shutdown(signal).then(() => process.exit(0));
    });
}
