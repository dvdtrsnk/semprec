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
 * The one place a REST route turns an assembled command object into a binding dispatch (issue
 * #219): validates `raw` against the named operation's own Zod schema from
 * `GENERIC_OPERATION_BINDINGS` — converting a failure into this adapter's `ValidationError`
 * contract, since a `ZodError` itself isn't one of the errors `adapterRoute.ts` catches — then
 * calls `binding.invoke(service, actor, input)`. No route hand-assembles a binding's output
 * shape; `binding.invoke`'s return value is what feeds the route's response envelope (or, for the
 * confirmation-shaped operations, is sent as-is).
 */
export async function dispatchGenericOperation<K extends GenericOperationName>(
  service: GenericApplicationPort,
  operation: K,
  actor: AuthenticatedActor,
  raw: unknown,
): Promise<OutputByOperation[K]> {
  const binding = GENERIC_OPERATION_BINDINGS[operation] as {
    input: {
      safeParse(
        value: unknown,
      ):
        | { success: true; data: InputByOperation[K] }
        | { success: false; error: { issues: { path: (string | number)[]; message: string }[] } };
    };
    invoke(
      service: GenericApplicationPort,
      actor: AuthenticatedActor,
      input: InputByOperation[K],
    ): Promise<OutputByOperation[K]>;
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
  return binding.invoke(service, actor, parsed.data);
}

/** A REST human actor derives from the authenticated session's user id alone — no `runId`/`agentProjectItemId` (those are agent-only, populated by #220's composition root). */
export function restActor(userId: string): AuthenticatedActor {
  return { userId };
}
