import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { currentTenantScope } from "@semprec/shared";
import { withTransaction } from "../db/pool.js";
import { getDatabaseByKey, getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import {
  confirmProposalWithClient,
  readConfirmationResults,
  recomputeProposalWithClient,
  rejectProposalWithClient,
  reopenProposalWithClient,
  resetProposalOverridesWithClient,
  reviseProposalWithClient,
  updateProposalValuesWithClient,
  type ConfirmationResult,
  type ConfirmProposalCredentialInput,
  type ReviseProposalInput,
  type UpdateProposalValuesInput,
  type UpdateProposalValuesResult,
} from "./proposalActions.js";
import type { ProposalEntityKind } from "./proposalEnvelope.js";
import type { KeptItem } from "./undoConfirmedProposal.js";
import { hashIdempotentRequest, readIdempotencyKeyHeader, runIdempotent } from "./idempotentResponsesStore.js";
import { listActiveInboxTypes, type InboxTypeSummary } from "./inboxTypesStore.js";
import { countOpenInboxCards, listInboxCards } from "./inboxCardsStore.js";
import { resolveEditorSchema, type ResolvedEditorSchema } from "./editorSchema.js";
import type { ProposalWarning } from "./editorSchema.js";
import {
  INBOX_ITEM_TYPES_MODULE_ID,
  INBOX_MODULE_ID,
  PROCESSING_PROPOSALS_MODULE_ID,
} from "../seed/inboxPipelineKeys.js";
import { createInboxItemWithClient } from "./inboxStore.js";
import { parseCaptureSource, type CaptureSource } from "./captureSource.js";
import {
  parseCaptureAttachments,
  readCaptureAttachments,
  requireAttachableBlobs,
  type CaptureAttachmentResponse,
} from "./captureAttachments.js";
import type { NewInboxAttachment } from "./inboxAttachmentsStore.js";
import {
  changeInboxItemTypeWithClient,
  lockActiveInboxType,
  type ChangeInboxItemTypeInput,
} from "./inboxTypeChange.js";
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
import { isProposalOptionField, listProposalOptions, PROPOSAL_OPTION_FIELDS } from "./proposalOptions.js";
import { readItemOrigin } from "./itemOriginsStore.js";
import type { CustomRouteResult, RouteParams, RouteBody, RouteUser, RouteLocale } from "../customRoute.js";
import { requestUrl, requireBodyObject } from "../customRoute.js";

/** `identity` and `req` are optional on the card routes. */
interface InboxRouteContext extends RouteParams, RouteBody {
  identity?: { user: { id: string; locale?: string } };
  req?: { headers: Record<string, string | string[] | undefined>; url?: string };
}

/** Either the card, serialized into the item envelope with its extra top-level fields, or a raw JSON body. */
type InboxRouteResult =
  | {
      status: number;
      item: ItemRow;
      results?: ConfirmationResult[];
      warnings?: ProposalWarning[];
      keptItems?: KeptItem[];
      attachments?: CaptureAttachmentResponse[];
    }
  | CustomRouteResult;

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

/** A JSON `null` body is an empty one. */
function bodyObject(body: unknown): Record<string, unknown> {
  if (body === null) return {};
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError("Request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

/** The card's `version`, a decimal integer string. */
const ifVersionSchema = z.string().regex(/^[1-9][0-9]{0,18}$/);

function parseIfVersion(body: Record<string, unknown>): string | undefined {
  if (body.ifVersion === undefined) return undefined;
  const parsed = ifVersionSchema.safeParse(body.ifVersion);
  if (!parsed.success) {
    throw new ValidationError("'ifVersion' must be the card's version, a decimal integer string", {
      field: "ifVersion",
    });
  }
  return parsed.data;
}

/** Not every proposal confirm needs a credential. */
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

/** Thin mapping: every confirmation rule lives in `confirmProposalWithClient`. */
export function createConfirmProposalRouteHandler(pool: Pool) {
  return async (ctx: InboxRouteContext): Promise<InboxRouteResult> => {
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

const REJECT_MESSAGE_MAX_LENGTH = 1000;

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
 * Thin mapping: idempotency and the refusal of a `confirmed` card live in `rejectProposalWithClient`. Unlike confirm
 * the answer has no `results`.
 */
export function createRejectProposalRouteHandler(pool: Pool) {
  return async (ctx: InboxRouteContext): Promise<InboxRouteResult> => {
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

/**
 * Thin mapping over `reopenProposalWithClient`. Answers the card and `keptItems`, the items the undo of a confirmation
 * left in place (empty for any other reopen).
 */
export function createReopenProposalRouteHandler(pool: Pool) {
  return async (ctx: InboxRouteContext): Promise<InboxRouteResult> => {
    const proposalId = requireParam(ctx.params, "id");
    const ifVersion = parseIfVersion(bodyObject(ctx.body));
    const actingUserId = ctx.identity?.user.id;
    const { item, keptItems } = await withTransaction(pool, async (client) => {
      const processingProposalsDatabaseId = await resolveDatabaseIdByModuleId(client, PROCESSING_PROPOSALS_MODULE_ID);
      return reopenProposalWithClient(
        client,
        { processingProposalsDatabaseId },
        proposalId,
        ifVersion === undefined ? {} : { ifVersion },
        actingUserId,
      );
    });
    return { status: 200, item, keptItems };
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
  // Postgres cannot store U+0000 in jsonb or text (22P05), so refuse it here as a 400 naming the field.
  if (value.includes("\u0000")) {
    throw new ValidationError(`'${field}' must not contain NUL characters`, { field });
  }
  return value;
}

/**
 * Strict: the three envelope keys come together or not at all, and the body needs the envelope or a `message`.
 * Whether a lone `message` is allowed is decided by `reviseProposalWithClient`.
 */
function parseReviseBody(body: unknown): ReviseProposalInput {
  const fields = requireBodyObject(body);
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

/** Thin mapping; validation, lock check and status transition commit in one transaction in `reviseProposalWithClient`. */
export function createReviseProposalRouteHandler(pool: Pool) {
  return async (ctx: InboxRouteContext): Promise<InboxRouteResult> => {
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

const MAX_RELATION_TARGETS = 200;

function parseRefMap(value: unknown, part: "set" | "relations" | "steps"): Array<[string, Record<string, unknown>]> {
  if (!isPlainObject(value)) throw new ValidationError(`'${part}' must be a JSON object`, { field: part });
  return Object.entries(value).map(([ref, entries]): [string, Record<string, unknown>] => {
    if (!isPlainObject(entries)) {
      throw new ValidationError(`'${part}.${ref}' must be a JSON object`, { field: part, ref });
    }
    return [ref, entries];
  });
}

/** Target existence and the relation itself are checked by envelope validation. */
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

/** Values, refs, relation keys and targets are left to envelope validation. */
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

const storedCardSchema = z.object({
  id: z.string(),
  databaseId: z.string(),
  properties: z.record(z.string(), z.unknown()),
  computed: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
  version: z.string(),
  fromInbox: z.boolean().optional(),
});

const storedUpdateSchema = z.object({
  item: storedCardSchema,
  warnings: z.array(z.object({ ref: z.string().optional(), field: z.string(), code: z.literal("required") })),
});

/** Stored as `idempotent_responses.route`. */
const UPDATE_VALUES_ROUTE = "PATCH /api/proposals/:id/values";

/**
 * Thin mapping over `updateProposalValuesWithClient`, in one transaction opened here. Answers the card with its
 * required-field `warnings`.
 *
 * With an `Idempotency-Key` the update runs through `runIdempotent`: a repeat by the same user with the same card and
 * body replays the first answer and applies nothing; the same key with another card or body is `400`.
 */
export function createUpdateProposalValuesRouteHandler(pool: Pool) {
  return async (ctx: InboxRouteContext): Promise<InboxRouteResult> => {
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

/** Thin mapping over `resetProposalOverridesWithClient`. */
export function createResetProposalOverridesRouteHandler(pool: Pool) {
  return async (ctx: InboxRouteContext): Promise<InboxRouteResult> => {
    const proposalId = requireParam(ctx.params, "id");
    const ifVersion = parseIfVersion(bodyObject(ctx.body));
    const item = await withTransaction(pool, async (client) => {
      const processingProposalsDatabaseId = await resolveDatabaseIdByModuleId(client, PROCESSING_PROPOSALS_MODULE_ID);
      return resetProposalOverridesWithClient(
        client,
        { processingProposalsDatabaseId },
        proposalId,
        ifVersion === undefined ? {} : { ifVersion },
      );
    });
    return { status: 200, item };
  };
}

/**
 * Thin mapping over `recomputeProposalWithClient`. A custom route because the generic update cannot set the
 * system-owned `status` or queue the tick in the same transaction.
 */
export function createRecomputeProposalRouteHandler(pool: Pool) {
  return async (ctx: InboxRouteContext): Promise<InboxRouteResult> => {
    const proposalId = requireParam(ctx.params, "id");
    if (!UUID_RE.test(proposalId)) throw new ValidationError("'id' must be a UUID string", { field: "id" });
    const body = bodyObject(ctx.body);
    for (const key of Object.keys(body)) {
      if (key !== "ifVersion") throw new ValidationError(`Unknown field '${key}'`, { field: key });
    }
    const ifVersion = parseIfVersion(body);
    const actingUserId = ctx.identity?.user.id;
    const item = await withTransaction(pool, async (client) => {
      const processingProposalsDatabaseId = await resolveDatabaseIdByModuleId(client, PROCESSING_PROPOSALS_MODULE_ID);
      return recomputeProposalWithClient(client, { processingProposalsDatabaseId }, proposalId, {
        ...(ifVersion === undefined ? {} : { ifVersion }),
        ...(actingUserId === undefined ? {} : { actingUserId }),
      });
    });
    return { status: 200, item };
  };
}

const INCLUDE_DONE_VALUE = "true";

/**
 * Thin mapping over `listProposalOptions`. Tenant and locale come only from the session; another tenant's card is as
 * unknown as a random id.
 */
export function createProposalOptionsRouteHandler(pool: Pool) {
  return async (ctx: InboxRouteContext): Promise<InboxRouteResult> => {
    const proposalId = requireParam(ctx.params, "id");
    if (!UUID_RE.test(proposalId)) throw new ValidationError("'id' must be a UUID string", { field: "id" });
    const query = requestUrl(ctx.req ?? {}).searchParams;
    const field = query.get("field");
    if (field === null || !isProposalOptionField(field)) {
      throw new ValidationError(`'field' must be one of: ${PROPOSAL_OPTION_FIELDS.join(", ")}`, { field: "field" });
    }
    const includeDone = query.get("includeDone");
    if (includeDone !== null && includeDone !== INCLUDE_DONE_VALUE) {
      throw new ValidationError(`'includeDone' must be ${INCLUDE_DONE_VALUE} when present`, { field: "includeDone" });
    }
    const locale = ctx.identity?.user.locale ?? "en";
    const options = await withTransaction(pool, async (client) =>
      listProposalOptions(
        client,
        { processingProposalsDatabaseId: await resolveDatabaseIdByModuleId(client, PROCESSING_PROPOSALS_MODULE_ID) },
        proposalId,
        field,
        locale,
        includeDone !== null,
      ),
    );
    return { status: 200, body: { options } };
  };
}

/** One message for every missing-origin 404, so no case differs and none names the id. */
const ITEM_ORIGIN_NOT_FOUND_MESSAGE = "Item origin not found";

/**
 * A list screen must not call it per row. A missing, foreign, trashed or not-proposal-created item answers the same
 * 404. Tenant comes only from the session.
 */
export function createItemOriginRouteHandler(pool: Pool) {
  return async (ctx: InboxRouteContext): Promise<InboxRouteResult> => {
    const itemId = requireParam(ctx.params, "id");
    if (!UUID_RE.test(itemId)) throw new ValidationError("'id' must be a UUID string", { field: "id" });
    const origin = await withTransaction(pool, (client) => readItemOrigin(client, itemId));
    if (origin === null) throw new NotFoundError(ITEM_ORIGIN_NOT_FOUND_MESSAGE);
    return { status: 200, body: origin };
  };
}

const CHANGE_TYPE_BODY_KEYS: readonly string[] = ["typeId", "ifVersion"];

function parseChangeTypeBody(body: unknown): Pick<ChangeInboxItemTypeInput, "typeId" | "ifVersion"> {
  if (!isPlainObject(body)) throw new ValidationError("Request body must be a JSON object");
  for (const key of Object.keys(body)) {
    if (!CHANGE_TYPE_BODY_KEYS.includes(key)) throw new ValidationError(`Unknown field '${key}'`, { field: key });
  }
  const { typeId } = body;
  if (typeof typeId !== "string" || !UUID_RE.test(typeId)) {
    throw new ValidationError("'typeId' must be a UUID string", { field: "typeId" });
  }
  const ifVersion = parseIfVersion(body);
  return { typeId, ...(ifVersion === undefined ? {} : { ifVersion }) };
}

/** Thin mapping over `changeInboxItemTypeWithClient`, in the one transaction opened here. `card` is `null` without one. */
export function createChangeInboxItemTypeRouteHandler(pool: Pool) {
  return async (ctx: InboxRouteContext): Promise<InboxRouteResult> => {
    const itemId = requireParam(ctx.params, "id");
    if (!UUID_RE.test(itemId)) throw new ValidationError("'id' must be a UUID string", { field: "id" });
    const input = parseChangeTypeBody(ctx.body);
    const actingUserId = ctx.identity?.user.id;
    const result = await withTransaction(pool, async (client) =>
      changeInboxItemTypeWithClient(
        client,
        {
          inboxDatabaseId: await resolveDatabaseIdByModuleId(client, INBOX_MODULE_ID),
          inboxItemTypesDatabaseId: await resolveDatabaseIdByModuleId(client, INBOX_ITEM_TYPES_MODULE_ID),
          processingProposalsDatabaseId: await resolveDatabaseIdByModuleId(client, PROCESSING_PROPOSALS_MODULE_ID),
        },
        { itemId, ...input, ...(actingUserId === undefined ? {} : { actingUserId }) },
      ),
    );
    return { status: 200, body: result };
  };
}

const CAPTURE_BODY_KEYS: readonly string[] = [
  "text",
  "date",
  "time",
  "typeId",
  "attachments",
  "captureChannel",
  "sourceApp",
];

interface CaptureInput extends CaptureSource {
  text: string;
  date: string;
  time: string;
  typeId?: string;
  attachments: NewInboxAttachment[];
}

/**
 * `text` may be blank only when the capture has an attachment. Date/time validity is the create hook's question,
 * type activity `lockActiveInboxType`'s, blob eligibility `requireAttachableBlobs`'s.
 */
function parseCaptureBody(body: unknown): CaptureInput {
  if (!isPlainObject(body)) throw new ValidationError("Request body must be a JSON object");
  for (const key of Object.keys(body)) {
    if (!CAPTURE_BODY_KEYS.includes(key)) throw new ValidationError(`Unknown field '${key}'`, { field: key });
  }
  const { text, date, time, typeId } = body;
  const attachments = parseCaptureAttachments(body.attachments);
  if (typeof text !== "string" || (text.trim().length === 0 && attachments.length === 0)) {
    throw new ValidationError("'text' must be a non-empty string unless the capture has an attachment", {
      field: "text",
    });
  }
  if (containsNul(text)) throw new ValidationError("'text' must not contain NUL characters", { field: "text" });
  if (typeof date !== "string") throw new ValidationError("'date' must be a string 'YYYY-MM-DD'", { field: "date" });
  if (typeof time !== "string") throw new ValidationError("'time' must be a string 'HH:mm'", { field: "time" });
  const source = parseCaptureSource(body);
  if (typeId === undefined) return { text, date, time, attachments, ...source };
  if (typeof typeId !== "string" || !UUID_RE.test(typeId)) {
    throw new ValidationError("'typeId' must be a UUID string", { field: "typeId" });
  }
  return { text, date, time, typeId, attachments, ...source };
}

/**
 * Captures the item, its `type` edge and its attachments in one transaction. The create hook validates `date`/`time`,
 * links the Journal day and stamps `addedAt` with the server's receive time. Type and attachment checks run before
 * anything is written, so a refused capture leaves nothing behind.
 *
 * With an `Idempotency-Key`, a live item the key already reserved is answered before type or attachments are looked
 * at, and nothing is written; a trashed item does not count, as in the generic create.
 */
export function createCaptureInboxItemRouteHandler(pool: Pool) {
  return async (ctx: InboxRouteContext): Promise<InboxRouteResult> => {
    const input = parseCaptureBody(ctx.body);
    const idempotencyKey = readIdempotencyKeyHeader(ctx.req?.headers);
    const { item, attachments } = await withTransaction(pool, async (client) => {
      const inboxDatabaseId = await resolveDatabaseIdByModuleId(client, INBOX_MODULE_ID);
      if (idempotencyKey !== undefined) {
        const replay = await itemsStore.findIdempotentReplay(client, inboxDatabaseId, idempotencyKey, {
          requireLive: true,
        });
        if (replay) return { item: replay, attachments: await readCaptureAttachments(client, replay.id) };
      }
      if (input.typeId !== undefined) {
        await lockActiveInboxType(
          client,
          await resolveDatabaseIdByModuleId(client, INBOX_ITEM_TYPES_MODULE_ID),
          input.typeId,
        );
      }
      await requireAttachableBlobs(client, input.attachments);
      const created = await createInboxItemWithClient(client, {
        inboxDatabaseId,
        date: input.date,
        time: input.time,
        text: input.text,
        captureChannel: input.captureChannel,
        ...(input.sourceApp === undefined ? {} : { sourceApp: input.sourceApp }),
        ...(input.typeId === undefined ? {} : { type: input.typeId }),
        attachments: input.attachments,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      });
      return { item: created, attachments: await readCaptureAttachments(client, created.id) };
    });
    return { status: 201, item, attachments };
  };
}

interface InboxTypeEntry extends InboxTypeSummary {
  /** `null` when the type has no target. */
  targetLabel: string | null;
}

let moduleRegistryPromise: Promise<ModuleRegistry> | undefined;
let catalogResolverPromise: Promise<CatalogResolver> | undefined;

/**
 * The custom-route factory receives only the pool, so the registry is loaded here once per process. A failed load is
 * not cached, so the next request retries instead of failing until restart.
 */
function getModuleRegistry(): Promise<ModuleRegistry> {
  moduleRegistryPromise ??= loadFullModuleRegistry().catch((error: unknown) => {
    moduleRegistryPromise = undefined;
    throw error;
  });
  return moduleRegistryPromise;
}

/** A failed build is not cached. */
function getCatalogResolver(): Promise<CatalogResolver> {
  catalogResolverPromise ??= getModuleRegistry()
    .then((registry) => createCatalogResolver(registry))
    .catch((error: unknown) => {
      catalogResolverPromise = undefined;
      throw error;
    });
  return catalogResolverPromise;
}

/** The given name, else the catalog label, else the key itself. */
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

/** Only active types; each distinct target label is resolved once. */
export function createInboxTypesRouteHandler(pool: Pool) {
  return async (ctx: RouteLocale): Promise<CustomRouteResult> => {
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

/**
 * At most 200 entries plus the counted `total`; each card carries its base kind's `editorSchema`. Tenant and user come
 * only from the session; no paging or filtering.
 */
export function createInboxCardsRouteHandler(pool: Pool) {
  return async (ctx: RouteUser & RouteLocale): Promise<CustomRouteResult> => {
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

/** The same number as `total` of `GET /api/inbox/cards`, without reading the stack. */
export function createInboxCardsCountRouteHandler(pool: Pool) {
  return async (ctx: RouteUser): Promise<CustomRouteResult> => {
    const total = await withTransaction(pool, (client) =>
      countOpenInboxCards(client, { ownerUserId: ctx.identity.user.id }),
    );
    return { status: 200, body: { total } };
  };
}
