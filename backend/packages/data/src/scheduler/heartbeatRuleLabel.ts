import { fill } from "../agentRuns/catalogFill.js";
import { heartbeatRuleSchema, type HeartbeatRule } from "./rule.js";

/** Resolves one key of the `seed/i18n/{cs,en}.json` catalog in the caller's locale, falling back as `resolveCatalogLabel` does. */
export type HeartbeatLabelResolver = (key: string) => string;

const WEEK = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
type Weekday = (typeof WEEK)[number];

/** The shortest run of consecutive days that reads as a range ("Mon-Wed") instead of a list ("Mon, Tue"). */
const MIN_RANGE_DAYS = 3;

/** The largest `n` of "every n days" that takes the Czech paucal ("každé 3 dny"); from 5 on it is the genitive plural ("každých 5 dní"). */
const MAX_FEW_DAYS = 4;

/** `"08:30"` as `8:30`: the hour without its leading zero, the minutes as stored. */
function wallClock(at: string): string {
  const [hour, minutes] = at.split(":");
  return `${Number(hour)}:${minutes}`;
}

/**
 * The days of a weekly rule in week order, each run of at least `MIN_RANGE_DAYS` consecutive days as one
 * range and every other day on its own, joined with commas: `mon..fri` is "Mon-Fri", `mon, wed, fri` is
 * "Mon, Wed, Fri". The week starts on Monday and a run does not wrap from Sunday to Monday.
 */
function formatDays(days: readonly Weekday[], label: HeartbeatLabelResolver): string {
  const indexes = [...new Set(days.map((day) => WEEK.indexOf(day)))].sort((left, right) => left - right);
  const parts: string[] = [];
  let start = 0;
  while (start < indexes.length) {
    let end = start;
    while (end + 1 < indexes.length && indexes[end + 1] === indexes[end]! + 1) end += 1;
    const dayLabel = (position: number) => label(`heartbeat.weekday.${WEEK[indexes[position]!]}`);
    if (end - start + 1 >= MIN_RANGE_DAYS) {
      parts.push(fill(label("heartbeat.weekday.range"), { from: dayLabel(start), to: dayLabel(end) }));
    } else {
      for (let position = start; position <= end; position += 1) parts.push(dayLabel(position));
    }
    start = end + 1;
  }
  return parts.join(", ");
}

function labelOfCoreRule(rule: HeartbeatRule, label: HeartbeatLabelResolver): string {
  switch (rule.kind) {
    case "dailyTime":
      return fill(label("heartbeat.rule.dailyTime"), { time: wallClock(rule.at) });
    case "weekly":
      return fill(label("heartbeat.rule.weekly"), { days: formatDays(rule.days, label), time: wallClock(rule.at) });
    case "everyNDays":
      // Every day is the daily label: "every 1 days" is no sentence in either language.
      if (rule.n === 1) return fill(label("heartbeat.rule.dailyTime"), { time: wallClock(rule.at) });
      return fill(label(rule.n <= MAX_FEW_DAYS ? "heartbeat.rule.everyNDaysFew" : "heartbeat.rule.everyNDays"), {
        n: rule.n,
        time: wallClock(rule.at),
      });
    case "interval":
      return fill(label("heartbeat.rule.interval"), { minutes: rule.minutes });
    case "onItemEvent":
      return label(`heartbeat.rule.onItemEvent.${rule.event}`);
  }
}

/**
 * The schedule of a heartbeat as a person reads it (issue #1910): `weekly` on `mon..fri` at `08:30` is "Mon-Fri at
 * 8:30" in English and "Po-Pá v 8:30" in Czech. The time of day is the rule's own wall-clock time, which is
 * read in the system timezone (`computeNextFireAt`), so the label states it unchanged; no instant is
 * converted. A rule that is not one of the core kinds (a module's kind, or a row that no longer parses) reads
 * as the `heartbeat.rule.unknown` entry: its fields are not this module's to interpret.
 */
export function formatHeartbeatRuleLabel(rule: unknown, label: HeartbeatLabelResolver): string {
  const parsed = heartbeatRuleSchema.safeParse(rule);
  return parsed.success ? labelOfCoreRule(parsed.data, label) : label("heartbeat.rule.unknown");
}
