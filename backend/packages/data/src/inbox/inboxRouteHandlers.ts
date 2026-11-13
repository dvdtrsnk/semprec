import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../db/pool.js";
import { getDatabaseByKey, getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import {
  confirmProposalWithClient,
  readConfirmationResults,
  type ConfirmationResult,
  type ConfirmProposalCredentialInput,
} from "./proposalActions.js";
import { listActiveInboxTypes, type InboxTypeSummary } from "./inboxTypesStore.js";
import { countOpenInboxCards, listInboxCards } from "./inboxCardsStore.js";
import { resolveEditorSchema, type ResolvedEditorSchema } from "./editorSchema.js";
import { INBOX_ITEM_TYPES_MODULE_ID, PROCESSING_PROPOSALS_MODULE_ID } from "../seed/inboxPipelineKeys.js";
import { CREDENTIAL_TYPES, type CredentialType } from "../credentials/externalCredentialsStore.js";
import {
  createCatalogResolver,
  resolveDatabaseName,
  toManifestLocale,
  type CatalogResolver,
  type ManifestLocale,
} from "../manifest/catalogResolution.js";
import type { ModuleRegistry } from "@semprec/module-registry";
import { loadFullModuleRegistry } from "../manifest/fullModuleRegistry.js";
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
  /** The authenticated caller; only the confirm route reads it. */
  identity?: { user: { id: string } };
}

type CustomRouteResult =
  { status: number; item: ItemRow; results?: ConfirmationResult[] } | { status: number; body: unknown };

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
  if (body === null) return undefined;
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
    const actingUserId = ctx.identity?.user.id;
    const item = await withTransaction(pool, async (client) => {
      const processingProposalsDatabaseId = await resolveDatabaseIdByModuleId(client, PROCESSING_PROPOSALS_MODULE_ID);
      return confirmProposalWithClient(client, { processingProposalsDatabaseId }, proposalId, credential, actingUserId);
    });
    return { status: 200, item, results: readConfirmationResults(item.properties) };
  };
}

/** `GET /api/inbox-types`'s request context: the adapter always supplies the caller, whose `users.locale` is the locale its labels resolve in. */
interface InboxTypesRouteRequestContext {
  identity: { user: { locale: string } };
}

/** One active type as the capture UI reads it (issue #1439): the base fields, the processing config, and the target's label. */
interface InboxTypeEntry extends InboxTypeSummary {
  /** The target database's display name in the caller's locale; `null` when the type has no target. */
  targetLabel: string | null;
}

let moduleRegistryPromise: Promise<ModuleRegistry> | undefined;
let catalogResolverPromise: Promise<CatalogResolver> | undefined;

/**
 * The module registry the handlers of this file read through, loaded once per process by `loadFullModuleRegistry`.
 * The custom-route factory receives only the pool, so a handler cannot take the composition root's registry
 * instance. A failed load is not cached, so the next request retries instead of failing until restart.
 */
function getModuleRegistry(): Promise<ModuleRegistry> {
  moduleRegistryPromise ??= loadFullModuleRegistry().catch((error: unknown) => {
    moduleRegistryPromise = undefined;
    throw error;
  });
  return moduleRegistryPromise;
}

/** The catalog resolver every target label is read through, built once per process from `getModuleRegistry`. A failed build is not cached. */
function getCatalogResolver(): Promise<CatalogResolver> {
  catalogResolverPromise ??= getModuleRegistry()
    .then((registry) => createCatalogResolver(registry))
    .catch((error: unknown) => {
      catalogResolverPromise = undefined;
      throw error;
    });
  return catalogResolverPromise;
}

/**
 * A target database's display name in `locale`: the name it was given, else its catalog label, else
 * the key itself when the catalog has no entry for it. The key is always known here, so the database
 * id is never read; the key stands in for it.
 */
async function resolveTargetLabel(
  client: PoolClient,
  catalogResolver: CatalogResolver,
  targetKey: string,
  locale: ManifestLocale,
): Promise<string> {
  const database = await getDatabaseByKey(client, targetKey);
  const catalogs = await catalogResolver.getCatalogsForDbKey(targetKey);
  return resolveDatabaseName(database?.name ?? null, targetKey, targetKey, catalogs, locale);
}

/**
 * `GET /api/inbox-types` (issue #239's custom-route registration of #101's `listActiveInboxTypes`,
 * extended by issue #1439) — a read shortcut shaped for exactly one consumer, the capture UI's type
 * picker, not a generic list-items-in-a-database query. It returns only active types, and per type only
 * the base fields, how the type is processed, and, for a type with a target, the target's label in the
 * caller's locale. A label is resolved once per distinct target.
 */
export function createInboxTypesRouteHandler(pool: Pool) {
  return async (ctx: InboxTypesRouteRequestContext): Promise<CustomRouteResult> => {
    const locale = toManifestLocale(ctx.identity.user.locale);
    const catalogResolver = await getCatalogResolver();
    const types = await withTransaction(pool, async (client) => {
      const inboxItemTypesDatabaseId = await resolveDatabaseIdByModuleId(client, INBOX_ITEM_TYPES_MODULE_ID);
      const summaries = await listActiveInboxTypes(client, inboxItemTypesDatabaseId);
      const targetLabels = new Map<string, string>();
      const entries: InboxTypeEntry[] = [];
      for (const summary of summaries) {
        const targetKey = summary.targetDatabaseKey;
        if (targetKey === null) {
          entries.push({ ...summary, targetLabel: null });
          continue;
        }
        let targetLabel = targetLabels.get(targetKey);
        if (targetLabel === undefined) {
          targetLabel = await resolveTargetLabel(client, catalogResolver, targetKey, locale);
          targetLabels.set(targetKey, targetLabel);
        }
        entries.push({ ...summary, targetLabel });
      }
      return entries;
    });
    return { status: 200, body: { types } };
  };
}

/** `GET /api/inbox/cards`'s request context: the adapter always supplies the caller, whose id scopes the approvals and whose `users.locale` the labels. */
interface InboxCardsRouteRequestContext {
  identity: { user: { id: string; locale: string } };
}

/**
 * `GET /api/inbox/cards` (issue #1807) — the one read the Inbox needs, shaped for a single consumer: the
 * stack of open cards (pending tick and MCP approvals first, then the open Processing proposals cards)
 * with at most 200 entries and the `total` of the cards that are counted. Each card also carries the
 * `editorSchema` of its base kind in the caller's locale (issue #1825), `null` when no module declares one.
 * Tenant and user come only from the session. The route takes no query parameters: it neither pages nor filters.
 */
export function createInboxCardsRouteHandler(pool: Pool) {
  return async (ctx: InboxCardsRouteRequestContext): Promise<CustomRouteResult> => {
    const { id: ownerUserId, locale } = ctx.identity.user;
    const list = await withTransaction(pool, (client) => listInboxCards(client, { ownerUserId, locale }));
    const registry = await getModuleRegistry();
    const schemas = new Map<string, ResolvedEditorSchema | null>();
    for (const baseKind of new Set(list.cards.map((card) => card.baseKind))) {
      schemas.set(baseKind, await resolveEditorSchema(registry, baseKind, locale));
    }
    const cards = list.cards.map((card) => ({ ...card, editorSchema: schemas.get(card.baseKind) ?? null }));
    return { status: 200, body: { cards, total: list.total } };
  };
}

/** `GET /api/inbox/cards/count`'s request context: the adapter always supplies the caller, whose id scopes the approvals. */
interface InboxCardsCountRouteRequestContext {
  identity: { user: { id: string } };
}

/**
 * `GET /api/inbox/cards/count` (issue #1823) — how many cards wait for a decision, `{ total }`, without
 * reading the stack: the same number as the `total` of `GET /api/inbox/cards`, from `countOpenInboxCards`.
 * Tenant and user come only from the session. The route takes no query parameters.
 */
export function createInboxCardsCountRouteHandler(pool: Pool) {
  return async (ctx: InboxCardsCountRouteRequestContext): Promise<CustomRouteResult> => {
    const total = await withTransaction(pool, (client) =>
      countOpenInboxCards(client, { ownerUserId: ctx.identity.user.id }),
    );
    return { status: 200, body: { total } };
  };
}
