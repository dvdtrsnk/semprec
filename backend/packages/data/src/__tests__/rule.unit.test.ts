import { describe, expect, it } from "vitest";
import { parseHeartbeatRule } from "../scheduler/rule.js";
import type { HeartbeatRuleKindRegistry } from "../scheduler/rule.js";

describe("parseHeartbeatRule", () => {
  it("validates a core rule kind against core's fixed schema regardless of moduleRuleKinds", () => {
    const rule = parseHeartbeatRule({ kind: "dailyTime", at: "09:00" });
    expect(rule).toEqual({ kind: "dailyTime", at: "09:00" });
  });

  it("rejects a core-shaped rule that fails core's schema", () => {
    expect(() => parseHeartbeatRule({ kind: "dailyTime", at: "not-a-time" })).toThrow();
  });

  it("validates an active module rule kind against its registered schema", () => {
    const moduleRuleKinds: HeartbeatRuleKindRegistry = new Map([
      [
        "fixtureModule.onWidgetTick",
        {
          schema: { safeParse: (raw: unknown) => ({ success: true, data: raw }) },
          nextFireAt: () => null,
        },
      ],
    ]);
    const rule = parseHeartbeatRule({ kind: "fixtureModule.onWidgetTick", every: 5 }, moduleRuleKinds);
    expect(rule).toEqual({ kind: "fixtureModule.onWidgetTick", every: 5 });
  });

  it("rejects a module rule kind whose module is inactive (absent from moduleRuleKinds)", () => {
    expect(() => parseHeartbeatRule({ kind: "fixtureModule.onWidgetTick", every: 5 })).toThrow(
      /Unknown heartbeat rule kind/,
    );
  });

  it("surfaces the module schema's own validation failure", () => {
    const moduleRuleKinds: HeartbeatRuleKindRegistry = new Map([
      [
        "fixtureModule.onWidgetTick",
        {
          schema: { safeParse: () => ({ success: false, error: { message: "every must be positive" } }) },
          nextFireAt: () => null,
        },
      ],
    ]);
    expect(() => parseHeartbeatRule({ kind: "fixtureModule.onWidgetTick", every: -1 }, moduleRuleKinds)).toThrow(
      /every must be positive/,
    );
  });
});
