import { describe, expect, it, vi } from "vitest";
import type {
  AiGatewayClientPort,
  AiGatewayCompletionResult,
  CreateGuidanceNotificationInput,
  GuidanceDriftContradiction,
  GuidanceDriftFinding,
  GuidanceDriftFindingStore,
  GuidanceManifestPort,
  GuidanceNotificationWriter,
  GuidanceReferenceStore,
  ProjectAgentGuidance,
  ProjectAgentGuidanceStore,
  TransactionRunner,
} from "@semprec/shared";
import { fingerprintGuidanceDriftContradiction } from "@semprec/shared";
import { createAgentGuidanceDriftAction } from "../driftAction.js";
import { GuidanceChangedError, GuidanceContextChangedError, GuidanceMissingError } from "../driftErrors.js";

type FakeTx = { phase: "read" | "write" };

function fakeTransactions(): TransactionRunner<FakeTx> {
  return {
    async withTransaction(options, work) {
      return work({ phase: options.isolation === "repeatable_read" ? "read" : "write" });
    },
  };
}

function fakeGuidance(initial: ProjectAgentGuidance | null): ProjectAgentGuidanceStore<FakeTx> & {
  row: ProjectAgentGuidance | null;
} {
  const state = { row: initial };
  return {
    get row() {
      return state.row;
    },
    set row(value) {
      state.row = value;
    },
    async load() {
      return state.row;
    },
    async upsert() {
      throw new Error("not used by driftAction");
    },
    async transfer() {
      throw new Error("not used by driftAction");
    },
  };
}

function fakeReferences(locale = "en"): GuidanceReferenceStore<FakeTx> {
  return {
    requireProjectsItem: vi.fn(async () => {}),
    requireUser: vi.fn(async () => {}),
    requireUserLocale: vi.fn(async () => locale),
  };
}

function fakeManifest(initial = "manifest-v1"): GuidanceManifestPort<FakeTx> & { value: string } {
  const state = { value: initial };
  return {
    get value() {
      return state.value;
    },
    set value(next) {
      state.value = next;
    },
    async render() {
      return state.value;
    },
  };
}

function fakeFindings(): GuidanceDriftFindingStore<FakeTx> & { rows: Map<string, GuidanceDriftFinding> } {
  const rows = new Map<string, GuidanceDriftFinding>();
  let nextId = 1;
  return {
    rows,
    async listActive(_tx, projectItemId) {
      return [...rows.values()].filter((row) => row.projectItemId === projectItemId && row.status === "active");
    },
    async upsertActive(_tx, input) {
      const key = `${input.projectItemId}:${input.fingerprint}`;
      const existing = rows.get(key);
      if (!existing) {
        const finding: GuidanceDriftFinding = {
          id: `finding-${nextId++}`,
          projectItemId: input.projectItemId,
          fingerprint: input.fingerprint,
          payload: input.payload,
          status: "active",
          firstSeenAt: input.seenAt.toISOString(),
          lastSeenAt: input.seenAt.toISOString(),
          resolvedAt: null,
        };
        rows.set(key, finding);
        return { finding, transitionedToActive: true };
      }
      const wasResolved = existing.status === "resolved";
      const updated: GuidanceDriftFinding = {
        ...existing,
        status: "active",
        payload: input.payload,
        lastSeenAt: input.seenAt.toISOString(),
        resolvedAt: null,
      };
      rows.set(key, updated);
      return { finding: updated, transitionedToActive: wasResolved };
    },
    async resolve(_tx, findingId, resolvedAt) {
      const entry = [...rows.entries()].find(([, row]) => row.id === findingId);
      if (!entry) throw new Error(`finding ${findingId} not found`);
      const [key, existing] = entry;
      const wasActive = existing.status === "active";
      const updated: GuidanceDriftFinding = {
        ...existing,
        status: "resolved",
        lastSeenAt: resolvedAt.toISOString(),
        resolvedAt: resolvedAt.toISOString(),
      };
      rows.set(key, updated);
      return { finding: updated, transitionedToResolved: wasActive };
    },
  };
}

function fakeNotifications(): GuidanceNotificationWriter<FakeTx> & { created: CreateGuidanceNotificationInput[] } {
  const created: CreateGuidanceNotificationInput[] = [];
  return {
    created,
    async create(_tx, input) {
      created.push(input);
    },
  };
}

function fakeGateway(
  respond: () => Promise<GuidanceDriftContradiction[]> | GuidanceDriftContradiction[],
): AiGatewayClientPort {
  return {
    async complete(): Promise<AiGatewayCompletionResult> {
      const contradictions = await respond();
      return { content: { contradictions }, usage: { inputTokens: 10, outputTokens: 10 } };
    },
  };
}

const CONTRADICTION_A: GuidanceDriftContradiction = {
  claim: "The agent can delete files without approval.",
  guidanceExcerpt: "Agents may delete any file directly.",
  manifestFacts: ["capability.files.delete requires approval"],
  severity: "blocking",
};

const CONTRADICTION_B: GuidanceDriftContradiction = {
  claim: "The agent can read every mailbox.",
  guidanceExcerpt: "Agents may read all mail.",
  manifestFacts: ["capability.mail.read scoped to owned mailboxes"],
  severity: "warning",
};

function baseGuidanceRow(overrides: Partial<ProjectAgentGuidance> = {}): ProjectAgentGuidance {
  return {
    projectItemId: "project-1",
    ownerUserId: "owner-1",
    markdown: "# Guidance",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("createAgentGuidanceDriftAction (issue #85)", () => {
  it("creates a finding and notifies the owner for a new contradiction", async () => {
    const guidance = fakeGuidance(baseGuidanceRow());
    const findings = fakeFindings();
    const notifications = fakeNotifications();
    const action = createAgentGuidanceDriftAction({
      transactions: fakeTransactions(),
      guidance,
      references: fakeReferences(),
      findings,
      notifications,
      manifest: fakeManifest(),
      gateway: fakeGateway(() => [CONTRADICTION_A]),
      clock: () => new Date("2026-02-01T00:00:00.000Z"),
    });

    await action({ projectItemId: "project-1" });

    expect(findings.rows.size).toBe(1);
    expect(notifications.created).toHaveLength(1);
    expect(notifications.created[0]).toMatchObject({
      userId: "owner-1",
      kind: "agent_guidance_drift",
      linkHref: "/projects/project-1/agent-guidance",
      sourceTable: "agent_guidance_drift_findings",
      payload: {
        projectItemId: "project-1",
        claim: CONTRADICTION_A.claim,
        guidanceExcerpt: CONTRADICTION_A.guidanceExcerpt,
        manifestFacts: CONTRADICTION_A.manifestFacts,
        severity: CONTRADICTION_A.severity,
      },
    });
  });

  it("does not re-notify when the same finding is observed again", async () => {
    const guidance = fakeGuidance(baseGuidanceRow());
    const findings = fakeFindings();
    const notifications = fakeNotifications();
    const action = createAgentGuidanceDriftAction({
      transactions: fakeTransactions(),
      guidance,
      references: fakeReferences(),
      findings,
      notifications,
      manifest: fakeManifest(),
      gateway: fakeGateway(() => [CONTRADICTION_A]),
      clock: () => new Date("2026-02-01T00:00:00.000Z"),
    });

    await action({ projectItemId: "project-1" });
    await action({ projectItemId: "project-1" });

    expect(findings.rows.size).toBe(1);
    expect(notifications.created).toHaveLength(1);
  });

  it("resolves a finding and notifies once the contradiction disappears", async () => {
    const guidance = fakeGuidance(baseGuidanceRow());
    const findings = fakeFindings();
    const notifications = fakeNotifications();
    let respondWithContradiction = true;
    const action = createAgentGuidanceDriftAction({
      transactions: fakeTransactions(),
      guidance,
      references: fakeReferences(),
      findings,
      notifications,
      manifest: fakeManifest(),
      gateway: fakeGateway(() => (respondWithContradiction ? [CONTRADICTION_A] : [])),
      clock: () => new Date("2026-02-01T00:00:00.000Z"),
    });

    await action({ projectItemId: "project-1" });
    respondWithContradiction = false;
    await action({ projectItemId: "project-1" });

    const finding = [...findings.rows.values()][0];
    expect(finding).toBeDefined();
    expect(finding?.status).toBe("resolved");
    expect(notifications.created).toHaveLength(2);
    expect(notifications.created[1]).toMatchObject({
      userId: "owner-1",
      kind: "agent_guidance_drift_resolved",
      payload: { projectItemId: "project-1", fingerprint: fingerprintGuidanceDriftContradiction(CONTRADICTION_A) },
    });
  });

  it("dedupes and resolves identically regardless of the contradictions' report order", async () => {
    const guidanceA = fakeGuidance(baseGuidanceRow({ projectItemId: "project-a" }));
    const findingsA = fakeFindings();
    const actionA = createAgentGuidanceDriftAction({
      transactions: fakeTransactions(),
      guidance: guidanceA,
      references: fakeReferences(),
      findings: findingsA,
      notifications: fakeNotifications(),
      manifest: fakeManifest(),
      gateway: fakeGateway(() => [CONTRADICTION_A, CONTRADICTION_B]),
      clock: () => new Date("2026-02-01T00:00:00.000Z"),
    });

    const guidanceB = fakeGuidance(baseGuidanceRow({ projectItemId: "project-a" }));
    const findingsB = fakeFindings();
    const actionB = createAgentGuidanceDriftAction({
      transactions: fakeTransactions(),
      guidance: guidanceB,
      references: fakeReferences(),
      findings: findingsB,
      notifications: fakeNotifications(),
      manifest: fakeManifest(),
      gateway: fakeGateway(() => [CONTRADICTION_B, CONTRADICTION_A]),
      clock: () => new Date("2026-02-01T00:00:00.000Z"),
    });

    await actionA({ projectItemId: "project-a" });
    await actionB({ projectItemId: "project-a" });

    const fingerprintsA = [...findingsA.rows.values()].map((row) => row.fingerprint).sort();
    const fingerprintsB = [...findingsB.rows.values()].map((row) => row.fingerprint).sort();
    expect(fingerprintsA).toEqual(fingerprintsB);
  });

  it("discards stale gateway output when the guidance row changes mid-call, with no writes", async () => {
    const guidance = fakeGuidance(baseGuidanceRow());
    const findings = fakeFindings();
    const notifications = fakeNotifications();
    const action = createAgentGuidanceDriftAction({
      transactions: fakeTransactions(),
      guidance,
      references: fakeReferences(),
      findings,
      notifications,
      manifest: fakeManifest(),
      gateway: fakeGateway(() => {
        // Simulates a concurrent guidance rewrite landing while the (non-transactional)
        // gateway call is in flight.
        guidance.row = baseGuidanceRow({ updatedAt: "2026-01-02T00:00:00.000Z" });
        return [CONTRADICTION_A];
      }),
      clock: () => new Date("2026-02-01T00:00:00.000Z"),
    });

    await expect(action({ projectItemId: "project-1" })).rejects.toBeInstanceOf(GuidanceChangedError);
    expect(findings.rows.size).toBe(0);
    expect(notifications.created).toHaveLength(0);
  });

  it("discards stale gateway output when the permission manifest changes mid-call, with no writes", async () => {
    const guidance = fakeGuidance(baseGuidanceRow());
    const findings = fakeFindings();
    const notifications = fakeNotifications();
    const manifest = fakeManifest();
    const action = createAgentGuidanceDriftAction({
      transactions: fakeTransactions(),
      guidance,
      references: fakeReferences(),
      findings,
      notifications,
      manifest,
      gateway: fakeGateway(() => {
        // A concurrent permission mutation (e.g. a heartbeat/capability change) while the
        // gateway call is in flight — the guidance row itself is untouched.
        manifest.value = "manifest-v2";
        return [CONTRADICTION_A];
      }),
      clock: () => new Date("2026-02-01T00:00:00.000Z"),
    });

    await expect(action({ projectItemId: "project-1" })).rejects.toBeInstanceOf(GuidanceContextChangedError);
    expect(findings.rows.size).toBe(0);
    expect(notifications.created).toHaveLength(0);
  });

  it("fails cleanly with no writes when guidance is missing", async () => {
    const guidance = fakeGuidance(null);
    const findings = fakeFindings();
    const notifications = fakeNotifications();
    const gateway = { complete: vi.fn() };
    const action = createAgentGuidanceDriftAction({
      transactions: fakeTransactions(),
      guidance,
      references: fakeReferences(),
      findings,
      notifications,
      manifest: fakeManifest(),
      gateway,
      clock: () => new Date("2026-02-01T00:00:00.000Z"),
    });

    await expect(action({ projectItemId: "project-1" })).rejects.toBeInstanceOf(GuidanceMissingError);
    expect(gateway.complete).not.toHaveBeenCalled();
    expect(findings.rows.size).toBe(0);
    expect(notifications.created).toHaveLength(0);
  });

  it("fails cleanly with no writes when guidance disappears before the write transaction", async () => {
    const guidance = fakeGuidance(baseGuidanceRow());
    const findings = fakeFindings();
    const notifications = fakeNotifications();
    const action = createAgentGuidanceDriftAction({
      transactions: fakeTransactions(),
      guidance,
      references: fakeReferences(),
      findings,
      notifications,
      manifest: fakeManifest(),
      gateway: fakeGateway(() => {
        guidance.row = null;
        return [CONTRADICTION_A];
      }),
      clock: () => new Date("2026-02-01T00:00:00.000Z"),
    });

    await expect(action({ projectItemId: "project-1" })).rejects.toBeInstanceOf(GuidanceMissingError);
    expect(findings.rows.size).toBe(0);
    expect(notifications.created).toHaveLength(0);
  });

  it("propagates a gateway failure with no state change and never treats it as no-drift", async () => {
    const guidance = fakeGuidance(baseGuidanceRow());
    const findings = fakeFindings();
    const notifications = fakeNotifications();
    const gatewayError = new Error("gateway unavailable");
    const action = createAgentGuidanceDriftAction({
      transactions: fakeTransactions(),
      guidance,
      references: fakeReferences(),
      findings,
      notifications,
      manifest: fakeManifest(),
      gateway: { complete: vi.fn(async () => Promise.reject(gatewayError)) },
      clock: () => new Date("2026-02-01T00:00:00.000Z"),
    });

    await expect(action({ projectItemId: "project-1" })).rejects.toBe(gatewayError);
    expect(findings.rows.size).toBe(0);
    expect(notifications.created).toHaveLength(0);
  });

  it("rejects a gateway response with an empty manifestFacts array", async () => {
    const guidance = fakeGuidance(baseGuidanceRow());
    const action = createAgentGuidanceDriftAction({
      transactions: fakeTransactions(),
      guidance,
      references: fakeReferences(),
      findings: fakeFindings(),
      notifications: fakeNotifications(),
      manifest: fakeManifest(),
      gateway: fakeGateway(() => [{ ...CONTRADICTION_A, manifestFacts: [] }]),
      clock: () => new Date("2026-02-01T00:00:00.000Z"),
    });

    await expect(action({ projectItemId: "project-1" })).rejects.toThrow(/manifestFacts/);
  });
});
