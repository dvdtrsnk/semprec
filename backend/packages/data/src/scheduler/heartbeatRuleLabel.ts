import { fill } from "../agentRuns/catalogFill.js";
import { heartbeatRuleSchema, type HeartbeatRule } from "./rule.js";

/** Resolves a `seed/i18n/{cs,en}.json` key in the caller's locale. */
export type HeartbeatLabelResolver = (key: string) => string;

const WEEK = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
type Weekday = (typeof WEEK)[number];

/** Shortest run of consecutive days written as a range ("Mon-Wed") rather than a list. */
const MIN_RANGE_DAYS = 3;

/** Largest `n` taking the Czech paucal ("každé 3 dny"); from 5 on it is genitive plural ("každých 5 dní"). */
const MAX_FEW_DAYS = 4;

function wallClock(at: string): string {
  const [hour, minutes] = at.split(":");
  return `${Number(hour)}:${minutes}`;
}

/**
 * Week order from Monday, runs of `MIN_RANGE_DAYS`+ days as a range: `mon..fri` is "Mon-Fri",
 * `mon, wed, fri` is "Mon, Wed, Fri". Runs do not wrap from Sunday to Monday.
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
      // "every 1 days" is no sentence in either language.
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
 * A heartbeat's schedule as a person reads it, e.g. "Mon-Fri at 8:30" / "Po-Pá v 8:30". The rule's
 * wall-clock time is shown unchanged (no instant conversion). A non-core or unparseable rule reads as
 * `heartbeat.rule.unknown`.
 */
export function formatHeartbeatRuleLabel(rule: unknown, label: HeartbeatLabelResolver): string {
  const parsed = heartbeatRuleSchema.safeParse(rule);
  return parsed.success ? labelOfCoreRule(parsed.data, label) : label("heartbeat.rule.unknown");
}
