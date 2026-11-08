import {
  BEHAVIOR_DRIFT_INPUT_BYTES,
  BEHAVIOR_DRIFT_MIN_RUNS,
  BEHAVIOR_DRIFT_WINDOW_DAYS,
  compareByCodePoint,
  createLogger,
  fingerprintGuidanceDriftSubject,
  validateGuidanceDriftContradiction,
  parseProjectAgentGuidanceMarkdown,
} from "@semprec/shared";
import type {
  AiGatewayClientPort,
  GuidanceDriftPermissionContradiction,
  GuidanceDriftFindingStore,
  GuidanceDriftPermissionSubject,
  GuidanceManifestPort,
  GuidanceNotificationWriter,
  GuidanceProblemWriter,
  GuidanceReferenceStore,
  ProjectToolCallUsageStore,
  ProjectAgentGuidanceStore,
  TransactionRunner,
} from "@semprec/shared";
import { GuidanceChangedError, GuidanceContextChangedError, GuidanceMissingError } from "./driftErrors.js";

export const AGENT_GUIDANCE_DRIFT_OPERATION = "agent_guidance_drift";
const logger = createLogger("agent-guidance-drift");

const AGENT_GUIDANCE_DRIFT_SYSTEM_INSTRUCTION =
  "Compare project guidance with mechanically enforced manifest facts. Return only schema-valid " +
  "contradictions; do not infer permissions absent from the manifest. For each contradiction set " +
  "subject.operation to the manifest operation the guidance contradicts and subject.databaseId to the " +
  "target database id, or null when the contradiction is not database specific. Copy both values " +
  "verbatim from the manifest; never invent them.";

/** Draft 2020-12 JSON Schema for the gateway's structured completion (validated server-side, issue #215). */
const AGENT_GUIDANCE_DRIFT_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["contradictions"],
  properties: {
    contradictions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["claim", "guidanceExcerpt", "manifestFacts", "severity", "subject"],
        properties: {
          subject: {
            type: "object",
            additionalProperties: false,
            required: ["operation", "databaseId"],
            properties: {
              operation: { type: "string", minLength: 1 },
              databaseId: { type: ["string", "null"], minLength: 1 },
            },
          },
          claim: { type: "string", minLength: 1 },
          guidanceExcerpt: { type: "string", minLength: 1 },
          manifestFacts: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
          severity: { type: "string", enum: ["blocking", "warning"] },
        },
      },
    },
  },
} as const;

export interface AgentGuidanceDriftActionDeps<Tx> {
  transactions: TransactionRunner<Tx>;
  guidance: ProjectAgentGuidanceStore<Tx>;
  references: GuidanceReferenceStore<Tx>;
  findings: GuidanceDriftFindingStore<Tx>;
  notifications: GuidanceNotificationWriter<Tx>;
  problems: GuidanceProblemWriter<Tx>;
  manifest: GuidanceManifestPort<Tx>;
  gateway: AiGatewayClientPort;
  clock: () => Date;
  toolCallUsage: ProjectToolCallUsageStore<Tx>;
}

export interface AgentGuidanceDriftActionInput {
  projectItemId: string;
}

/**
 * `core.agentGuidanceDrift` (issue #85): semantically compares a project's hand-written guidance
 * (#214) against the mechanically enforced permission manifest (#147), and reconciles the
 * project's drift findings and their owner notifications against that comparison's result.
 *
 * Two `repeatable read` transactions bracket one non-transactional gateway call (issue #215's
 * `AiGatewayClientPort.complete`, which cannot itself run inside a DB transaction):
 *
 * 1. **Read transaction** — captures one consistent snapshot: the guidance row (so its
 *    `ownerUserId`/`updatedAt` can be checked for staleness later), its markdown, the owner's
 *    locale, and a canonicalized render of the permission manifest for that project/locale.
 * 2. **Gateway call** — outside any transaction; a failure here propagates with no state change.
 * 3. **Write transaction** — reloads the guidance row and requires its `ownerUserId`/`updatedAt`
 *    to match the captured snapshot (otherwise: `guidance_changed`, no writes), re-renders the
 *    manifest and requires it to equal the captured string byte-for-byte (otherwise:
 *    `guidance_context_changed`, no writes) — only then persists findings and fans out
 *    notifications. This is what makes gateway output computed against a guidance/permission
 *    state that mutated mid-call get discarded rather than silently applied against newer state.
 */
export function createAgentGuidanceDriftAction<Tx>(
  deps: AgentGuidanceDriftActionDeps<Tx>,
): (input: AgentGuidanceDriftActionInput) => Promise<void> {
  const { transactions, guidance, references, findings, notifications, problems, manifest, gateway, clock } = deps;

  async function runPermission({ projectItemId }: AgentGuidanceDriftActionInput): Promise<void> {
    const snapshot = await transactions.withTransaction({ isolation: "repeatable_read" }, async (tx) => {
      const row = await guidance.load(tx, projectItemId);
      if (!row) throw new GuidanceMissingError(projectItemId);

      const locale = await references.requireUserLocale(tx, row.ownerUserId);
      const permissionManifest = await manifest.render(tx, { projectItemId, userId: row.ownerUserId, locale });

      return {
        projectItemId,
        ownerUserId: row.ownerUserId,
        guidanceUpdatedAt: row.updatedAt,
        markdown: row.markdown,
        locale,
        permissionManifest,
      };
    });

    const result = await gateway.complete({
      projectItemId: snapshot.projectItemId,
      operation: AGENT_GUIDANCE_DRIFT_OPERATION,
      temperature: 0,
      system: AGENT_GUIDANCE_DRIFT_SYSTEM_INSTRUCTION,
      messages: [
        {
          role: "user",
          content:
            `GUIDANCE\n${snapshot.markdown}\nEND GUIDANCE\n\n` +
            `PERMISSION_MANIFEST\n${snapshot.permissionManifest}\nEND PERMISSION_MANIFEST`,
        },
      ],
      responseSchema: AGENT_GUIDANCE_DRIFT_RESPONSE_SCHEMA,
    });

    const contradictions = validateContradictions(result.content);
    const seenAt = clock();

    await transactions.withTransaction({ isolation: "repeatable_read" }, async (tx) => {
      const current = await guidance.load(tx, projectItemId);
      if (!current) throw new GuidanceMissingError(projectItemId);
      if (current.ownerUserId !== snapshot.ownerUserId || current.updatedAt !== snapshot.guidanceUpdatedAt) {
        throw new GuidanceChangedError(projectItemId);
      }

      const currentManifest = await manifest.render(tx, {
        projectItemId,
        userId: snapshot.ownerUserId,
        locale: snapshot.locale,
      });
      if (currentManifest !== snapshot.permissionManifest) {
        throw new GuidanceContextChangedError(projectItemId);
      }

      const ranked = [...dedupeBySubject(projectItemId, contradictions).values()].sort((a, b) =>
        a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0,
      );

      const reportedFingerprints = new Set(ranked.map((entry) => entry.fingerprint));
      const linkHref = `/projects/${projectItemId}/agent-guidance`;

      for (const { contradiction, fingerprint } of ranked) {
        const { finding, transitionedToActive } = await findings.upsertActive(tx, {
          projectItemId,
          fingerprint,
          payload: contradiction,
          seenAt,
        });

        if (transitionedToActive) {
          await notifications.create(tx, {
            userId: snapshot.ownerUserId,
            kind: "agent_guidance_drift",
            linkHref,
            sourceTable: "agent_guidance_drift_findings",
            sourceId: finding.id,
            // Scoped to this activation cycle (not just the fingerprint) so a finding that
            // resolves and later reappears gets a fresh notification instead of colliding with
            // its original activation's dedup key.
            transitionInstance: `${fingerprint}:${seenAt.toISOString()}`,
            payload: {
              projectItemId,
              fingerprint,
              claim: contradiction.claim,
              guidanceExcerpt: contradiction.guidanceExcerpt,
              manifestFacts: contradiction.manifestFacts,
              severity: contradiction.severity,
            },
          });
          await problems.raise(tx, {
            userId: snapshot.ownerUserId,
            projectItemId,
            fingerprint,
            findingId: finding.id,
            occurrenceKey: `${fingerprint}:${seenAt.toISOString()}`,
          });
        }
      }

      const activeFindings = await findings.listActive(tx, projectItemId);
      for (const active of activeFindings) {
        if (active.payload.kind !== "permission" || reportedFingerprints.has(active.fingerprint)) continue;

        const { finding, transitionedToResolved } = await findings.resolve(tx, active.id, seenAt);
        if (transitionedToResolved) {
          await notifications.create(tx, {
            userId: snapshot.ownerUserId,
            kind: "agent_guidance_drift_resolved",
            linkHref,
            sourceTable: "agent_guidance_drift_findings",
            sourceId: finding.id,
            // Scoped to this resolution cycle for the same reason as the active-transition
            // notification above: the same finding can resolve more than once over its lifetime.
            transitionInstance: `${active.fingerprint}:${seenAt.toISOString()}`,
            payload: { projectItemId, fingerprint: active.fingerprint },
          });
        }
      }
    });
  }

  return async function runAgentGuidanceDriftAction(input) {
    let permissionError: unknown;
    let permissionFailed = false;
    try {
      await runPermission(input);
    } catch (error) {
      permissionFailed = true;
      permissionError = error;
    }
    try {
      await runBehaviorPass(deps, input.projectItemId);
    } catch (error) {
      if (permissionFailed) {
        logger.error(
          { errorName: error instanceof Error ? error.name : "UnknownError", projectItemId: input.projectItemId },
          "Behavior drift pass also failed",
        );
        throw permissionError;
      }
      throw error;
    }
    if (permissionFailed) throw permissionError;
  };
}

/**
 * Defensive re-validation of the gateway's response content: the gateway already enforces
 * `AGENT_GUIDANCE_DRIFT_RESPONSE_SCHEMA` server-side (issue #215's ajv compilation), but this
 * package stays neutral (no schema-validation library dependency) and never trusts a value typed
 * `unknown` without narrowing it itself.
 */
type SubjectContradiction = GuidanceDriftPermissionContradiction & { subject: GuidanceDriftPermissionSubject };

function validateContradictions(content: unknown): SubjectContradiction[] {
  if (typeof content !== "object" || content === null || !("contradictions" in content)) {
    throw new Error("agent guidance drift: gateway response missing contradictions");
  }
  const { contradictions } = content;
  if (!Array.isArray(contradictions)) {
    throw new Error("agent guidance drift: gateway response contradictions is not an array");
  }
  return contradictions.map((entry, index) => {
    const context = `agent guidance drift: contradiction ${index}`;
    const contradiction = validateGuidanceDriftContradiction(entry, context);
    if (contradiction.kind !== "permission") throw new Error(`${context}: invalid contradiction kind`);
    if (contradiction.subject === null) throw new Error(`${context}: contradiction is missing its subject`);
    return { ...contradiction, subject: contradiction.subject };
  });
}

interface RankedContradiction {
  contradiction: GuidanceDriftPermissionContradiction;
  fingerprint: string;
}

/**
 * Findings are unique per fingerprint, so contradictions sharing a subject collapse into one:
 * the higher severity wins, and equal severities fall back to the smaller claim so the outcome
 * does not depend on the AI's report order.
 */
function dedupeBySubject(
  projectItemId: string,
  contradictions: SubjectContradiction[],
): Map<string, RankedContradiction> {
  const byFingerprint = new Map<string, RankedContradiction>();
  for (const contradiction of contradictions) {
    const fingerprint = fingerprintGuidanceDriftSubject(projectItemId, contradiction.kind, contradiction.subject);
    const kept = byFingerprint.get(fingerprint);
    if (!kept || outranks(contradiction, kept.contradiction)) {
      byFingerprint.set(fingerprint, { contradiction, fingerprint });
    }
  }
  return byFingerprint;
}

function outranks(
  candidate: GuidanceDriftPermissionContradiction,
  kept: GuidanceDriftPermissionContradiction,
): boolean {
  if (candidate.severity !== kept.severity) return candidate.severity === "blocking";
  return compareByCodePoint(candidate.claim, kept.claim) < 0;
}

export { BEHAVIOR_DRIFT_MIN_RUNS, BEHAVIOR_DRIFT_WINDOW_DAYS } from "@semprec/shared";
const BEHAVIOR_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["fingerprint", "claim", "suggestedAllowedLine", "suggestedNotAllowedLine"],
        properties: {
          fingerprint: { type: "string", minLength: 1 },
          claim: { type: "string", minLength: 1 },
          suggestedAllowedLine: { type: "string", minLength: 1 },
          suggestedNotAllowedLine: { type: "string", minLength: 1 },
        },
      },
    },
  },
} as const;

async function runBehaviorPass<Tx>(deps: AgentGuidanceDriftActionDeps<Tx>, projectItemId: string): Promise<void> {
  const now = deps.clock();
  const since = new Date(now.getTime() - BEHAVIOR_DRIFT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const snapshot = await deps.transactions.withTransaction({ isolation: "repeatable_read" }, async (tx) => {
    const guidance = await deps.guidance.load(tx, projectItemId);
    if (!guidance) throw new GuidanceMissingError(projectItemId);
    const locale = await deps.references.requireUserLocale(tx, guidance.ownerUserId);
    const groups = (await deps.toolCallUsage.listProjectToolCallGroups(tx, projectItemId, since))
      .filter((group) => group.count >= BEHAVIOR_DRIFT_MIN_RUNS)
      .map((group) => ({
        ...group,
        fingerprint: fingerprintGuidanceDriftSubject(projectItemId, "behavior", group.subject),
      }));
    return { guidance, locale, groups, sections: parseProjectAgentGuidanceMarkdown(guidance.markdown) };
  });
  const byFingerprint = new Map(snapshot.groups.map((group) => [group.fingerprint, group]));
  const reported = new Map<string, { claim: string; suggestedAllowedLine: string; suggestedNotAllowedLine: string }>();
  if (snapshot.groups.length) {
    const request = {
      projectItemId,
      operation: "agent_behavior_drift",
      temperature: 0,
      system:
        "Report only groups not mentioned in either guidance section. Write claim and both suggested lines in the owner's language. Copy each fingerprint exactly.",
      messages: [
        {
          role: "user" as const,
          content: JSON.stringify({
            locale: snapshot.locale,
            allowed: snapshot.sections.allowed,
            notAllowed: snapshot.sections.notAllowed,
            groups: snapshot.groups.map(({ fingerprint, subject, databaseName, count, toolName }) => ({
              fingerprint,
              subject,
              databaseName,
              count,
              toolName,
            })),
          }),
        },
      ],
      responseSchema: BEHAVIOR_SCHEMA,
    };
    if (Buffer.byteLength(JSON.stringify(request), "utf8") > BEHAVIOR_DRIFT_INPUT_BYTES)
      throw new Error("Behavior drift gateway request exceeds its limit");
    const result = await deps.gateway.complete(request);
    const content = result.content;
    if (typeof content !== "object" || content === null || !("findings" in content) || !Array.isArray(content.findings))
      throw new Error("Invalid behavior drift response");
    const entries: unknown[] = content.findings;
    for (const entry of entries) {
      if (
        typeof entry !== "object" ||
        entry === null ||
        !("fingerprint" in entry) ||
        !("claim" in entry) ||
        !("suggestedAllowedLine" in entry) ||
        !("suggestedNotAllowedLine" in entry) ||
        typeof entry.fingerprint !== "string" ||
        !byFingerprint.has(entry.fingerprint) ||
        reported.has(entry.fingerprint) ||
        typeof entry.claim !== "string" ||
        !entry.claim ||
        typeof entry.suggestedAllowedLine !== "string" ||
        !entry.suggestedAllowedLine ||
        typeof entry.suggestedNotAllowedLine !== "string" ||
        !entry.suggestedNotAllowedLine
      )
        throw new Error("Invalid behavior drift finding");
      reported.set(entry.fingerprint, {
        claim: entry.claim,
        suggestedAllowedLine: entry.suggestedAllowedLine,
        suggestedNotAllowedLine: entry.suggestedNotAllowedLine,
      });
    }
  }
  await deps.transactions.withTransaction({ isolation: "repeatable_read" }, async (tx) => {
    const current = await deps.guidance.loadForUpdate(tx, projectItemId);
    if (!current) throw new GuidanceMissingError(projectItemId);
    if (current.ownerUserId !== snapshot.guidance.ownerUserId || current.updatedAt !== snapshot.guidance.updatedAt)
      throw new GuidanceChangedError(projectItemId);
    const linkHref = `/projects/${projectItemId}/agent-guidance`;
    for (const [fingerprint, output] of reported) {
      const group = byFingerprint.get(fingerprint);
      if (!group) throw new Error("Missing behavior group");
      const payload = {
        kind: "behavior" as const,
        subject: group.subject,
        ...output,
        evidence: { runIds: group.runIds, count: group.count },
        severity: "warning" as const,
      };
      const { finding, transitionedToActive } = await deps.findings.upsertActive(tx, {
        projectItemId,
        fingerprint,
        payload,
        seenAt: now,
      });
      if (transitionedToActive) {
        await deps.notifications.create(tx, {
          userId: current.ownerUserId,
          kind: "agent_guidance_drift",
          linkHref,
          sourceTable: "agent_guidance_drift_findings",
          sourceId: finding.id,
          transitionInstance: `${fingerprint}:${now.toISOString()}`,
          payload: {
            projectItemId,
            fingerprint,
            kind: "behavior",
            ...output,
            evidence: payload.evidence,
            severity: "warning",
          },
        });
        await deps.problems.raise(tx, {
          userId: current.ownerUserId,
          projectItemId,
          fingerprint,
          findingId: finding.id,
          occurrenceKey: `${fingerprint}:${now.toISOString()}`,
        });
      }
    }
    for (const active of await deps.findings.listActive(tx, projectItemId)) {
      if (active.payload.kind !== "behavior" || reported.has(active.fingerprint)) continue;
      const { finding, transitionedToResolved } = await deps.findings.resolve(tx, active.id, now);
      if (transitionedToResolved)
        await deps.notifications.create(tx, {
          userId: current.ownerUserId,
          kind: "agent_guidance_drift_resolved",
          linkHref,
          sourceTable: "agent_guidance_drift_findings",
          sourceId: finding.id,
          transitionInstance: `${active.fingerprint}:${now.toISOString()}`,
          payload: { projectItemId, fingerprint: active.fingerprint, kind: "behavior" },
        });
    }
  });
}
