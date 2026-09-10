import { createHash } from "node:crypto";
import { canonicalizeJson, compareByCodePoint } from "./canonicalJson.js";

export type GuidanceDriftSeverity = "blocking" | "warning";

/** One AI-gateway-reported contradiction between project guidance and the mechanically enforced permission manifest. */
export interface GuidanceDriftContradiction {
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
 * Fingerprints one contradiction (issue #85): `manifestFacts` sorted ascending by Unicode code
 * point, then `{ claim, guidanceExcerpt, manifestFacts, severity }` canonically serialized (sorted
 * object keys, no whitespace) and SHA-256 hashed. Deterministic under reordering of
 * `manifestFacts`, of the contradiction's own object keys (moot here since this function builds
 * the object itself), or of the list of contradictions the caller sorts by fingerprint before
 * writing — this is the "implement it once" self-contained algorithm the issue calls for, with no
 * external canonicalization spec or library involved.
 */
export function fingerprintGuidanceDriftContradiction(contradiction: GuidanceDriftContradiction): string {
  const normalized = {
    claim: contradiction.claim,
    guidanceExcerpt: contradiction.guidanceExcerpt,
    manifestFacts: [...contradiction.manifestFacts].sort(compareByCodePoint),
    severity: contradiction.severity,
  };
  const canonical = canonicalizeJson(normalized);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Narrows an `unknown` value to a `GuidanceDriftContradiction`, throwing if any field is missing,
 * the wrong type, or empty. Shared by both the AI-gateway response boundary
 * (`driftAction.ts`, which validates defensively even though the gateway already enforces this
 * schema server-side) and the `agent_guidance_drift_findings.payload` JSONB boundary
 * (`agentGuidanceDriftFindingsStore.ts`'s `mapRow`), so a malformed row from a direct DB patch or
 * schema evolution can never be passed through as a typed `GuidanceDriftFinding.payload` silently.
 */
export function validateGuidanceDriftContradiction(entry: unknown, context: string): GuidanceDriftContradiction {
  if (typeof entry !== "object" || entry === null) {
    throw new Error(`${context}: contradiction is not an object`);
  }
  const { claim, guidanceExcerpt, manifestFacts, severity } = entry as Record<string, unknown>;

  if (typeof claim !== "string" || claim.length === 0) {
    throw new Error(`${context}: contradiction has an invalid claim`);
  }
  if (typeof guidanceExcerpt !== "string" || guidanceExcerpt.length === 0) {
    throw new Error(`${context}: contradiction has an invalid guidanceExcerpt`);
  }
  if (
    !Array.isArray(manifestFacts) ||
    manifestFacts.length === 0 ||
    !manifestFacts.every((fact) => typeof fact === "string" && fact.length > 0)
  ) {
    throw new Error(`${context}: contradiction has invalid manifestFacts`);
  }
  if (severity !== "blocking" && severity !== "warning") {
    throw new Error(`${context}: contradiction has an invalid severity`);
  }

  return { claim, guidanceExcerpt, manifestFacts, severity };
}
