import { describe, expect, it, vi } from "vitest";
import { GuidanceReferenceNotFoundError, MAX_PROJECT_AGENT_GUIDANCE_MARKDOWN_BYTES } from "@semprec/shared";
import type {
  GuidanceHeartbeatStore,
  GuidanceReferenceStore,
  ProjectAgentGuidance,
  ProjectAgentGuidanceStore,
  TransactionRunner,
} from "@semprec/shared";
import { createProjectAgentGuidanceService } from "../service.js";
import { ProjectAgentGuidanceOwnerViolationError, ProjectAgentGuidanceValidationError } from "../errors.js";

type FakeTx = { calls: string[] };

function fakeTransactions(): TransactionRunner<FakeTx> & { isolationsUsed: string[] } {
  const isolationsUsed: string[] = [];
  return {
    isolationsUsed,
    async withTransaction(options, work) {
      isolationsUsed.push(options.isolation);
      return work({ calls: [] });
    },
  };
}

function fakeReferences(overrides: Partial<GuidanceReferenceStore<FakeTx>> = {}): GuidanceReferenceStore<FakeTx> {
  return {
    requireProjectsItem: vi.fn(async () => {}),
    requireUser: vi.fn(async () => {}),
    requireUserLocale: vi.fn(async () => "cs"),
    ...overrides,
  };
}

function fakeStore(initial: ProjectAgentGuidance | null = null): ProjectAgentGuidanceStore<FakeTx> & {
  rows: Map<string, ProjectAgentGuidance>;
} {
  const rows = new Map<string, ProjectAgentGuidance>();
  if (initial) rows.set(initial.projectItemId, initial);
  return {
    rows,
    async load(_tx, projectItemId) {
      return rows.get(projectItemId) ?? null;
    },
    async upsert(_tx, row) {
      const saved = { ...row, updatedAt: new Date().toISOString() };
      rows.set(row.projectItemId, saved);
      return saved;
    },
    async transfer(_tx, projectItemId, newOwnerUserId) {
      const existing = rows.get(projectItemId);
      if (!existing) throw new Error("not found");
      const updated = { ...existing, ownerUserId: newOwnerUserId, updatedAt: new Date().toISOString() };
      rows.set(projectItemId, updated);
      return updated;
    },
  };
}

function recordingHeartbeats(): GuidanceHeartbeatStore<FakeTx> & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async upsertDriftHeartbeat(_tx, projectItemId) {
      calls.push(projectItemId);
    },
  };
}

describe("createProjectAgentGuidanceService (issue #214)", () => {
  it("loads guidance through a repeatable-read transaction", async () => {
    const existing: ProjectAgentGuidance = {
      projectItemId: "p1",
      ownerUserId: "u1",
      markdown: "# Hi",
      updatedAt: new Date().toISOString(),
    };
    const store = fakeStore(existing);
    const transactions = fakeTransactions();
    const service = createProjectAgentGuidanceService({
      store,
      references: fakeReferences(),
      heartbeats: recordingHeartbeats(),
      transactions,
    });

    await expect(service.loadProjectAgentGuidance("p1")).resolves.toEqual(existing);
    await expect(service.loadProjectAgentGuidance("missing")).resolves.toBeNull();
    expect(transactions.isolationsUsed).toEqual(["repeatable_read", "repeatable_read"]);
  });

  it("uses a serializable transaction for mutating calls", async () => {
    const existing: ProjectAgentGuidance = {
      projectItemId: "p1",
      ownerUserId: "u1",
      markdown: "# Hi",
      updatedAt: new Date().toISOString(),
    };
    const transactions = fakeTransactions();
    const service = createProjectAgentGuidanceService({
      store: fakeStore(existing),
      references: fakeReferences(),
      heartbeats: recordingHeartbeats(),
      transactions,
    });

    await service.upsertProjectAgentGuidance({ userId: "u1" }, { projectItemId: "p1", markdown: "# New" });
    await service.transferProjectAgentGuidance({ userId: "u1" }, { projectItemId: "p1", newOwnerUserId: "u2" });

    expect(transactions.isolationsUsed).toEqual(["serializable", "serializable"]);
  });

  it("creates guidance owned by the actor and upserts the drift heartbeat in the same call", async () => {
    const heartbeats = recordingHeartbeats();
    const service = createProjectAgentGuidanceService({
      store: fakeStore(),
      references: fakeReferences(),
      heartbeats,
      transactions: fakeTransactions(),
    });

    const saved = await service.upsertProjectAgentGuidance(
      { userId: "u1" },
      { projectItemId: "p1", markdown: "# Guidance" },
    );

    expect(saved.ownerUserId).toBe("u1");
    expect(saved.markdown).toBe("# Guidance");
    expect(heartbeats.calls).toEqual(["p1"]);
  });

  it("lets the current owner update existing guidance without changing the owner", async () => {
    const existing: ProjectAgentGuidance = {
      projectItemId: "p1",
      ownerUserId: "u1",
      markdown: "# Old",
      updatedAt: new Date().toISOString(),
    };
    const service = createProjectAgentGuidanceService({
      store: fakeStore(existing),
      references: fakeReferences(),
      heartbeats: recordingHeartbeats(),
      transactions: fakeTransactions(),
    });

    const saved = await service.upsertProjectAgentGuidance(
      { userId: "u1" },
      { projectItemId: "p1", markdown: "# New" },
    );
    expect(saved.ownerUserId).toBe("u1");
    expect(saved.markdown).toBe("# New");
  });

  it("rejects a non-owner's update with a 403 owner_violation", async () => {
    const existing: ProjectAgentGuidance = {
      projectItemId: "p1",
      ownerUserId: "u1",
      markdown: "# Old",
      updatedAt: new Date().toISOString(),
    };
    const service = createProjectAgentGuidanceService({
      store: fakeStore(existing),
      references: fakeReferences(),
      heartbeats: recordingHeartbeats(),
      transactions: fakeTransactions(),
    });

    const err = await service
      .upsertProjectAgentGuidance({ userId: "someone-else" }, { projectItemId: "p1", markdown: "# New" })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProjectAgentGuidanceOwnerViolationError);
    expect((err as ProjectAgentGuidanceOwnerViolationError).status).toBe(403);
    expect((err as ProjectAgentGuidanceOwnerViolationError).details).toEqual({
      field: "ownerUserId",
      projectItemId: "p1",
    });
  });

  it("rejects blank markdown with a 400 validation_failed before touching the store", async () => {
    const store = fakeStore();
    const service = createProjectAgentGuidanceService({
      store,
      references: fakeReferences(),
      heartbeats: recordingHeartbeats(),
      transactions: fakeTransactions(),
    });

    const err = await service
      .upsertProjectAgentGuidance({ userId: "u1" }, { projectItemId: "p1", markdown: "   " })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProjectAgentGuidanceValidationError);
    expect((err as ProjectAgentGuidanceValidationError).details).toEqual({ field: "markdown", reason: "blank" });
    expect(store.rows.size).toBe(0);
  });

  it("rejects markdown over the max size with a 400 validation_failed before touching the store", async () => {
    const store = fakeStore();
    const service = createProjectAgentGuidanceService({
      store,
      references: fakeReferences(),
      heartbeats: recordingHeartbeats(),
      transactions: fakeTransactions(),
    });

    const oversized = "a".repeat(MAX_PROJECT_AGENT_GUIDANCE_MARKDOWN_BYTES + 1);
    const err = await service
      .upsertProjectAgentGuidance({ userId: "u1" }, { projectItemId: "p1", markdown: oversized })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProjectAgentGuidanceValidationError);
    expect((err as ProjectAgentGuidanceValidationError).details).toEqual({ field: "markdown", reason: "too_long" });
    expect(store.rows.size).toBe(0);
  });

  it("rejects a missing project item with a 400 validation_failed", async () => {
    const references = fakeReferences({
      requireProjectsItem: vi.fn(async () => {
        throw new GuidanceReferenceNotFoundError("not found");
      }),
    });
    const service = createProjectAgentGuidanceService({
      store: fakeStore(),
      references,
      heartbeats: recordingHeartbeats(),
      transactions: fakeTransactions(),
    });

    const err = await service
      .upsertProjectAgentGuidance({ userId: "u1" }, { projectItemId: "missing", markdown: "# Hi" })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProjectAgentGuidanceValidationError);
    expect((err as ProjectAgentGuidanceValidationError).details).toEqual({
      field: "projectItemId",
      reason: "not_found",
    });
  });

  it("propagates an infrastructure error from a reference check unchanged, not as a 400", async () => {
    const infraError = new Error("connection terminated unexpectedly");
    const references = fakeReferences({
      requireProjectsItem: vi.fn(async () => {
        throw infraError;
      }),
    });
    const service = createProjectAgentGuidanceService({
      store: fakeStore(),
      references,
      heartbeats: recordingHeartbeats(),
      transactions: fakeTransactions(),
    });

    const err = await service
      .upsertProjectAgentGuidance({ userId: "u1" }, { projectItemId: "p1", markdown: "# Hi" })
      .catch((e: unknown) => e);

    expect(err).toBe(infraError);
    expect(err).not.toBeInstanceOf(ProjectAgentGuidanceValidationError);
  });

  it("transfers ownership only when the actor is the current owner, and upserts the heartbeat", async () => {
    const existing: ProjectAgentGuidance = {
      projectItemId: "p1",
      ownerUserId: "u1",
      markdown: "# Guidance",
      updatedAt: new Date().toISOString(),
    };
    const heartbeats = recordingHeartbeats();
    const service = createProjectAgentGuidanceService({
      store: fakeStore(existing),
      references: fakeReferences(),
      heartbeats,
      transactions: fakeTransactions(),
    });

    const saved = await service.transferProjectAgentGuidance(
      { userId: "u1" },
      { projectItemId: "p1", newOwnerUserId: "u2" },
    );

    expect(saved.ownerUserId).toBe("u2");
    expect(heartbeats.calls).toEqual(["p1"]);
  });

  it("rejects a transfer requested by a non-owner with a 403 owner_violation", async () => {
    const existing: ProjectAgentGuidance = {
      projectItemId: "p1",
      ownerUserId: "u1",
      markdown: "# Guidance",
      updatedAt: new Date().toISOString(),
    };
    const service = createProjectAgentGuidanceService({
      store: fakeStore(existing),
      references: fakeReferences(),
      heartbeats: recordingHeartbeats(),
      transactions: fakeTransactions(),
    });

    await expect(
      service.transferProjectAgentGuidance({ userId: "u2" }, { projectItemId: "p1", newOwnerUserId: "u3" }),
    ).rejects.toBeInstanceOf(ProjectAgentGuidanceOwnerViolationError);
  });

  it("rejects a transfer when no guidance exists yet with a 403 owner_violation", async () => {
    const service = createProjectAgentGuidanceService({
      store: fakeStore(),
      references: fakeReferences(),
      heartbeats: recordingHeartbeats(),
      transactions: fakeTransactions(),
    });

    await expect(
      service.transferProjectAgentGuidance({ userId: "u1" }, { projectItemId: "p1", newOwnerUserId: "u2" }),
    ).rejects.toBeInstanceOf(ProjectAgentGuidanceOwnerViolationError);
  });

  it("rejects a transfer to a nonexistent target user with a 400 validation_failed", async () => {
    const existing: ProjectAgentGuidance = {
      projectItemId: "p1",
      ownerUserId: "u1",
      markdown: "# Guidance",
      updatedAt: new Date().toISOString(),
    };
    const references = fakeReferences({
      requireUser: vi.fn(async () => {
        throw new GuidanceReferenceNotFoundError("not found");
      }),
    });
    const service = createProjectAgentGuidanceService({
      store: fakeStore(existing),
      references,
      heartbeats: recordingHeartbeats(),
      transactions: fakeTransactions(),
    });

    const err = await service
      .transferProjectAgentGuidance({ userId: "u1" }, { projectItemId: "p1", newOwnerUserId: "ghost" })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProjectAgentGuidanceValidationError);
    expect((err as ProjectAgentGuidanceValidationError).details).toEqual({
      field: "newOwnerUserId",
      reason: "not_found",
    });
  });
});
