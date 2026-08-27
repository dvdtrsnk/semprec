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

export function isFixedRule(rule: HeartbeatRule): rule is FixedRule {
  return rule.kind === "dailyTime" || rule.kind === "weekly";
}
export function isFloatingRule(rule: HeartbeatRule): rule is FloatingRule {
  return rule.kind === "everyNDays" || rule.kind === "interval";
}
export function isOnItemEventRule(rule: HeartbeatRule): rule is OnItemEventRule {
  return rule.kind === "onItemEvent";
}

export function parseHeartbeatRule(raw: unknown): HeartbeatRule {
  return heartbeatRuleSchema.parse(raw);
}
