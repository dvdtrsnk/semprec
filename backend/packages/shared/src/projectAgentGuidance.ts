/**
 * Issue #214: the canonical hand-written project-agent guidance and the generic ports its
 * application service and stores are built against. Everything here is neutral — no `pg`,
 * no `Pool`/`PoolClient`, no reference to a concrete store — so `packages/agent-runtime` and
 * `packages/application` can depend on these shapes without depending on `packages/data`.
 */

export interface ProjectAgentGuidance {
  projectItemId: string;
  ownerUserId: string;
  markdown: string;
  updatedAt: string;
}

/** Server-derived authenticated user context; never accepted as request input. */
export interface ProjectAgentGuidanceActor {
  userId: string;
}

export interface UpsertProjectAgentGuidanceInput {
  projectItemId: string;
  markdown: string;
}

export interface TransferProjectAgentGuidanceInput {
  projectItemId: string;
  newOwnerUserId: string;
}

export type TransactionIsolationLevel = "repeatable_read" | "serializable";

/**
 * Generic transaction port: a concrete `TransactionRunner<PoolClient>` executes
 * `BEGIN ISOLATION LEVEL REPEATABLE READ` or `BEGIN ISOLATION LEVEL SERIALIZABLE`
 * depending on `options.isolation`, commits on success, and rolls back on throw.
 */
export interface TransactionRunner<Tx> {
  withTransaction<T>(options: { isolation: TransactionIsolationLevel }, work: (tx: Tx) => Promise<T>): Promise<T>;
}

/**
 * Persists the single `project_agent_guidance` row per project. Implementations use the
 * supplied `tx` and never open a transaction of their own — the caller (the application
 * service) owns transaction boundaries via `TransactionRunner`.
 */
export interface ProjectAgentGuidanceStore<Tx> {
  load(tx: Tx, projectItemId: string): Promise<ProjectAgentGuidance | null>;
  upsert(tx: Tx, row: Omit<ProjectAgentGuidance, "updatedAt">): Promise<ProjectAgentGuidance>;
  transfer(tx: Tx, projectItemId: string, newOwnerUserId: string): Promise<ProjectAgentGuidance>;
}

/**
 * Validates the entities `project_agent_guidance` refers to but cannot enforce with a
 * Postgres FK (`items` is partitioned per database, so there is no direct FK target for
 * `project_item_id`). Each `require*` method's only failure mode is "the referenced entity
 * doesn't exist" — callers treat any rejection from these methods as exactly that.
 *
 * `requireUserLocale` has no caller within this issue's scope; it's part of issue #214's port
 * as specified, kept here for #85's drift-notification flow (which needs the owner's locale to
 * localize the notification) rather than re-adding it to this interface later.
 */
export interface GuidanceReferenceStore<Tx> {
  requireProjectsItem(tx: Tx, projectItemId: string): Promise<void>;
  requireUser(tx: Tx, userId: string): Promise<void>;
  requireUserLocale(tx: Tx, userId: string): Promise<string>;
}

/**
 * #85 delivers the real `core.agentGuidanceDrift` heartbeat store (its unique index and
 * persisted fields); until then, callers inject a documented no-op so the service already
 * performs this call inside the same transaction as the guidance write.
 */
export interface GuidanceHeartbeatStore<Tx> {
  upsertDriftHeartbeat(tx: Tx, projectItemId: string): Promise<void>;
}
