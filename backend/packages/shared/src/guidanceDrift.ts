import { createHash } from "node:crypto";
import { canonicalizeJson } from "./canonicalJson.js";

export const BEHAVIOR_DRIFT_MIN_RUNS = 3;
export const BEHAVIOR_DRIFT_WINDOW_DAYS = 14;
export const BEHAVIOR_DRIFT_INPUT_BYTES = 1024 * 1024;

export type GuidanceDriftSeverity = "blocking" | "warning";

export type GuidanceDriftKind = "permission" | "behavior";

/** What a permission-check contradiction is about: the manifest operation and, if specific, the database. */
export interface GuidanceDriftPermissionSubject {
  operation: string;
  databaseId: string | null;
}

/** What a behavior-check contradiction is about: the MCP tool and, if specific, the database. */
export interface GuidanceDriftBehaviorSubject {
  mcpTool: string;
  databaseId: string | null;
}

/** A finding's identity: with project and kind, the only input of its fingerprint. */
export type GuidanceDriftSubject = GuidanceDriftPermissionSubject | GuidanceDriftBehaviorSubject;

/**
 * A contradiction between project guidance and the enforced permission manifest. `subject` is `null` only for a legacy
 * payload.
 */
export interface GuidanceDriftPermissionContradiction {
  kind: "permission";
  subject: GuidanceDriftPermissionSubject | null;
  claim: string;
  guidanceExcerpt: string;
  manifestFacts: string[];
  severity: GuidanceDriftSeverity;
}

export interface GuidanceDriftBehaviorContradiction {
  kind: "behavior";
  subject: GuidanceDriftSubject;
  claim: string;
  evidence: { runIds: string[]; count: number };
  suggestedAllowedLine: string;
  suggestedNotAllowedLine: string;
  severity: "warning";
}

export type GuidanceDriftContradiction = GuidanceDriftPermissionContradiction | GuidanceDriftBehaviorContradiction;

export interface ProjectToolCallGroup {
  subject: GuidanceDriftSubject;
  databaseName: string | null;
  runIds: string[];
  count: number;
  toolName?: string;
}

export interface ProjectToolCallUsageStore<Tx> {
  listProjectToolCallGroups(tx: Tx, projectItemId: string, since: Date): Promise<ProjectToolCallGroup[]>;
}

export type GuidanceDriftFindingStatus = "active" | "resolved" | "dismissed";

export interface GuidanceDriftFinding {
  id: string;
  projectItemId: string;
  fingerprint: string;
  payload: GuidanceDriftContradiction;
  status: GuidanceDriftFindingStatus;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
}

export interface UpsertActiveGuidanceDriftFindingInput {
  projectItemId: string;
  fingerprint: string;
  payload: GuidanceDriftContradiction;
  seenAt: Date;
}

/**
 * Only an insert or a resolved-to-active transition reports `transitionedToActive`; only active-to-resolved reports
 * `transitionedToResolved`. Repeated active observations only advance `lastSeenAt`. `finding.id` is the notification's
 * `sourceId`.
 */
export interface GuidanceDriftFindingStore<Tx> {
  listActive(tx: Tx, projectItemId: string): Promise<GuidanceDriftFinding[]>;
  upsertActive(
    tx: Tx,
    input: UpsertActiveGuidanceDriftFindingInput,
  ): Promise<{ finding: GuidanceDriftFinding; transitionedToActive: boolean }>;
  resolve(
    tx: Tx,
    findingId: string,
    resolvedAt: Date,
  ): Promise<{ finding: GuidanceDriftFinding; transitionedToResolved: boolean }>;
  decide(
    tx: Tx,
    findingId: string,
    decision: { status: "resolved" | "dismissed"; choice: "allow" | "forbid" | "dismiss"; userId: string; at: Date },
  ): Promise<GuidanceDriftFinding>;
}

/**
 * Renders the permission-manifest string the drift action compares byte-for-byte across its two transactions. Generic
 * over `Tx` so `packages/application` need not import a data-layer implementation.
 */
export interface GuidanceManifestPort<Tx> {
  render(tx: Tx, input: { projectItemId: string; userId: string; locale: string }): Promise<string>;
}

export interface CreateGuidanceNotificationInput {
  userId: string;
  kind: "agent_guidance_drift" | "agent_guidance_drift_resolved";
  linkHref: string;
  sourceTable: string;
  sourceId: string;
  /**
   * Dedup key for the notification writer's unique index. Must be unique per activation/resolution cycle: `finding.id`
   * and `fingerprint` survive a resolved-then-reappeared cycle, so keying on either alone would silently drop the
   * second activation's notification. Derive it from the fingerprint plus a per-cycle value (e.g.
   * `seenAt`/`resolvedAt`).
   */
  transitionInstance: string;
  payload: Record<string, unknown>;
}

/** Transaction-scoped adapter over the notification writer. */
export interface GuidanceNotificationWriter<Tx> {
  create(tx: Tx, input: CreateGuidanceNotificationInput): Promise<void>;
}

export interface RaiseGuidanceDriftProblemInput {
  userId: string;
  projectItemId: string;
  fingerprint: string;
  findingId: string;
  /** Identifies this activation cycle, like the notification's `transitionInstance`. */
  occurrenceKey: string;
}

export interface ResolveGuidanceDriftProblemInput {
  projectItemId: string;
  fingerprint: string;
}

/** Transaction-scoped adapter over a drift finding's Semp status problem. */
export interface GuidanceProblemWriter<Tx> {
  raise(tx: Tx, input: RaiseGuidanceDriftProblemInput): Promise<void>;
  /** Closes a resolved finding's problem as recovered; no active problem means no change. */
  resolve(tx: Tx, input: ResolveGuidanceDriftProblemInput): Promise<void>;
}

/**
 * SHA-256 hex of the canonical JSON of `{ projectItemId, kind, operation, mcpTool, databaseId }`. Free AI wording
 * (claim, excerpt, facts) is excluded, so a reworded report of the same problem keeps its identity.
 */
export function fingerprintGuidanceDriftSubject(
  projectItemId: string,
  kind: GuidanceDriftKind,
  subject: GuidanceDriftSubject,
): string {
  const canonical = canonicalizeJson({
    projectItemId,
    kind,
    operation: "operation" in subject ? subject.operation : null,
    mcpTool: "mcpTool" in subject ? subject.mcpTool : null,
    databaseId: subject.databaseId,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Throws if a field is missing, mistyped or empty (`kind` and `subject` may be absent in a legacy payload). Used at
 * both the AI-gateway response boundary and the `agent_guidance_drift_findings.payload` JSONB boundary, so a malformed
 * row can never pass as a typed payload.
 */
export function validateGuidanceDriftContradiction(entry: unknown, context: string): GuidanceDriftContradiction {
  if (typeof entry !== "object" || entry === null) {
    throw new Error(`${context}: contradiction is not an object`);
  }
  const { claim, guidanceExcerpt, manifestFacts, severity, kind, subject } = entry as Record<string, unknown>;

  if (kind === "behavior") {
    const { evidence, suggestedAllowedLine, suggestedNotAllowedLine } = entry as Record<string, unknown>;
    if (
      !isNonEmptyString(claim) ||
      !isNonEmptyString(suggestedAllowedLine) ||
      !isNonEmptyString(suggestedNotAllowedLine) ||
      severity !== "warning"
    ) {
      throw new Error(`${context}: invalid behavior finding`);
    }
    if (
      typeof evidence !== "object" ||
      evidence === null ||
      !("runIds" in evidence) ||
      !("count" in evidence) ||
      !Array.isArray(evidence.runIds) ||
      !evidence.runIds.every(isNonEmptyString) ||
      evidence.runIds.length === 0 ||
      new Set(evidence.runIds).size !== evidence.runIds.length ||
      typeof evidence.count !== "number" ||
      !Number.isSafeInteger(evidence.count) ||
      evidence.count < 3 ||
      evidence.runIds.length > 20 ||
      evidence.runIds.length > evidence.count
    ) {
      throw new Error(`${context}: invalid behavior evidence`);
    }
    if (typeof subject !== "object" || subject === null) throw new Error(`${context}: invalid behavior subject`);
    const candidate = subject as Record<string, unknown>;
    const parsedSubject =
      "operation" in candidate
        ? validatePermissionSubject(subject, context)
        : validateBehaviorSubject(subject, context);
    return {
      kind,
      subject: parsedSubject,
      claim,
      evidence: { runIds: evidence.runIds, count: evidence.count },
      suggestedAllowedLine,
      suggestedNotAllowedLine,
      severity,
    };
  }

  // A legacy payload has neither `kind` nor `subject`: it reads as a permission finding without a subject.
  if (kind !== undefined && kind !== "permission") {
    throw new Error(`${context}: contradiction has an invalid kind`);
  }

  if (typeof claim !== "string" || claim.length === 0) {
    throw new Error(`${context}: contradiction has an invalid claim`);
  }
  if (typeof guidanceExcerpt !== "string" || guidanceExcerpt.length === 0) {
    throw new Error(`${context}: contradiction has an invalid guidanceExcerpt`);
  }
  if (!Array.isArray(manifestFacts) || manifestFacts.length === 0) {
    throw new Error(`${context}: contradiction has invalid manifestFacts`);
  }
  const facts: unknown[] = manifestFacts;
  if (!facts.every(isNonEmptyString)) {
    throw new Error(`${context}: contradiction has invalid manifestFacts`);
  }
  if (severity !== "blocking" && severity !== "warning") {
    throw new Error(`${context}: contradiction has an invalid severity`);
  }

  return {
    kind: "permission",
    subject: subject === undefined || subject === null ? null : validatePermissionSubject(subject, context),
    claim,
    guidanceExcerpt,
    manifestFacts: facts,
    severity,
  };
}

function validateBehaviorSubject(subject: unknown, context: string): GuidanceDriftBehaviorSubject {
  if (typeof subject !== "object" || subject === null) throw new Error(`${context}: invalid behavior subject`);
  const { mcpTool, databaseId } = subject as Record<string, unknown>;
  if (!isNonEmptyString(mcpTool) || (databaseId !== null && !isNonEmptyString(databaseId)))
    throw new Error(`${context}: invalid behavior subject`);
  return { mcpTool, databaseId };
}

function validatePermissionSubject(subject: unknown, context: string): GuidanceDriftPermissionSubject {
  if (typeof subject !== "object" || subject === null) {
    throw new Error(`${context}: contradiction has an invalid subject`);
  }
  const { operation, databaseId } = subject as Record<string, unknown>;
  if (!isNonEmptyString(operation)) {
    throw new Error(`${context}: contradiction subject has an invalid operation`);
  }
  if (databaseId !== null && !isNonEmptyString(databaseId)) {
    throw new Error(`${context}: contradiction subject has an invalid databaseId`);
  }
  return { operation, databaseId };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
