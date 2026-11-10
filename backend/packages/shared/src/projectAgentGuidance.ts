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

/**
 * Guidance markdown is appended verbatim to the agent's system prompt on every invocation
 * (see `packages/agent-runtime`'s `systemPromptOverride` adapter), so an unbounded value risks
 * context-window overflow and unbounded token cost. 32 KiB comfortably fits real guidance
 * documents while keeping the worst case bounded.
 */
export const MAX_PROJECT_AGENT_GUIDANCE_MARKDOWN_BYTES = 32 * 1024;

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
  loadForUpdate(tx: Tx, projectItemId: string): Promise<ProjectAgentGuidance | null>;
  upsert(tx: Tx, row: Omit<ProjectAgentGuidance, "updatedAt">): Promise<ProjectAgentGuidance>;
  transfer(tx: Tx, projectItemId: string, newOwnerUserId: string): Promise<ProjectAgentGuidance>;
  delete(tx: Tx, projectItemId: string): Promise<void>;
}

/**
 * The one failure mode `GuidanceReferenceStore`'s `require*` methods are allowed to signal:
 * the referenced entity doesn't exist. Implementations (e.g. `packages/data`'s
 * `guidanceReferenceStore`) throw this specific class for a missing row; any other error
 * (a dropped connection, a timeout) must propagate as itself so callers in
 * `packages/application` can distinguish "not found" from an infrastructure failure without
 * depending on `packages/data`'s concrete error types.
 */
export class GuidanceReferenceNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuidanceReferenceNotFoundError";
  }
}

/**
 * Validates the entities `project_agent_guidance` refers to but cannot enforce with a
 * Postgres FK (`items` is partitioned per database, so there is no direct FK target for
 * `project_item_id`). Each `require*` method rejects with `GuidanceReferenceNotFoundError`
 * when the referenced entity doesn't exist; any other rejection is an infrastructure failure
 * and must not be mistaken for one.
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
  disableDriftHeartbeat(tx: Tx, projectItemId: string): Promise<void>;
}

/** The four sections of a project's agent guidance, in the order the canonical Markdown lists them (issue #1449). */
export const PROJECT_AGENT_GUIDANCE_SECTION_KEYS = ["purpose", "allowed", "notAllowed", "generalInstructions"] as const;

export type ProjectAgentGuidanceSectionKey = (typeof PROJECT_AGENT_GUIDANCE_SECTION_KEYS)[number];

/** The reserved level-2 heading that opens each section of the canonical Markdown. */
export const PROJECT_AGENT_GUIDANCE_HEADINGS: Readonly<Record<ProjectAgentGuidanceSectionKey, string>> = {
  purpose: "## Purpose",
  allowed: "## Allowed",
  notAllowed: "## Not allowed",
  generalInstructions: "## General instructions",
};

/** The text of each section, without its heading. */
export type ProjectAgentGuidanceSections = Record<ProjectAgentGuidanceSectionKey, string>;

/**
 * Renders the canonical guidance Markdown: the reserved headings in order, each section's text trimmed,
 * empty sections omitted, sections separated by one blank line and the document ending with one newline.
 * Sections that all hold no text render as the empty string.
 */
export function composeProjectAgentGuidanceMarkdown(sections: ProjectAgentGuidanceSections): string {
  const blocks = PROJECT_AGENT_GUIDANCE_SECTION_KEYS.flatMap((key) => {
    const text = sections[key].trim();
    return text === "" ? [] : [`${PROJECT_AGENT_GUIDANCE_HEADINGS[key]}\n${text}`];
  });
  return blocks.length === 0 ? "" : `${blocks.join("\n\n")}\n`;
}

/** Parses reserved whole-line headings, retaining any preamble in general instructions. */
export function parseProjectAgentGuidanceMarkdown(markdown: string): ProjectAgentGuidanceSections {
  const chunks: Record<ProjectAgentGuidanceSectionKey, string[]> = {
    purpose: [],
    allowed: [],
    notAllowed: [],
    generalInstructions: [],
  };
  let current: ProjectAgentGuidanceSectionKey = "generalInstructions";
  for (const line of markdown.split(/\r\n|\r|\n/)) {
    const heading = PROJECT_AGENT_GUIDANCE_SECTION_KEYS.find((key) => PROJECT_AGENT_GUIDANCE_HEADINGS[key] === line);
    if (heading) current = heading;
    else chunks[current].push(line);
  }
  return {
    purpose: chunks.purpose.join("\n").trim(),
    allowed: chunks.allowed.join("\n").trim(),
    notAllowed: chunks.notAllowed.join("\n").trim(),
    generalInstructions: chunks.generalInstructions.join("\n").trim(),
  };
}

/** Identifies the first section containing a reserved whole-line heading. */
export function findReservedHeading(sections: ProjectAgentGuidanceSections): ProjectAgentGuidanceSectionKey | null {
  return (
    PROJECT_AGENT_GUIDANCE_SECTION_KEYS.find((key) =>
      sections[key]
        .split(/\r\n|\r|\n/)
        .some((line) =>
          PROJECT_AGENT_GUIDANCE_SECTION_KEYS.some((heading) => PROJECT_AGENT_GUIDANCE_HEADINGS[heading] === line),
        ),
    ) ?? null
  );
}
