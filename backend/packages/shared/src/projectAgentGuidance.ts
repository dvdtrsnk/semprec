/**
 * Project-agent guidance and the generic ports its service and stores are built against. Free of `pg` and concrete
 * stores, so `agent-runtime` and `application` can use these shapes without depending on `packages/data`.
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
 * Guidance is appended verbatim to the agent's system prompt on every invocation; the cap bounds context use and token
 * cost.
 */
export const MAX_PROJECT_AGENT_GUIDANCE_MARKDOWN_BYTES = 32 * 1024;

export interface TransferProjectAgentGuidanceInput {
  projectItemId: string;
  newOwnerUserId: string;
}

export type TransactionIsolationLevel = "repeatable_read" | "serializable";

/**
 * Runs `BEGIN ISOLATION LEVEL REPEATABLE READ` or `SERIALIZABLE` per `options.isolation`, commits on success, rolls
 * back on throw.
 */
export interface TransactionRunner<Tx> {
  withTransaction<T>(options: { isolation: TransactionIsolationLevel }, work: (tx: Tx) => Promise<T>): Promise<T>;
}

/** Implementations use the supplied `tx` and never open their own; the application service owns the boundaries. */
export interface ProjectAgentGuidanceStore<Tx> {
  load(tx: Tx, projectItemId: string): Promise<ProjectAgentGuidance | null>;
  loadForUpdate(tx: Tx, projectItemId: string): Promise<ProjectAgentGuidance | null>;
  upsert(tx: Tx, row: Omit<ProjectAgentGuidance, "updatedAt">): Promise<ProjectAgentGuidance>;
  transfer(tx: Tx, projectItemId: string, newOwnerUserId: string): Promise<ProjectAgentGuidance>;
  delete(tx: Tx, projectItemId: string): Promise<void>;
}

/**
 * The only failure `GuidanceReferenceStore`'s `require*` methods may signal: the entity does not exist. Any other error
 * must propagate as itself, so callers can tell "not found" from an infrastructure failure without depending on
 * `packages/data`'s error types.
 */
export class GuidanceReferenceNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuidanceReferenceNotFoundError";
  }
}

/**
 * Validates references the guidance tables carry no foreign key for (`project_item_id` must name an item of the
 * Projects database). A missing entity rejects with `GuidanceReferenceNotFoundError`; anything else is an
 * infrastructure failure.
 */
export interface GuidanceReferenceStore<Tx> {
  requireProjectsItem(tx: Tx, projectItemId: string): Promise<void>;
  requireUser(tx: Tx, userId: string): Promise<void>;
  requireUserLocale(tx: Tx, userId: string): Promise<string>;
}

/** Called inside the same transaction as the guidance write. */
export interface GuidanceHeartbeatStore<Tx> {
  upsertDriftHeartbeat(tx: Tx, projectItemId: string): Promise<void>;
  disableDriftHeartbeat(tx: Tx, projectItemId: string): Promise<void>;
}

/** In the order the canonical Markdown lists them. */
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
 * Reserved headings in order, each section trimmed, empty sections omitted, one blank line between sections and one
 * trailing newline. All-empty sections render as the empty string.
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
