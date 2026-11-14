import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { currentTenantScope } from "@semprec/shared";
import { withTransaction } from "../db/pool.js";
import { getDatabaseByKey, getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import {
  confirmProposalWithClient,
  readConfirmationResults,
  rejectProposalWithClient,
  reviseProposalWithClient,
  updateProposalValuesWithClient,
  type ConfirmationResult,
  type ConfirmProposalCredentialInput,
  type ReviseProposalInput,
  type UpdateProposalValuesInput,
  type UpdateProposalValuesResult,
} from "./proposalActions.js";
import type { ProposalEntityKind } from "./proposalEnvelope.js";
import { hashIdempotentRequest, readIdempotencyKeyHeader, runIdempotent } from "./idempotentResponsesStore.js";
import { listActiveInboxTypes, type InboxTypeSummary } from "./inboxTypesStore.js";
import { countOpenInboxCards, listInboxCards } from "./inboxCardsStore.js";
import { resolveEditorSchema, type ResolvedEditorSchema } from "./editorSchema.js";
import type { ProposalWarning } from "./editorSchema.js";
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
import { UUID_RE } from "../docs/pageOwnerDatabase.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { containsNul, MAX_REVISE_MESSAGE_LENGTH } from "./reviseInputChecks.js";
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
  /** The authenticated caller; only the confirm, revise and update-values routes read it. */
  identity?: { user: { id: string } };
  /** The request, which carries the `Idempotency-Key` header the update-values route reads. */
  req?: { headers: Record<string, string | string[] | undefined> };
}

type CustomRouteResult =
  | { status: number; item: ItemRow; results?: ConfirmationResult[]; warnings?: ProposalWarning[] }
  | { status: number; body: unknown };

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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The most target ids one relation list of a values request may hold. */
const MAX_RELATION_TARGETS = 200;

/** `value` as a JSON object of JSON objects, one per ref: the shape of `set`, `relations` and `steps` before their own entries are checked. */
function parseRefMap(value: unknown, part: "set" | "relations" | "steps"): Array<[string, Record<string, unknown>]> {
  if (!isPlainObject(value)) throw new ValidationError(`'${part}' must be a JSON object`, { field: part });
  return Object.entries(value).map(([ref, entries]): [string, Record<string, unknown>] => {
    if (!isPlainObject(entries)) {
      throw new ValidationError(`'${part}.${ref}' must be a JSON object`, { field: part, ref });
    }
    return [ref, entries];
  });
}

/** One relation list: a JSON array of at most `MAX_RELATION_TARGETS` item ids, each a UUID string. The target's existence and the relation itself are the envelope validation's question. */
function parseRelationTargets(ref: string, key: string, value: unknown): string[] {
  const where = { field: "relations", ref, key };
  if (!Array.isArray(value)) throw new ValidationError(`'relations.${ref}.${key}' must be a JSON array`, where);
  if (value.length > MAX_RELATION_TARGETS) {
    throw new ValidationError(`'relations.${ref}.${key}' may list at most ${MAX_RELATION_TARGETS} items`, where);
  }
  return value.map((id: unknown) => {
    if (typeof id !== "string" || !UUID_RE.test(id)) {
      throw new ValidationError(`'relations.${ref}.${key}' must hold item ids`, where);
    }
    return id;
  });
}

/**
 * `{ set?, relations?, steps?, ifVersion? }` (issues #1892 and #1920): `set` a JSON object of JSON objects, `relations`
 * ref -> relation property key -> a list of item ids, `steps` ref -> `{ enabled: boolean }`, `ifVersion` a string when
 * present, and at least one of `set`, `relations` and `steps`. The values of `set` stay unchecked here and so do the
 * refs, the relation keys and the targets; the envelope validation judges them.
 */
function parseUpdateValuesBody(body: unknown): UpdateProposalValuesInput {
  if (!isPlainObject(body)) throw new ValidationError("Request body must be a JSON object");
  const { set, relations, steps, ifVersion } = body;
  if (set === undefined && relations === undefined && steps === undefined) {
    throw new ValidationError("The request must hold at least one of 'set', 'relations' and 'steps'", { field: "set" });
  }
  if (ifVersion !== undefined && typeof ifVersion !== "string") {
    throw new ValidationError("'ifVersion' must be a string", { field: "ifVersion" });
  }
  const parsedRelations =
    relations === undefined
      ? undefined
      : Object.fromEntries(
          parseRefMap(relations, "relations").map(([ref, lists]) => [
            ref,
            Object.fromEntries(Object.entries(lists).map(([key, ids]) => [key, parseRelationTargets(ref, key, ids)])),
          ]),
        );
  const parsedSteps =
    steps === undefined
      ? undefined
      : Object.fromEntries(
          parseRefMap(steps, "steps").map(([ref, step]) => {
            if (Object.keys(step).length !== 1 || typeof step.enabled !== "boolean") {
              throw new ValidationError(`'steps.${ref}' must be { "enabled": true | false }`, { field: "steps", ref });
            }
            return [ref, { enabled: step.enabled }];
          }),
        );
  return {
    ...(set === undefined ? {} : { set: Object.fromEntries(parseRefMap(set, "set")) }),
    ...(parsedRelations === undefined ? {} : { relations: parsedRelations }),
    ...(parsedSteps === undefined ? {} : { steps: parsedSteps }),
    ...(ifVersion === undefined ? {} : { ifVersion }),
  };
}

/** The card of a stored update-values response, as `updateProposalValuesWithClient` returned it. */
const storedCardSchema = z.object({
  id: z.string(),
  databaseId: z.string(),
  properties: z.record(z.string(), z.unknown()),
  computed: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
  fromInbox: z.boolean().optional(),
});

/** The body of a stored update-values response: the card the first call answered and its required-field warnings. */
const storedUpdateSchema = z.object({
  item: storedCardSchema,
  warnings: z.array(z.object({ ref: z.string().optional(), field: z.string(), code: z.literal("required") })),
});

/** The route template under which update-values responses are stored (`idempotent_responses.route`). */
const UPDATE_VALUES_ROUTE = "PATCH /api/proposals/:id/values";

/**
 * `PATCH /api/proposals/:id/values` (issue #1892): the user's edit of the values on a proposal card. Thin mapping
 * only: the lock, the merge into `userOverrides`, the validation and the history entry live in
 * `updateProposalValuesWithClient`, which runs in the one transaction opened here. The same request may also
 * replace relation lists and switch steps on or off (issue #1920). Answers the updated card, as
 * the confirm route does, with its `warnings` (issue #1928): one `{ ref?, field, code: "required" }` per visible
 * required field the card still lacks, an empty list when none.
 *
 * With an `Idempotency-Key` header (issue gh-1894) the update runs through `runIdempotent`: a repeat of the key by
 * the same user with the same card and body answers the card and the warnings the first call answered and applies
 * nothing, and the key with another card or body is `400 validation_failed`. Without the header the route runs as
 * it always did.
 */
export function createUpdateProposalValuesRouteHandler(pool: Pool) {
  return async (ctx: CustomRouteRequestContext): Promise<CustomRouteResult> => {
    const proposalId = requireParam(ctx.params, "id");
    const input = parseUpdateValuesBody(ctx.body);
    const idempotencyKey = readIdempotencyKeyHeader(ctx.req?.headers);
    const update = async (client: PoolClient): Promise<UpdateProposalValuesResult> => {
      const processingProposalsDatabaseId = await resolveDatabaseIdByModuleId(client, PROCESSING_PROPOSALS_MODULE_ID);
      return updateProposalValuesWithClient(client, { processingProposalsDatabaseId }, proposalId, input);
    };
    if (idempotencyKey === undefined) {
      const { item, warnings } = await withTransaction(pool, update);
      return { status: 200, item, warnings };
    }
    const userId = ctx.identity?.user.id;
    if (userId === undefined) throw new Error("An idempotent update of proposal values needs the authenticated user");
    const response = await withTransaction(pool, (client) =>
      runIdempotent(
        client,
        {
          tenantScope: currentTenantScope(),
          userId,
          key: idempotencyKey,
          route: UPDATE_VALUES_ROUTE,
          requestHash: hashIdempotentRequest({ proposalId, body: ctx.body }),
        },
        async () => ({ status: 200, body: await update(client) }),
      ),
    );
    const stored = storedUpdateSchema.parse(response.body);
    return { status: response.status, item: stored.item, warnings: stored.warnings };
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
