import type { Pool } from "pg";
import { runAsSystem } from "@semprec/shared";

/**
 * Startup check that a long-running service connects as a runtime role. Row-level security does not
 * apply to a role that is itself a superuser or has `BYPASSRLS`, nor to the owner of a table. Those
 * attributes are not inherited through role membership, but a member can `SET ROLE` into a privileged
 * role, so membership in one is refused too. The tenant-isolation ADR
 * (`docs/adr/2026-10-03-tenant-isolation-through-row-level-security.md`, "No `FORCE ROW LEVEL SECURITY`")
 * requires runtime roles to be neither superuser nor `BYPASSRLS` and to own no table. The ownership
 * check covers relations in the `public` schema only, as issue #1051 specifies; tables in other schemas
 * are not checked here. This module is the per-process half of that rule; the deploy-time half is
 * issue #1085.
 */

export type RuntimeRoleViolation = "superuser" | "bypassrls" | "memberOfPrivilegedRole" | "ownsPublicRelation";

export class RuntimeRoleAssertionError extends Error {
  readonly role: string;
  readonly violations: readonly RuntimeRoleViolation[];

  constructor(role: string, violations: readonly RuntimeRoleViolation[]) {
    super(
      `Refusing to start: database role "${role}" violates ${violations.join(", ")}; runtime services must connect as semprec_data or semprec_side`,
    );
    this.name = "RuntimeRoleAssertionError";
    this.role = role;
    this.violations = violations;
  }
}

interface RuntimeRoleRow {
  rolname: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
  member_of_privileged_role: boolean;
  owns_public_relation: boolean;
}

const RUNTIME_ROLE_QUERY = `
  SELECT r.rolname, r.rolsuper, r.rolbypassrls,
    EXISTS (SELECT 1 FROM pg_roles m
            WHERE m.oid <> r.oid AND (m.rolsuper OR m.rolbypassrls)
              AND pg_has_role(r.oid, m.oid, 'MEMBER')) AS member_of_privileged_role,
    EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND pg_has_role(r.oid, c.relowner, 'MEMBER')) AS owns_public_relation
  FROM pg_roles r WHERE r.rolname = current_user
`;

/**
 * Refuses to continue unless the role this pool logged in as is a runtime role. Runs one catalog
 * query under a system scope, so it neither logs `tenant_scope_missing` nor throws in strict mode.
 * Any violation throws `RuntimeRoleAssertionError`, whose message names the role and the violations
 * but never the connection string or password. Errors propagate; the caller decides what a failed
 * startup does.
 */
export async function assertRuntimeRole(pool: Pool): Promise<void> {
  const { rows } = await runAsSystem("runtime-role-assertion", () => pool.query<RuntimeRoleRow>(RUNTIME_ROLE_QUERY));
  const row = rows[0];
  if (!row) {
    throw new Error("Runtime role assertion query returned no row for current_user");
  }

  const violations: RuntimeRoleViolation[] = [];
  if (row.rolsuper) violations.push("superuser");
  if (row.rolbypassrls) violations.push("bypassrls");
  if (row.member_of_privileged_role) violations.push("memberOfPrivilegedRole");
  if (row.owns_public_relation) violations.push("ownsPublicRelation");

  if (violations.length > 0) {
    throw new RuntimeRoleAssertionError(row.rolname, violations);
  }
}
