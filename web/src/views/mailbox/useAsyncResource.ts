import { useCallback, useEffect, useState } from "react";
import { toOperationError, type OperationError } from "../../api/genericOperations.js";

export type AsyncResource<T> =
  | { status: "loading" }
  | { status: "ready"; value: T }
  | { status: "failed"; error: OperationError };

/**
 * One async read, in the loading / ready / failed shape every pane renders from, plus the
 * `reload` a retryable failure offers. A load that resolves after its inputs changed (or
 * after unmount) is dropped rather than written into state, so switching folders quickly
 * can never leave the slower answer on screen.
 */
export function useAsyncResource<T>(load: () => Promise<T>, deps: readonly unknown[]): { resource: AsyncResource<T>; reload: () => void } {
  const [resource, setResource] = useState<AsyncResource<T>>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  // The caller's `load` closure is recreated on every render; the declared deps (plus the
  // retry counter) are what actually decide when to re-read.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(load, [...deps, attempt]);

  useEffect(() => {
    let current = true;
    setResource({ status: "loading" });
    run().then(
      (value) => {
        if (current) setResource({ status: "ready", value });
      },
      (error: unknown) => {
        if (current) setResource({ status: "failed", error: toOperationError(error) });
      },
    );
    return () => {
      current = false;
    };
  }, [run]);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  return { resource, reload };
}
