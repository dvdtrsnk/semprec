import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { withTransaction } from "../db/pool.js";
import { getDatabaseByKey, getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import {
  confirmProposalWithClient,
  readConfirmationResults,
  rejectProposalWithClient,
  reviseProposalWithClient,
  type ConfirmationResult,
  type ConfirmProposalCredentialInput,
  type ReviseProposalInput,
} from "./proposalActions.js";
import type { ProposalEntityKind } from "./proposalEnvelope.js";
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
  /** The authenticated caller; only the confirm and revise routes read it. */
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

/** The request body as an object; a `null` body (the JSON `null`) is an empty one. Any other shape is a `ValidationError`. */
function bodyObject(body: unknown): Record<string, unknown> {
  if (body === null) return {};
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError("Request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

/** The optional `ifVersion` of a confirm or reject body (issue #1852): the card's `updatedAt`, which is an ISO 8601 UTC timestamp. */
const ifVersionSchema = z.iso.datetime();

/** `undefined` when the body carries no `ifVersion`; otherwise the timestamp string, or a `ValidationError` naming the field. */
function parseIfVersion(body: Record<string, unknown>): string | undefined {
  if (body.ifVersion === undefined) return undefined;
  const parsed = ifVersionSchema.safeParse(body.ifVersion);
  if (!parsed.success) {
    throw new ValidationError("'ifVersion' must be an ISO 8601 UTC timestamp string", { field: "ifVersion" });
  }
  return parsed.data;
}

/** `undefined` when the body carries no `credential` at all — not every proposal confirm needs one (issue #123). */
function parseConfirmCredential(body: Record<string, unknown>): ConfirmProposalCredentialInput | undefined {
  const credential = body.credential;
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
    const body = bodyObject(ctx.body);
    const credential = parseConfirmCredential(body);
    const ifVersion = parseIfVersion(body);
    const actingUserId = ctx.identity?.user.id;
    const item = await withTransaction(pool, async (client) => {
      const processingProposalsDatabaseId = await resolveDatabaseIdByModuleId(client, PROCESSING_PROPOSALS_MODULE_ID);
      return confirmProposalWithClient(
        client,
        { processingProposalsDatabaseId },
        proposalId,
        credential,
        actingUserId,
        ifVersion,
      );
    });
    return { status: 200, item, results: readConfirmationResults(item.properties) };
  };
}

/** The longest `message` a reject may carry; it becomes the text of one history entry. */
const REJECT_MESSAGE_MAX_LENGTH = 1000;

/**
 * The optional `message` of a reject body: `undefined` when the body carries none, else a string that is
 * not blank and at most `REJECT_MESSAGE_MAX_LENGTH` characters.
 */
function parseRejectMessage(body: Record<string, unknown>): string | undefined {
  const message = body.message;
  if (message === undefined) return undefined;
  if (typeof message !== "string" || message.trim().length === 0) {
    throw new ValidationError("'message' must be a non-empty string", { field: "message" });
  }
  if (message.length > REJECT_MESSAGE_MAX_LENGTH) {
    throw new ValidationError(`'message' must be at most ${REJECT_MESSAGE_MAX_LENGTH} characters`, {
      field: "message",
    });
  }
  return message;
}

/**
 * `POST /api/proposals/:id/reject` (issue #1845) — discards a card without writing a destination, as one
 * transaction of `rejectProposalWithClient` (the status transition, its history entry and the Journal
 * recompute). A custom route because the generic item update cannot set the system-owned `status`.
 * Thin mapping only: idempotency (an already `rejected` card is returned unchanged) and the refusal of a
 * `confirmed` card live in the action. The answer is the card item; unlike the confirm answer it has no
 * `results`, because a rejected card never holds any.
 */
export function createRejectProposalRouteHandler(pool: Pool) {
  return async (ctx: CustomRouteRequestContext): Promise<CustomRouteResult> => {
    const proposalId = requireParam(ctx.params, "id");
    const body = bodyObject(ctx.body);
    const message = parseRejectMessage(body);
    const ifVersion = parseIfVersion(body);
    const item = await withTransaction(pool, async (client) => {
      const processingProposalsDatabaseId = await resolveDatabaseIdByModuleId(client, PROCESSING_PROPOSALS_MODULE_ID);
      return rejectProposalWithClient(client, { processingProposalsDatabaseId }, proposalId, message, ifVersion);
    });
    return { status: 200, item };
  };
}

/** The longest `message` the revise route accepts, in UTF-16 code units: it becomes one entry of the card's stored history. */
const MAX_REVISE_MESSAGE_LENGTH = 2000;

const REVISE_BODY_KEYS: readonly string[] = ["entityKind", "target", "properties", "message", "ifVersion"];

const PROPOSAL_ENTITY_KINDS: readonly ProposalEntityKind[] = ["pageContent", "database", "relation"];

function isProposalEntityKind(value: string): value is ProposalEntityKind {
  return (PROPOSAL_ENTITY_KINDS as readonly string[]).includes(value);
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationError(`'${field}' must be a non-empty string`, { field });
  }
  // Postgres cannot store U+0000 in jsonb or text (22P05), so it is refused here as a 400 naming the field.
  if (value.includes("\u0000")) {
    throw new ValidationError(`'${field}' must not contain NUL characters`, { field });
  }
  return value;
}

/**
 * Whether a JSON value holds U+0000 in any string or object key. The walk is iterative and visits every node of the
 * request body once, so a deeply nested body cannot exhaust the stack; the body's own size cap bounds its length.
 */
function containsNul(root: unknown): boolean {
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string") {
      if (value.includes("\u0000")) return true;
    } else if (Array.isArray(value)) {
      for (const entry of value as unknown[]) pending.push(entry);
    } else if (typeof value === "object" && value !== null) {
      for (const [key, entry] of Object.entries(value)) {
        if (key.includes("\u0000")) return true;
        pending.push(entry);
      }
    }
  }
  return false;
}

/**
 * Parses the revise body strictly: a JSON object with only the keys `entityKind`, `target`, `properties`, `message`
 * and `ifVersion`, each of its type and free of U+0000, which jsonb cannot store. The three envelope keys come all together or not at all, and the body must carry
 * the envelope or a `message`. Whether a `message` alone is allowed depends on the card, which
 * `reviseProposalWithClient` decides.
 */
function parseReviseBody(body: unknown): ReviseProposalInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ValidationError("Request body must be a JSON object");
  }
  const fields = body as Record<string, unknown>;
  for (const key of Object.keys(fields)) {
    if (!REVISE_BODY_KEYS.includes(key)) {
      throw new ValidationError(`Unknown field '${key}'`, { field: key });
    }
  }
  const ifVersion = fields.ifVersion === undefined ? undefined : requireNonEmptyString(fields.ifVersion, "ifVersion");
  const message = fields.message === undefined ? undefined : requireNonEmptyString(fields.message, "message");
  if (message !== undefined && message.length > MAX_REVISE_MESSAGE_LENGTH) {
    throw new ValidationError(`'message' must be at most ${MAX_REVISE_MESSAGE_LENGTH} characters`, {
      field: "message",
    });
  }

  const envelopeKeys = ["entityKind", "target", "properties"] as const;
  const present = envelopeKeys.filter((key) => fields[key] !== undefined);
  if (present.length === 0) {
    if (message === undefined) {
      throw new ValidationError("Send a proposal ('entityKind', 'target' and 'properties') or a 'message'");
    }
    return { message, ...(ifVersion === undefined ? {} : { ifVersion }) };
  }
  const missing = envelopeKeys.find((key) => fields[key] === undefined);
  if (missing !== undefined) {
    throw new ValidationError(
      `'entityKind', 'target' and 'properties' must be sent together; '${missing}' is missing`,
      {
        field: missing,
      },
    );
  }

  const entityKind = requireNonEmptyString(fields.entityKind, "entityKind");
  if (!isProposalEntityKind(entityKind)) {
    throw new ValidationError(`'entityKind' must be one of: ${PROPOSAL_ENTITY_KINDS.join(", ")}`, {
      field: "entityKind",
    });
  }
  const target = requireNonEmptyString(fields.target, "target");
  const properties = fields.properties;
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) {
    throw new ValidationError("'properties' must be a JSON object", { field: "properties" });
  }
  if (containsNul(properties)) {
    throw new ValidationError("'properties' must not contain NUL characters", { field: "properties" });
  }
  return {
    entityKind,
    target,
    properties: { ...properties },
    ...(message === undefined ? {} : { message }),
    ...(ifVersion === undefined ? {} : { ifVersion }),
  };
}

/**
 * `POST /api/proposals/:id/revise` (issue #1870): mounts `reviseProposalWithClient` with the body described at
 * `parseReviseBody`. The revise runs in one transaction, so the envelope's validation against live destination state,
 * the lock check and the status transition commit together. Answers `200` with the updated card. Every
 * rule about the card (locked, role of a transcript card, `message` on a non-transcript card, `ifVersion`) lives in
 * `reviseProposalWithClient`.
 */
export function createReviseProposalRouteHandler(pool: Pool) {
  return async (ctx: CustomRouteRequestContext): Promise<CustomRouteResult> => {
    const proposalId = requireParam(ctx.params, "id");
    const input = parseReviseBody(ctx.body);
    const actingUserId = ctx.identity?.user.id;
    const item = await withTransaction(pool, async (client) => {
      const processingProposalsDatabaseId = await resolveDatabaseIdByModuleId(client, PROCESSING_PROPOSALS_MODULE_ID);
      return reviseProposalWithClient(client, { processingProposalsDatabaseId }, proposalId, input, actingUserId);
    });
    return { status: 200, item };
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
