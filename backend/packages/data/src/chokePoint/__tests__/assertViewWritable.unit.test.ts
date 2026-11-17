import { describe, expect, it } from "vitest";
import { ForbiddenError } from "../../errors.js";
import type { ViewRow } from "../../types.js";
import { assertSystemKeyWritable, assertViewWritable, type Actor } from "../authorization.js";

const AGENT = "11111111-1111-4111-8111-111111111111";

function view(overrides: Partial<ViewRow>): ViewRow {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    databaseId: "33333333-3333-4333-8333-333333333333",
    type: "table",
    name: "View",
    config: {},
    isDefault: false,
    ownerModuleId: null,
    createdBy: "user",
    creatorProjectItemId: null,
    ...overrides,
  };
}

const actors: Record<string, Actor> = {
  user: { type: "user" },
  system: { type: "system" },
  agent: { type: "ai_agent", agentProjectItemId: AGENT },
};

function refusal(subject: ViewRow, actor: Actor): ForbiddenError {
  try {
    assertViewWritable(subject, actor);
  } catch (err) {
    if (err instanceof ForbiddenError) return err;
    throw err;
  }
  throw new Error("expected assertViewWritable to refuse");
}

describe("assertViewWritable (issue #1798)", () => {
  describe("a view whose config has a systemKey", () => {
    for (const createdBy of ["system", "user", "ai_agent"] as const) {
      for (const [actorName, actor] of Object.entries(actors)) {
        it(`refuses a ${createdBy} view for the ${actorName} actor as system_owned`, () => {
          const subject = view({ createdBy, config: { systemKey: "today" } });
          const error = refusal(subject, actor);
          expect(error.status).toBe(403);
          expect(error.code).toBe("owner_violation");
          expect(error.details).toEqual({ field: "creatorProjectItemId", viewId: subject.id, reason: "system_owned" });
        });
      }
    }
  });

  describe("a view without a systemKey keeps the agent rules", () => {
    it("lets a user and a system actor write a system view", () => {
      expect(() => assertViewWritable(view({ createdBy: "system" }), actors.user!)).not.toThrow();
      expect(() => assertViewWritable(view({ createdBy: "system" }), actors.system!)).not.toThrow();
    });

    it("lets a user write a user view", () => {
      expect(() => assertViewWritable(view({ createdBy: "user" }), actors.user!)).not.toThrow();
    });

    it("refuses an agent on a system view as system_owned", () => {
      expect(refusal(view({ createdBy: "system" }), actors.agent!).details).toMatchObject({ reason: "system_owned" });
    });

    it("refuses an agent on a user view as user_owned", () => {
      expect(refusal(view({ createdBy: "user" }), actors.agent!).details).toMatchObject({ reason: "user_owned" });
    });

    it("lets an agent write its own view and refuses another agent's", () => {
      const own = view({ createdBy: "ai_agent", creatorProjectItemId: AGENT });
      expect(() => assertViewWritable(own, actors.agent!)).not.toThrow();
      const foreign = view({ createdBy: "ai_agent", creatorProjectItemId: "44444444-4444-4444-8444-444444444444" });
      expect(refusal(foreign, actors.agent!).details).toMatchObject({ reason: "creator_mismatch" });
    });
  });
});

describe("assertSystemKeyWritable (issue #1798)", () => {
  for (const actorName of ["user", "agent"] as const) {
    it(`refuses a config with a systemKey for the ${actorName} actor as system_key_reserved`, () => {
      for (const config of [
        { systemKey: "today" },
        { systemKey: "" },
        { systemKey: null },
        { sort: [], systemKey: "x" },
      ]) {
        try {
          assertSystemKeyWritable(config, actors[actorName]!);
        } catch (err) {
          expect(err).toBeInstanceOf(ForbiddenError);
          expect((err as ForbiddenError).status).toBe(403);
          expect((err as ForbiddenError).code).toBe("owner_violation");
          expect((err as ForbiddenError).details).toEqual({ field: "config.systemKey", reason: "system_key_reserved" });
          continue;
        }
        throw new Error(`expected ${JSON.stringify(config)} to be refused`);
      }
    });

    it(`lets the ${actorName} actor write a config without a systemKey`, () => {
      expect(() => assertSystemKeyWritable({ sort: [] }, actors[actorName]!)).not.toThrow();
      expect(() => assertSystemKeyWritable({}, actors[actorName]!)).not.toThrow();
      expect(() => assertSystemKeyWritable(undefined, actors[actorName]!)).not.toThrow();
    });
  }

  it("lets the system actor write a systemKey", () => {
    expect(() => assertSystemKeyWritable({ systemKey: "today" }, actors.system!)).not.toThrow();
  });
});
