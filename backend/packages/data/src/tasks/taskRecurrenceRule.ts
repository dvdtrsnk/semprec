import { z } from "zod";

/** Same weekday vocabulary as scheduler/rule.ts's heartbeat rules — kept as a separate local schema since that one isn't exported, but deliberately identical values. */
const weekday = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);

// camelCase `kind` discriminators, matching this codebase's established convention for a
// stored jsonb rule (scheduler/rule.ts's heartbeat rule kinds are 'dailyTime'/'everyNDays'/
// etc) rather than the issue's illustrative DDL comment, which sketched snake_case values.
const weekdaysRule = z.object({ kind: z.literal("weekdays"), days: z.array(weekday).min(1) });
const monthDatesRule = z.object({ kind: z.literal("monthDates"), dates: z.array(z.number().int().min(1).max(31)).min(1) });
const nthWeekdayRule = z.object({
  kind: z.literal("nthWeekday"),
  // n:-1 means "the last given weekday in the month"; 0 is not a valid ordinal.
  n: z.number().int().refine((v) => v !== 0, "n must not be 0"),
  weekday,
});

export const fixedRecurrenceRuleSchema = z.discriminatedUnion("kind", [weekdaysRule, monthDatesRule, nthWeekdayRule]);
export type FixedRecurrenceRule = z.infer<typeof fixedRecurrenceRuleSchema>;

export const floatingRecurrenceRuleSchema = z.object({
  unit: z.enum(["days", "weeks", "months"]),
  n: z.number().int().positive(),
});
export type FloatingRecurrenceRule = z.infer<typeof floatingRecurrenceRuleSchema>;

export const TASK_RECURRENCE_MODES = ["fixed", "floating"] as const;
export type TaskRecurrenceMode = (typeof TASK_RECURRENCE_MODES)[number];

export type TaskRecurrenceRule = FixedRecurrenceRule | FloatingRecurrenceRule;

export function parseTaskRecurrenceRule(mode: TaskRecurrenceMode, raw: unknown): TaskRecurrenceRule {
  return mode === "fixed" ? fixedRecurrenceRuleSchema.parse(raw) : floatingRecurrenceRuleSchema.parse(raw);
}
