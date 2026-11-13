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
  GuidanceProblemWriter,
  ResolveGuidanceDriftProblemInput,
  RaiseGuidanceDriftProblemInput,
  GuidanceReferenceStore,
  ProjectAgentGuidance,
  ProjectAgentGuidanceStore,
  TransactionRunner,
} from "@semprec/shared";
import { fingerprintGuidanceDriftSubject, validateGuidanceDriftContradiction } from "@semprec/shared";
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
    async loadForUpdate() {
      return state.row;
    },
    async delete() {
      throw new Error("not used by driftAction");
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
    async decide(_tx, findingId, decision) {
      const entry = [...rows.entries()].find(([, row]) => row.id === findingId && row.status === "active");
      if (!entry) throw new Error(`finding ${findingId} not found`);
      const [key, existing] = entry;
      const updated = {
        ...existing,
        status: decision.status,
        lastSeenAt: decision.at.toISOString(),
        resolvedAt: decision.at.toISOString(),
      };
      rows.set(key, updated);
      return updated;
    },
  };
}

function fakeProblems(): GuidanceProblemWriter<FakeTx> & {
  raised: RaiseGuidanceDriftProblemInput[];
  resolved: ResolveGuidanceDriftProblemInput[];
} {
  const raised: RaiseGuidanceDriftProblemInput[] = [];
  const resolved: ResolveGuidanceDriftProblemInput[] = [];
  return {
    raised,
    resolved,
    async raise(_tx, input) {
      raised.push(input);
    },
    async resolve(_tx, input) {
      resolved.push(input);
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
  kind: "permission",
  subject: { operation: "files.delete", databaseId: null },
  claim: "The agent can delete files without approval.",
  guidanceExcerpt: "Agents may delete any file directly.",
  manifestFacts: ["capability.files.delete requires approval"],
  severity: "blocking",
};

const CONTRADICTION_B: GuidanceDriftContradiction = {
  kind: "permission",
  subject: { operation: "mail.read", databaseId: "db-mail" },
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
    const problems = fakeProblems();
    const action = createAgentGuidanceDriftAction({
      toolCallUsage: {
        async listProjectToolCallGroups() {
          return [];
        },
      },
      transactions: fakeTransactions(),
      guidance,
      references: fakeReferences(),
      findings,
      notifications,
      problems,
      manifest: fakeManifest(),
      gateway: fakeGateway(() => [CONTRADICTION_A]),
      clock: () => new Date("2026-02-01T00:00:00.000Z"),
    });

    await action({ projectItemId: "project-1" });

    expect(findings.rows.size).toBe(1);
    expect(problems.raised).toHaveLength(1);
    expect(problems.raised[0]).toMatchObject({ userId: "owner-1", projectItemId: "project-1" });
    expect(problems.raised[0]?.occurrenceKey).toBe(`${problems.raised[0]?.fingerprint}:2026-02-01T00:00:00.000Z`);
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
      toolCallUsage: {
        async listProjectToolCallGroups() {
          return [];
        },
      },
      transactions: fakeTransactions(),
      guidance,
      references: fakeReferences(),
      findings,
      notifications,
      problems: fakeProblems(),
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
    const problems = fakeProblems();
    let respondWithContradiction = true;
    const action = createAgentGuidanceDriftAction({
      toolCallUsage: {
        async listProjectToolCallGroups() {
          return [];
        },
      },
      transactions: fakeTransactions(),
      guidance,
      references: fakeReferences(),
      findings,
      notifications,
      problems,
      manifest: fakeManifest(),
      gateway: fakeGateway(() => (respondWithContradiction ? [CONTRADICTION_A] : [])),
      clock: () => new Date("2026-02-01T00:00:00.000Z"),
    });

    await action({ projectItemId: "project-1" });
    expect(problems.resolved).toEqual([]);
    respondWithContradiction = false;
    await action({ projectItemId: "project-1" });
    await action({ projectItemId: "project-1" });
    const fingerprint = fingerprintGuidanceDriftSubject("project-1", "permission", {
      operation: "files.delete",
      databaseId: null,
    });
    // once for the transition; the repeat run finds the finding already resolved
    expect(problems.resolved).toEqual([{ projectItemId: "project-1", fingerprint }]);

    const finding = [...findings.rows.values()][0];
    expect(finding).toBeDefined();
    expect(finding?.status).toBe("resolved");
    expect(notifications.created).toHaveLength(2);
    expect(notifications.created[1]).toMatchObject({
      userId: "owner-1",
      kind: "agent_guidance_drift_resolved",
      payload: {
        projectItemId: "project-1",
        fingerprint: fingerprintGuidanceDriftSubject("project-1", "permission", {
          operation: "files.delete",
          databaseId: null,
        }),
      },
    });
  });

  it("leaves the problem alone when the store reports no resolution because the finding was decided meanwhile", async () => {
    const findings = fakeFindings();
    const problems = fakeProblems();
    let respondWithContradiction = true;
    const action = createAgentGuidanceDriftAction({
      toolCallUsage: {
        async listProjectToolCallGroups() {
          return [];
        },
      },
      transactions: fakeTransactions(),
      guidance: fakeGuidance(baseGuidanceRow()),
      references: fakeReferences(),
      findings: {
        ...findings,
        async resolve(tx, findingId, resolvedAt) {
          const { finding } = await findings.resolve(tx, findingId, resolvedAt);
          return { finding, transitionedToResolved: false };
        },
      },
      notifications: fakeNotifications(),
      problems,
      manifest: fakeManifest(),
      gateway: fakeGateway(() => (respondWithContradiction ? [CONTRADICTION_A] : [])),
      clock: () => new Date("2026-02-01T00:00:00.000Z"),
    });

    await action({ projectItemId: "project-1" });
    respondWithContradiction = false;
    await action({ projectItemId: "project-1" });

    expect(problems.resolved).toEqual([]);
  });

  it("dedupes and resolves identically regardless of the contradictions' report order", async () => {
    const guidanceA = fakeGuidance(baseGuidanceRow({ projectItemId: "project-a" }));
    const findingsA = fakeFindings();
    const actionA = createAgentGuidanceDriftAction({
      toolCallUsage: {
        async listProjectToolCallGroups() {
          return [];
        },
      },
      transactions: fakeTransactions(),
      guidance: guidanceA,
      references: fakeReferences(),
      findings: findingsA,
      notifications: fakeNotifications(),
      problems: fakeProblems(),
      manifest: fakeManifest(),
      gateway: fakeGateway(() => [CONTRADICTION_A, CONTRADICTION_B]),
      clock: () => new Date("2026-02-01T00:00:00.000Z"),
    });

    const guidanceB = fakeGuidance(baseGuidanceRow({ projectItemId: "project-a" }));
    const findingsB = fakeFindings();
    const actionB = createAgentGuidanceDriftAction({
      toolCallUsage: {
        async listProjectToolCallGroups() {
          return [];
        },
      },
      transactions: fakeTransactions(),
      guidance: guidanceB,
      references: fakeReferences(),
      findings: findingsB,
      notifications: fakeNotifications(),
      problems: fakeProblems(),
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

  it("keeps one active finding with an advancing lastSeenAt when the AI rewords the same subject", async () => {
    const findings = fakeFindings();
    const notifications = fakeNotifications();
    let night = 0;
    const action = createAgentGuidanceDriftAction({
      toolCallUsage: {
        async listProjectToolCallGroups() {
          return [];
        },
      },
      transactions: fakeTransactions(),
      guidance: fakeGuidance(baseGuidanceRow()),
      references: fakeReferences(),
      findings,
      notifications,
      problems: fakeProblems(),
      manifest: fakeManifest(),
      gateway: fakeGateway(() => [
        night === 0
          ? CONTRADICTION_A
          : {
              ...CONTRADICTION_A,
              claim: "Deleting files needs no approval.",
              guidanceExcerpt: "Agents delete files directly.",
              manifestFacts: ["files.delete: approval required"],
            },
      ]),
      clock: () => new Date(night === 0 ? "2026-02-01T00:00:00.000Z" : "2026-02-02T00:00:00.000Z"),
    });

    await action({ projectItemId: "project-1" });
    night = 1;
    await action({ projectItemId: "project-1" });

    const rows = [...findings.rows.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "active", lastSeenAt: "2026-02-02T00:00:00.000Z" });
    expect(notifications.created).toHaveLength(1);
  });

  it("keeps the higher severity when two contradictions share a subject, in either report order", async () => {
    const warning: GuidanceDriftContradiction = {
      ...CONTRADICTION_A,
      claim: "Other wording.",
      severity: "warning",
    };
    for (const order of [
      [CONTRADICTION_A, warning],
      [warning, CONTRADICTION_A],
    ]) {
      const findings = fakeFindings();
      const action = createAgentGuidanceDriftAction({
        toolCallUsage: {
          async listProjectToolCallGroups() {
            return [];
          },
        },
        transactions: fakeTransactions(),
        guidance: fakeGuidance(baseGuidanceRow()),
        references: fakeReferences(),
        findings,
        notifications: fakeNotifications(),
        problems: fakeProblems(),
        manifest: fakeManifest(),
        gateway: fakeGateway(() => order),
        clock: () => new Date("2026-02-01T00:00:00.000Z"),
      });

      await action({ projectItemId: "project-1" });

      const rows = [...findings.rows.values()];
      expect(rows).toHaveLength(1);
      expect(rows[0]?.payload.severity).toBe("blocking");
    }
  });

  it("fails validation without changing any finding when a contradiction has no subject", async () => {
    const findings = fakeFindings();
    const notifications = fakeNotifications();
    const { subject: _subject, ...withoutSubject } = CONTRADICTION_A;
    const action = createAgentGuidanceDriftAction({
      toolCallUsage: {
        async listProjectToolCallGroups() {
          return [];
        },
      },
      transactions: fakeTransactions(),
      guidance: fakeGuidance(baseGuidanceRow()),
      references: fakeReferences(),
      findings,
      notifications,
      problems: fakeProblems(),
      manifest: fakeManifest(),
      gateway: {
        async complete() {
          return {
            content: { contradictions: [CONTRADICTION_B, withoutSubject] },
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
      },
      clock: () => new Date("2026-02-01T00:00:00.000Z"),
    });

    await expect(action({ projectItemId: "project-1" })).rejects.toThrow(/missing its subject/);
    expect(findings.rows.size).toBe(0);
    expect(notifications.created).toHaveLength(0);
  });

  it("discards stale gateway output when the guidance row changes mid-call, with no writes", async () => {
    const guidance = fakeGuidance(baseGuidanceRow());
    const findings = fakeFindings();
    const notifications = fakeNotifications();
    const action = createAgentGuidanceDriftAction({
      toolCallUsage: {
        async listProjectToolCallGroups() {
          return [];
        },
      },
      transactions: fakeTransactions(),
      guidance,
      references: fakeReferences(),
      findings,
      notifications,
      problems: fakeProblems(),
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
      toolCallUsage: {
        async listProjectToolCallGroups() {
          return [];
        },
      },
      transactions: fakeTransactions(),
      guidance,
      references: fakeReferences(),
      findings,
      notifications,
      problems: fakeProblems(),
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
      toolCallUsage: {
        async listProjectToolCallGroups() {
          return [];
        },
      },
      transactions: fakeTransactions(),
      guidance,
      references: fakeReferences(),
      findings,
      notifications,
      problems: fakeProblems(),
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
      toolCallUsage: {
        async listProjectToolCallGroups() {
          return [];
        },
      },
      transactions: fakeTransactions(),
      guidance,
      references: fakeReferences(),
      findings,
      notifications,
      problems: fakeProblems(),
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
      toolCallUsage: {
        async listProjectToolCallGroups() {
          return [];
        },
      },
      transactions: fakeTransactions(),
      guidance,
      references: fakeReferences(),
      findings,
      notifications,
      problems: fakeProblems(),
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
      toolCallUsage: {
        async listProjectToolCallGroups() {
          return [];
        },
      },
      transactions: fakeTransactions(),
      guidance,
      references: fakeReferences(),
      findings: fakeFindings(),
      notifications: fakeNotifications(),
      problems: fakeProblems(),
      manifest: fakeManifest(),
      gateway: fakeGateway(() => [{ ...CONTRADICTION_A, manifestFacts: [] }]),
      clock: () => new Date("2026-02-01T00:00:00.000Z"),
    });

    await expect(action({ projectItemId: "project-1" })).rejects.toThrow(/manifestFacts/);
  });
});

describe("behavior guidance drift", () => {
  it("rejects empty or duplicate run evidence at the stored-payload boundary", () => {
    const payload = {
      kind: "behavior",
      subject: { operation: "item.create", databaseId: null },
      claim: "Creates tasks",
      suggestedAllowedLine: "Allow",
      suggestedNotAllowedLine: "Forbid",
      severity: "warning",
    };
    expect(() =>
      validateGuidanceDriftContradiction({ ...payload, evidence: { count: 3, runIds: [] } }, "test"),
    ).toThrow("invalid behavior evidence");
    expect(() =>
      validateGuidanceDriftContradiction({ ...payload, evidence: { count: 3, runIds: ["same", "same"] } }, "test"),
    ).toThrow("invalid behavior evidence");
  });
  it("writes no behavior finding when guidance changes during the gateway call", async () => {
    const subject = { operation: "item.create", databaseId: "tasks" };
    const fingerprint = fingerprintGuidanceDriftSubject("project-1", "behavior", subject);
    const guidance = fakeGuidance(baseGuidanceRow());
    const findings = fakeFindings();
    const action = createAgentGuidanceDriftAction({
      transactions: fakeTransactions(),
      guidance,
      references: fakeReferences(),
      findings,
      notifications: fakeNotifications(),
      problems: fakeProblems(),
      manifest: fakeManifest(),
      clock: () => new Date("2026-02-01T00:00:00Z"),
      toolCallUsage: {
        async listProjectToolCallGroups() {
          return [{ subject, databaseName: "Tasks", count: 3, runIds: ["r3", "r2", "r1"] }];
        },
      },
      gateway: {
        async complete(input) {
          if (input.operation === "agent_guidance_drift")
            return { content: { contradictions: [] }, usage: { inputTokens: 1, outputTokens: 1 } };
          guidance.row = baseGuidanceRow({ updatedAt: "2026-01-02T00:00:00.000Z" });
          return {
            content: {
              findings: [
                {
                  fingerprint,
                  claim: "Creates tasks",
                  suggestedAllowedLine: "Allow",
                  suggestedNotAllowedLine: "Forbid",
                },
              ],
            },
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
      },
    });
    await expect(action({ projectItemId: "project-1" })).rejects.toBeInstanceOf(GuidanceChangedError);
    expect([...findings.rows.values()].filter((row) => row.payload.kind === "behavior")).toEqual([]);
  });
  it("creates once, advances the observation, and resolves without touching permission findings", async () => {
    const subject = { operation: "item.create", databaseId: "tasks" };
    const fingerprint = fingerprintGuidanceDriftSubject("project-1", "behavior", subject);
    const guidance = fakeGuidance(baseGuidanceRow());
    const findings = fakeFindings();
    const notifications = fakeNotifications();
    const problems = fakeProblems();
    let count = 3;
    let mentioned = false;
    let day = 1;
    let behaviorCalls = 0;
    const gateway: AiGatewayClientPort = {
      async complete(input) {
        if (input.operation === "agent_guidance_drift")
          return { content: { contradictions: [CONTRADICTION_A] }, usage: { inputTokens: 1, outputTokens: 1 } };
        behaviorCalls += 1;
        return {
          content: {
            findings: mentioned
              ? []
              : [
                  {
                    fingerprint,
                    claim: "Creates tasks",
                    suggestedAllowedLine: "Allow task creation",
                    suggestedNotAllowedLine: "Forbid task creation",
                  },
                ],
          },
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const action = createAgentGuidanceDriftAction({
      transactions: fakeTransactions(),
      guidance,
      references: fakeReferences(),
      findings,
      notifications,
      problems,
      manifest: fakeManifest(),
      gateway,
      clock: () => new Date(`2026-02-0${day}T00:00:00Z`),
      toolCallUsage: {
        async listProjectToolCallGroups() {
          return count < 3 ? [] : [{ subject, databaseName: "Tasks", count, runIds: ["r3", "r2", "r1"] }];
        },
      },
    });
    await action({ projectItemId: "project-1" });
    day = 2;
    await action({ projectItemId: "project-1" });
    expect([...findings.rows.values()].find((row) => row.payload.kind === "behavior")).toMatchObject({
      status: "active",
      lastSeenAt: "2026-02-02T00:00:00.000Z",
      payload: {
        evidence: { count: 3, runIds: ["r3", "r2", "r1"] },
        suggestedAllowedLine: "Allow task creation",
        suggestedNotAllowedLine: "Forbid task creation",
      },
    });
    expect(notifications.created.filter((notification) => notification.payload.kind === "behavior")).toHaveLength(1);
    expect(problems.resolved).toEqual([]);
    mentioned = true;
    day = 3;
    await action({ projectItemId: "project-1" });
    expect([...findings.rows.values()].find((row) => row.payload.kind === "behavior")?.status).toBe("resolved");
    // only the behavior finding resolved: the permission finding stays reported and keeps its problem
    expect(problems.resolved).toEqual([{ projectItemId: "project-1", fingerprint }]);
    expect([...findings.rows.values()].find((row) => row.payload.kind === "permission")?.status).toBe("active");
    expect(
      notifications.created.filter(
        (notification) =>
          notification.kind === "agent_guidance_drift_resolved" && notification.payload.kind === "behavior",
      ),
    ).toHaveLength(1);
    count = 2;
    day = 4;
    await action({ projectItemId: "project-1" });
    expect(behaviorCalls).toBe(3);
  });
  it("runs the behavior pass even when the permission pass fails", async () => {
    const subject = { operation: "item.create", databaseId: "tasks" };
    const fingerprint = fingerprintGuidanceDriftSubject("project-1", "behavior", subject);
    const findings = fakeFindings();
    const action = createAgentGuidanceDriftAction({
      transactions: fakeTransactions(),
      guidance: fakeGuidance(baseGuidanceRow()),
      references: fakeReferences(),
      findings,
      notifications: fakeNotifications(),
      problems: fakeProblems(),
      manifest: fakeManifest(),
      clock: () => new Date("2026-02-01T00:00:00Z"),
      toolCallUsage: {
        async listProjectToolCallGroups() {
          return [{ subject, databaseName: "Tasks", count: 3, runIds: ["r3", "r2", "r1"] }];
        },
      },
      gateway: {
        async complete(input) {
          if (input.operation === "agent_guidance_drift") throw new Error("permission failed");
          return {
            content: {
              findings: [
                {
                  fingerprint,
                  claim: "Creates tasks",
                  suggestedAllowedLine: "Allow",
                  suggestedNotAllowedLine: "Forbid",
                },
              ],
            },
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
      },
    });
    await expect(action({ projectItemId: "project-1" })).rejects.toThrow("permission failed");
    expect([...findings.rows.values()].some((row) => row.payload.kind === "behavior")).toBe(true);
  });
  it("rejects an oversized complete behavior request without calling the behavior gateway or resolving findings", async () => {
    const subject = { operation: "item.create", databaseId: "tasks" };
    const fingerprint = fingerprintGuidanceDriftSubject("project-1", "behavior", subject);
    const findings = fakeFindings();
    await findings.upsertActive(
      { phase: "write" },
      {
        projectItemId: "project-1",
        fingerprint,
        seenAt: new Date("2026-02-01T00:00:00Z"),
        payload: {
          kind: "behavior",
          subject,
          claim: "Existing",
          evidence: { count: 3, runIds: ["a", "b", "c"] },
          suggestedAllowedLine: "Allow",
          suggestedNotAllowedLine: "Forbid",
          severity: "warning",
        },
      },
    );
    let behaviorCalls = 0;
    const action = createAgentGuidanceDriftAction({
      transactions: fakeTransactions(),
      guidance: fakeGuidance(baseGuidanceRow({ markdown: `## Allowed\n${"x".repeat(10_000)}\n` })),
      references: fakeReferences(),
      findings,
      notifications: fakeNotifications(),
      problems: fakeProblems(),
      manifest: fakeManifest(),
      clock: () => new Date("2026-02-02T00:00:00Z"),
      toolCallUsage: {
        async listProjectToolCallGroups() {
          return [
            {
              subject: { operation: "x".repeat(1_040_000), databaseId: null },
              databaseName: null,
              count: 3,
              runIds: ["a", "b", "c"],
            },
          ];
        },
      },
      gateway: {
        async complete(input) {
          if (input.operation === "agent_behavior_drift") behaviorCalls++;
          return { content: { contradictions: [] }, usage: { inputTokens: 1, outputTokens: 1 } };
        },
      },
    });
    await expect(action({ projectItemId: "project-1" })).rejects.toThrow(
      "Behavior drift gateway request exceeds its limit",
    );
    expect(behaviorCalls).toBe(0);
    expect([...findings.rows.values()].find((row) => row.fingerprint === fingerprint)?.status).toBe("active");
  });
});
