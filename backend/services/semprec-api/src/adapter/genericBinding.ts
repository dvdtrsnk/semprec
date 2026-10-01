import { ValidationError } from "@semprec/data";
import {
  GENERIC_OPERATION_BINDINGS,
  type AuthenticatedActor,
  type GenericApplicationPort,
  type GenericOperationName,
  type InputByOperation,
  type OutputByOperation,
} from "@semprec/shared";

/**
 * Validates `raw` against operation `K`'s own Zod schema from `GENERIC_OPERATION_BINDINGS` —
 * converting a failure into this adapter's `ValidationError` contract, since a `ZodError` itself
 * isn't one of the errors `adapterRoute.ts` catches. Exported (issue #789) so a route calling a
 * `GenericApplicationPort` method outside the 29-operation catalog — e.g.
 * `patchPropertyWithDatabase` — can still validate its input against the same operation's schema
 * before calling that method directly, instead of going through `dispatchGenericOperation`. See
 * `docs/adr/2026-10-01-rest-only-port-extension-methods.md` for when a catalog-external port
 * method like this is appropriate and what it must satisfy.
 */
export function parseOperationInput<K extends GenericOperationName>(operation: K, raw: unknown): InputByOperation[K] {
  const binding = GENERIC_OPERATION_BINDINGS[operation] as {
    input: {
      safeParse(
        value: unknown,
      ):
        | { success: true; data: InputByOperation[K] }
        | { success: false; error: { issues: { path: (string | number)[]; message: string }[] } };
    };
  };
  const parsed = binding.input.safeParse(raw);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const field = firstIssue !== undefined && firstIssue.path.length > 0 ? firstIssue.path.join(".") : undefined;
    throw new ValidationError(
      firstIssue?.message ?? "Request failed validation",
      field === undefined ? undefined : { field },
    );
  }
  return parsed.data;
}

/**
 * The one place a REST route turns an assembled command object into a binding dispatch (issue
 * #219): validates `raw` via `parseOperationInput`, then calls `binding.invoke(service, actor,
 * input)`. No route hand-assembles a binding's output shape; `binding.invoke`'s return value is
 * what feeds the route's response envelope (or, for the confirmation-shaped operations, is sent
 * as-is).
 */
export async function dispatchGenericOperation<K extends GenericOperationName>(
  service: GenericApplicationPort,
  operation: K,
  actor: AuthenticatedActor,
  raw: unknown,
): Promise<OutputByOperation[K]> {
  const input = parseOperationInput(operation, raw);
  const binding = GENERIC_OPERATION_BINDINGS[operation] as {
    invoke(
      service: GenericApplicationPort,
      actor: AuthenticatedActor,
      input: InputByOperation[K],
    ): Promise<OutputByOperation[K]>;
  };
  return binding.invoke(service, actor, input);
}

/** A REST human actor derives from the authenticated session's user id alone — no `runId`/`agentProjectItemId` (those are agent-only, populated by #220's composition root). */
export function restActor(userId: string): AuthenticatedActor {
  return { userId };
}
