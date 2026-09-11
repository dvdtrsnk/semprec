import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../db/pool.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { confirmProposalWithClient, type ConfirmProposalCredentialInput } from "./proposalActions.js";
import { listActiveInboxTypes, type InboxTypeSummary } from "./inboxTypesStore.js";
import { INBOX_ITEM_TYPES_MODULE_ID, PROCESSING_PROPOSALS_MODULE_ID } from "../seed/inboxPipelineKeys.js";
import { CREDENTIAL_TYPES, type CredentialType } from "../credentials/externalCredentialsStore.js";
import { NotFoundError, ValidationError } from "../errors.js";
import type { ItemRow } from "../types.js";

/**
 * The custom-route handler shape this file's exports are cast to by `semprec-api`'s mount
 * (issue #239) — this package has no reason to import that service's HTTP types, so the shape is
 * duck-typed here instead: a params map and a JSON body, resolving to either an item envelope or
 * a raw JSON body.
 */
interface CustomRouteRequestContext {
  params: Record<string, string>;
  body: unknown;
}

type CustomRouteResult = { status: number; item: ItemRow } | { status: number; body: unknown };

function requireParam(params: Record<string, string>, name: string): string {
  const value = params[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationError(`Missing required path parameter '${name}'`, { field: name });
  }
  return value;
}

async function resolveDatabaseIdByModuleId(client: PoolClient, moduleId: string): Promise<string> {
  const database = await getDatabaseByModuleId(client, moduleId);
  if (!database) throw new NotFoundError(`Database for module '${moduleId}' not found`);
  return database.id;
}

/** `undefined` when the body carries no `credential` at all — not every proposal confirm needs one (issue #123). */
function parseConfirmCredential(body: unknown): ConfirmProposalCredentialInput | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError("Request body must be a JSON object");
  }
  const credential = (body as Record<string, unknown>).credential;
  if (credential === undefined) return undefined;
  if (typeof credential !== "object" || credential === null || Array.isArray(credential)) {
    throw new ValidationError("'credential' must be a JSON object", { field: "credential" });
  }
  const { credentialType, plaintext } = credential as Record<string, unknown>;
  if (typeof credentialType !== "string" || !(CREDENTIAL_TYPES as readonly string[]).includes(credentialType)) {
    throw new ValidationError(`'credential.credentialType' must be one of: ${CREDENTIAL_TYPES.join(", ")}`, {
      field: "credentialType",
    });
  }
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new ValidationError("'credential.plaintext' must be a non-empty string", { field: "plaintext" });
  }
  return { credentialType: credentialType as CredentialType, plaintext };
}

/**
 * `POST /api/proposals/:id/confirm` (issue #239's custom-route registration of #105's
 * `confirmProposalWithClient` — the sole cross-destination write path a generic item update
 * could never express, so it stays a custom route rather than moving to the generic surface).
 * Thin mapping only: every confirmation rule (idempotency, envelope re-validation, the
 * credential/MCP-server gate) lives in `confirmProposalWithClient` itself.
 */
export function createConfirmProposalRouteHandler(pool: Pool) {
  return async (ctx: CustomRouteRequestContext): Promise<CustomRouteResult> => {
    const proposalId = requireParam(ctx.params, "id");
    const credential = parseConfirmCredential(ctx.body);
    const item = await withTransaction(pool, async (client) => {
      const processingProposalsDatabaseId = await resolveDatabaseIdByModuleId(client, PROCESSING_PROPOSALS_MODULE_ID);
      return confirmProposalWithClient(client, { processingProposalsDatabaseId }, proposalId, credential);
    });
    return { status: 200, item };
  };
}

/**
 * `GET /api/inbox-types` (issue #239's custom-route registration of #101's
 * `listActiveInboxTypes`) — a read shortcut shaped for exactly one consumer, the capture UI's
 * type picker, not a generic list-items-in-a-database query (it returns only active types, and
 * only the three fields that picker needs).
 */
export function createInboxTypesRouteHandler(pool: Pool) {
  return async (): Promise<CustomRouteResult> => {
    const types: InboxTypeSummary[] = await withTransaction(pool, async (client) => {
      const inboxItemTypesDatabaseId = await resolveDatabaseIdByModuleId(client, INBOX_ITEM_TYPES_MODULE_ID);
      return listActiveInboxTypes(client, inboxItemTypesDatabaseId);
    });
    return { status: 200, body: { types } };
  };
}
