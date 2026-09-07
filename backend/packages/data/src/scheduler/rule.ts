import { z } from "zod";

const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/, "must be HH:MM 24h wall-clock time");
const weekday = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);

const dailyTimeRule = z.object({ kind: z.literal("dailyTime"), at: timeOfDay });
const weeklyRule = z.object({ kind: z.literal("weekly"), days: z.array(weekday).min(1), at: timeOfDay });
const everyNDaysRule = z.object({ kind: z.literal("everyNDays"), n: z.number().int().positive(), at: timeOfDay });
const intervalRule = z.object({ kind: z.literal("interval"), minutes: z.number().int().positive() });
const onItemEventRule = z.object({
  kind: z.literal("onItemEvent"),
  databaseId: z.string().uuid(),
  event: z.enum(["create", "update", "delete"]),
});

export const heartbeatRuleSchema = z.discriminatedUnion("kind", [
  dailyTimeRule,
  weeklyRule,
  everyNDaysRule,
  intervalRule,
  onItemEventRule,
]);

export type HeartbeatRule = z.infer<typeof heartbeatRuleSchema>;
export type FixedRule = z.infer<typeof dailyTimeRule> | z.infer<typeof weeklyRule>;
export type FloatingRule = z.infer<typeof everyNDaysRule> | z.infer<typeof intervalRule>;
export type OnItemEventRule = z.infer<typeof onItemEventRule>;

/** Every rule "kind" core itself owns — a module's `heartbeatRuleKinds` may never reuse one (see `@semprec/module-registry`'s `reservedHeartbeatRuleKinds`). */
export const CORE_HEARTBEAT_RULE_KINDS = ["dailyTime", "weekly", "everyNDays", "interval", "onItemEvent"] as const;
export type CoreHeartbeatRuleKind = (typeof CORE_HEARTBEAT_RULE_KINDS)[number];

export function isCoreHeartbeatRuleKind(kind: string): kind is CoreHeartbeatRuleKind {
  return (CORE_HEARTBEAT_RULE_KINDS as readonly string[]).includes(kind);
}

/** A heartbeat rule whose kind is declared by an active module's manifest, not core. */
export interface ModuleHeartbeatRule {
  kind: string;
  [key: string]: unknown;
}

export type AnyHeartbeatRule = HeartbeatRule | ModuleHeartbeatRule;

/** What the scheduler needs to validate and schedule one module-declared rule kind, resolved from `ModuleRegistry.getHeartbeatRuleKindDefinitions()`. */
export interface HeartbeatRuleKindHandler {
  schema: { safeParse: (raw: unknown) => { success: boolean; data?: unknown; error?: { message: string } } };
  nextFireAt: (rule: unknown, timezone: string, after: Date) => Date | null;
}

/** Keyed by rule `kind`. Empty by default — a caller with no active module rule kinds to offer passes nothing, and only core kinds validate/schedule. */
export type HeartbeatRuleKindRegistry = ReadonlyMap<string, HeartbeatRuleKindHandler>;

export function isFixedRule(rule: HeartbeatRule): rule is FixedRule {
  return rule.kind === "dailyTime" || rule.kind === "weekly";
}
export function isFloatingRule(rule: HeartbeatRule): rule is FloatingRule {
  return rule.kind === "everyNDays" || rule.kind === "interval";
}
export function isOnItemEventRule(rule: AnyHeartbeatRule): boolean {
  return rule.kind === "onItemEvent";
}

/**
 * Validates a raw rule against core's fixed schema when its `kind` is core-owned, or against
 * the matching entry of `moduleRuleKinds` otherwise — the "union of core and active
 * heartbeatRuleKinds" the scheduler validates against (issue #109). A `kind` that is neither
 * core nor a currently-active module (e.g. its module was deactivated) is rejected.
 */
export function parseHeartbeatRule(raw: unknown, moduleRuleKinds: HeartbeatRuleKindRegistry = new Map()): AnyHeartbeatRule {
  const kind = (raw as { kind?: unknown } | null)?.kind;
  if (typeof kind !== "string") {
    return heartbeatRuleSchema.parse(raw);
  }
  if (isCoreHeartbeatRuleKind(kind)) {
    return heartbeatRuleSchema.parse(raw);
  }
  const handler = moduleRuleKinds.get(kind);
  if (!handler) {
    throw new Error(`Unknown heartbeat rule kind "${kind}" (not a core kind, and no active module currently registers it)`);
  }
  const result = handler.schema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid rule for heartbeat rule kind "${kind}": ${result.error?.message ?? "validation failed"}`);
  }
  return result.data as ModuleHeartbeatRule;
}
