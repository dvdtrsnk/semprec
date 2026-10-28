import { createHash } from "node:crypto";
import { canonicalizeJson } from "./canonicalJson.js";

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

/** A finding's identity: the only input, besides the project and kind, of its fingerprint. */
export type GuidanceDriftSubject = GuidanceDriftPermissionSubject | GuidanceDriftBehaviorSubject;

/**
 * One AI-gateway-reported contradiction between project guidance and the mechanically enforced permission manifest.
 * `subject` is `null` only for a payload stored before subjects existed.
 */
export interface GuidanceDriftContradiction {
  kind: "permission";
  subject: GuidanceDriftPermissionSubject | null;
  claim: string;
  guidanceExcerpt: string;
  manifestFacts: string[];
  severity: GuidanceDriftSeverity;
}

export type GuidanceDriftFindingStatus = "active" | "resolved";

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
 * Transaction-scoped finding store (issue #85). Only an insert or a resolved-to-active
 * transition reports `transitionedToActive: true`; only an active-to-resolved transition
 * reports `transitionedToResolved: true`. Repeated active observations of the same
 * `(projectItemId, fingerprint)` only advance `lastSeenAt`. `finding.id` is the id the caller
 * writes as a notification's `sourceId`.
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
}

/**
 * Renders the exact permission-manifest string the drift action compares byte-for-byte across
 * its two transactions. Generic over `Tx` so `packages/application` can depend on it without
 * importing a concrete data-layer implementation (dependency-cruiser's
 * `no-application-gateway-implementation-import`-style neutrality rule).
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
   * Dedup key for the underlying notification writer's `(sourceTable, sourceId, kind,
   * transitionInstance)` unique index. Must be unique per activation/resolution *cycle*, not
   * just per fingerprint: `finding.id` and `fingerprint` are both stable across a
   * resolved-then-reappeared cycle, so keying on either alone would cause the second
   * activation's notification to collide with the first and be silently dropped. Callers should
   * derive this from the fingerprint plus something that changes across cycles (e.g. this run's
   * `seenAt`/`resolvedAt` timestamp).
   */
  transitionInstance: string;
  payload: Record<string, unknown>;
}

/** Transaction-scoped adapter over #36/#237's notification writer (issue #85). */
export interface GuidanceNotificationWriter<Tx> {
  create(tx: Tx, input: CreateGuidanceNotificationInput): Promise<void>;
}

/**
 * Fingerprints a finding by its subject only (SHA-256 hex of the canonical JSON of
 * `{ projectItemId, kind, operation, mcpTool, databaseId }`). Nothing the AI words freely
 * (claim, excerpt, facts) enters it, so a reworded report of the same problem keeps its identity.
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
 * Narrows an `unknown` value to a `GuidanceDriftContradiction`, throwing if any field is missing,
 * the wrong type, or empty (`kind` and `subject` may be absent: legacy payload, see the type). Shared by both the AI-gateway response boundary
 * (`driftAction.ts`, which validates defensively even though the gateway already enforces this
 * schema server-side) and the `agent_guidance_drift_findings.payload` JSONB boundary
 * (`agentGuidanceDriftFindingsStore.ts`'s `mapRow`), so a malformed row from a direct DB patch or
 * schema evolution can never be passed through as a typed `GuidanceDriftFinding.payload` silently.
 */
export function validateGuidanceDriftContradiction(entry: unknown, context: string): GuidanceDriftContradiction {
  if (typeof entry !== "object" || entry === null) {
    throw new Error(`${context}: contradiction is not an object`);
  }
  const { claim, guidanceExcerpt, manifestFacts, severity, kind, subject } = entry as Record<string, unknown>;

  // A payload stored before `kind`/`subject` existed has neither: it reads as a permission finding
  // without a subject.
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
