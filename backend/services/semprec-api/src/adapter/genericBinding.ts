import { ValidationError } from "@semprec/data";
import {
  GENERIC_OPERATION_BINDINGS,
  type AuthenticatedActor,
  type GenericApplicationPort,
  type GenericOperationName,
  type InputByOperation,
  type OutputByOperation,
  type ValidationIssueLike,
  validationIssueField,
} from "@semprec/shared";

/**
 * Converts a `ZodError` into `ValidationError`, which `adapterRoute.ts` catches. Exported so a
 * route calling a REST-only port method outside the generic catalog (e.g.
 * `patchPropertyWithDatabase`) validates against the same schema.
 */
export function parseOperationInput<K extends GenericOperationName>(operation: K, raw: unknown): InputByOperation[K] {
  const binding = GENERIC_OPERATION_BINDINGS[operation] as {
    input: {
      safeParse(
        value: unknown,
      ):
        | { success: true; data: InputByOperation[K] }
        | { success: false; error: { issues: (ValidationIssueLike & { message: string })[] } };
    };
  };
  const parsed = binding.input.safeParse(raw);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const field = validationIssueField(parsed.error.issues);
    if (operation === "database.patch" && firstIssue?.params?.reason === "empty_patch") {
      throw new ValidationError(firstIssue.message, { reason: "empty_patch" });
    }
    throw new ValidationError(
      firstIssue?.message ?? "Request failed validation",
      field === undefined ? undefined : { field },
    );
  }
  return parsed.data;
}

/**
 * No route hand-assembles a binding's output shape: `binding.invoke`'s return value feeds the
 * response envelope or is sent as-is.
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

/** Derived from the session's user id alone; `runId`/`agentProjectItemId` are agent-only. */
export function restActor(userId: string): AuthenticatedActor {
  return { userId, restSession: true };
}
