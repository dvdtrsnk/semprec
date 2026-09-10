import { fingerprintGuidanceDriftContradiction, validateGuidanceDriftContradiction } from "@semprec/shared";
import type {
  AiGatewayClientPort,
  GuidanceDriftContradiction,
  GuidanceDriftFindingStore,
  GuidanceManifestPort,
  GuidanceNotificationWriter,
  GuidanceReferenceStore,
  ProjectAgentGuidanceStore,
  TransactionRunner,
} from "@semprec/shared";
import { GuidanceChangedError, GuidanceContextChangedError, GuidanceMissingError } from "./driftErrors.js";

export const AGENT_GUIDANCE_DRIFT_OPERATION = "agent_guidance_drift";

const AGENT_GUIDANCE_DRIFT_SYSTEM_INSTRUCTION =
  "Compare project guidance with mechanically enforced manifest facts. Return only schema-valid " +
  "contradictions; do not infer permissions absent from the manifest.";

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
        required: ["claim", "guidanceExcerpt", "manifestFacts", "severity"],
        properties: {
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
  manifest: GuidanceManifestPort<Tx>;
  gateway: AiGatewayClientPort;
  clock: () => Date;
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
  const { transactions, guidance, references, findings, notifications, manifest, gateway, clock } = deps;

  return async function runAgentGuidanceDriftAction({ projectItemId }) {
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

      const ranked = contradictions
        .map((contradiction) => ({
          contradiction,
          fingerprint: fingerprintGuidanceDriftContradiction(contradiction),
        }))
        .sort((a, b) => (a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0));

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
        }
      }

      const activeFindings = await findings.listActive(tx, projectItemId);
      for (const active of activeFindings) {
        if (reportedFingerprints.has(active.fingerprint)) continue;

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
  };
}

/**
 * Defensive re-validation of the gateway's response content: the gateway already enforces
 * `AGENT_GUIDANCE_DRIFT_RESPONSE_SCHEMA` server-side (issue #215's ajv compilation), but this
 * package stays neutral (no schema-validation library dependency) and never trusts a value typed
 * `unknown` without narrowing it itself.
 */
function validateContradictions(content: unknown): GuidanceDriftContradiction[] {
  if (typeof content !== "object" || content === null || !("contradictions" in content)) {
    throw new Error("agent guidance drift: gateway response missing contradictions");
  }
  const { contradictions } = content;
  if (!Array.isArray(contradictions)) {
    throw new Error("agent guidance drift: gateway response contradictions is not an array");
  }
  return contradictions.map((entry, index) =>
    validateGuidanceDriftContradiction(entry, `agent guidance drift: contradiction ${index}`),
  );
}
