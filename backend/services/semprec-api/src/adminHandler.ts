import type { Pool } from "pg";
import {
  createInvite,
  deleteAccountAsAdmin,
  getOperatorHealthReport,
  changeAccountRole,
  listAccounts,
  listInvites,
  listTenantAiBudgetOverview,
  NotFoundError,
  reactivateAccount,
  recordAdminAction,
  revokeInvite,
  setTenantAiBudget,
  suspendAccount,
  ValidationError,
  withTransaction,
} from "@semprec/data";
import { requireJsonObjectBody, requireStringField, requireUuidParam } from "./adapter/requestValidation.js";
import type { RouteDefinition } from "./adapter/routeTable.js";
import type { AppOptions } from "./app.js";

/**
 * A cap body field: `null` for no tenant cap in that window, otherwise a finite number >= 0 — the
 * full domain of `tenant_ai_budgets`' columns. Anything else is `validation_failed` naming the field.
 */
function requireCapField(body: Record<string, unknown>, field: string): number | null {
  const value = body[field];
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ValidationError(`'${field}' must be null or a finite number >= 0`, { field });
  }
  return value;
}

/**
 * The admin route family (issue #1037). Every route is flagged `admin: true`, so the adapter
 * refuses members with 403 `admin_required` and runs the handler in system scope; handlers here
 * read global identity tables only and never enter a tenant
 * (docs/adr/2026-10-17-admin-role-without-content-access.md). `options` is the dispatcher's own
 * options object: invitations read its `appBaseUrl` and `inviteMailer`.
 */
export function createAdminRoutes(pool: Pool, options: AppOptions): RouteDefinition[] {
  return [
    {
      method: "GET",
      path: "/api/admin/accounts",
      admin: true,
      handler: async () => ({ status: 200, body: { accounts: await listAccounts(pool) } }),
    },
    {
      method: "GET",
      path: "/api/admin/health",
      admin: true,
      handler: async () => ({ status: 200, body: await getOperatorHealthReport(pool) }),
    },
    {
      method: "GET",
      path: "/api/admin/ai-budgets",
      admin: true,
      handler: async () => ({
        status: 200,
        body: { spendWindow: "utc", accounts: await listTenantAiBudgetOverview(pool) },
      }),
    },
    {
      method: "PUT",
      path: "/api/admin/accounts/:userId/ai-budget",
      admin: true,
      handler: async (ctx) => {
        const userId = requireUuidParam(ctx.params, "userId");
        const body = requireJsonObjectBody(ctx.body);
        const dailyCapUsd = requireCapField(body, "dailyCapUsd");
        const monthlyCapUsd = requireCapField(body, "monthlyCapUsd");
        const actorUserId = ctx.identity.user.id;
        const budget = await withTransaction(pool, async (client) => {
          // Strictly the user's own binding: no sole-tenant fallback, so the write cannot land on a
          // tenant the account does not belong to once a deployment has more than one.
          const { rows } = await client.query<{ tenant_id: string | null }>(
            "SELECT tenant_id FROM users WHERE id = $1",
            [userId],
          );
          const row = rows[0];
          if (!row) throw new NotFoundError("Account not found", { userId });
          const tenantId = row.tenant_id;
          if (tenantId === null) {
            throw new ValidationError("Account has no tenant to hold an AI budget", { field: "userId" });
          }
          const saved = await setTenantAiBudget(client, {
            tenantId,
            dailyCapUsd,
            monthlyCapUsd,
            updatedBy: actorUserId,
          });
          await recordAdminAction(client, {
            actorUserId,
            action: "tenantAiBudgetSet",
            targetTenantId: tenantId,
            details: { dailyCapUsd, monthlyCapUsd },
          });
          return saved;
        });
        return {
          status: 200,
          body: {
            budget: {
              userId,
              dailyCapUsd: budget.dailyCapUsd,
              monthlyCapUsd: budget.monthlyCapUsd,
              updatedAt: budget.updatedAt,
            },
          },
        };
      },
    },
    {
      method: "POST",
      path: "/api/admin/accounts/:userId/suspend",
      admin: true,
      handler: async (ctx) => {
        const targetUserId = requireUuidParam(ctx.params, "userId");
        const actorUserId = ctx.identity.user.id;
        const account = await withTransaction(pool, (client) => suspendAccount(client, { actorUserId, targetUserId }));
        return { status: 200, body: { account } };
      },
    },
    {
      method: "POST",
      path: "/api/admin/accounts/:userId/reactivate",
      admin: true,
      handler: async (ctx) => {
        const targetUserId = requireUuidParam(ctx.params, "userId");
        const actorUserId = ctx.identity.user.id;
        const account = await withTransaction(pool, (client) =>
          reactivateAccount(client, { actorUserId, targetUserId }),
        );
        return { status: 200, body: { account } };
      },
    },
    {
      method: "POST",
      path: "/api/admin/accounts/:userId/delete",
      admin: true,
      handler: async (ctx) => {
        const targetUserId = requireUuidParam(ctx.params, "userId");
        const account = await deleteAccountAsAdmin(pool, { actorUserId: ctx.identity.user.id, targetUserId });
        return { status: 202, body: { account } };
      },
    },
    {
      method: "PUT",
      path: "/api/admin/accounts/:userId/role",
      admin: true,
      handler: async (ctx) => {
        const targetUserId = requireUuidParam(ctx.params, "userId");
        const body = requireJsonObjectBody(ctx.body);
        const role = body.role;
        if (role !== "admin" && role !== "member") {
          throw new ValidationError("'role' must be 'admin' or 'member'", { field: "role" });
        }
        const actorUserId = ctx.identity.user.id;
        const account = await withTransaction(pool, (client) =>
          changeAccountRole(client, { actorUserId, targetUserId, role }),
        );
        return { status: 200, body: { account } };
      },
    },
    {
      method: "POST",
      path: "/api/admin/invites",
      admin: true,
      handler: async (ctx) => {
        const body = requireJsonObjectBody(ctx.body);
        const email = requireStringField(body, "email");
        const actorUserId = ctx.identity.user.id;
        const created = await withTransaction(pool, async (client) => {
          const result = await createInvite(client, {
            email,
            invitedBy: actorUserId,
            appBaseUrl: options.appBaseUrl,
            mailer: options.inviteMailer ?? null,
          });
          // The audit row carries the invite id only: never the email address, never the token.
          await recordAdminAction(client, {
            actorUserId,
            action: "inviteCreated",
            targetTenantId: null,
            details: { inviteId: result.invite.id },
          });
          return result;
        });
        return {
          status: 201,
          body: { invite: created.invite, inviteUrl: created.inviteUrl, emailed: options.inviteMailer !== undefined },
        };
      },
    },
    {
      method: "GET",
      path: "/api/admin/invites",
      admin: true,
      handler: async () => ({ status: 200, body: { invites: await listInvites(pool) } }),
    },
    {
      method: "POST",
      path: "/api/admin/invites/:id/revoke",
      admin: true,
      handler: async (ctx) => {
        const inviteId = requireUuidParam(ctx.params, "id");
        const actorUserId = ctx.identity.user.id;
        const invite = await withTransaction(pool, async (client) => {
          const revoked = await revokeInvite(client, inviteId);
          await recordAdminAction(client, {
            actorUserId,
            action: "inviteRevoked",
            targetTenantId: null,
            details: { inviteId },
          });
          return revoked;
        });
        return { status: 200, body: { invite } };
      },
    },
  ];
}
