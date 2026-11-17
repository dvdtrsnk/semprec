/**
 * One card of the items a reply changed: the stored change plus the item's current state. `before` is each changed
 * key's value before the reply, fixed however the item changes later. `resolved.values` is each changed key's current
 * value (`null` when unset; relation keys have no entry, since links are not property values). Both are absent for an
 * item in a sensitive database; `resolved.values` is also absent for a purged item.
 */
export interface SempThreadChange {
  itemId: string;
  databaseId: string;
  change: "created" | "updated" | "deleted" | "restored" | "revised";
  changedKeys: string[];
  before?: Record<string, unknown>;
  proposalId?: string;
  resolved: {
    label: string | null;
    databaseKey: string | null;
    state: "active" | "trashed" | "purged";
    values?: Record<string, unknown>;
  };
}

export interface SempThreadMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string | null;
  system: { key: string; params: unknown } | null;
  context: unknown;
  replyToMessageId: string | null;
  /**
   * Which attempt of the reply to `replyToMessageId` this is: 1, plus one per retry. Clients show the newest. Absent
   * for user and system messages.
   */
  attempt?: number;
  /**
   * Set when a regeneration replaced this message: it stays readable with its steps, is invisible to the model and
   * hidden by clients. Absent for user and system messages.
   */
  replaced?: boolean;
  agentRunId: string | null;
  eventFromId: string | null;
  status: string | null;
  createdAt: string;
  /** The items the reply changed; absent for a message with no stored changes. */
  changes?: SempThreadChange[];
  run: { startedAt: string; finishedAt: string | null; status: "running" | "done" | "error" } | null;
  /** Whether the reply left a failed tool call; derived on every read from the stored steps, never stored. */
  outcome: "complete" | "incomplete";
  /** Why the reply is incomplete; present only when `outcome` is `incomplete`. */
  incompleteReason?: "toolTimeout" | "toolUnavailable" | "toolError";
  /**
   * Why a failed reply (`status` `error`) failed: the closed run error code and its text in the user's language,
   * rendered on every read and holding no user content.
   */
  error?: { code: "budgetExceeded" | "modelError" | "cancelled" | "interrupted" | "internal"; message: string };
  /** The MCP server of the failed call; present only for an incomplete reply whose failed call was an MCP call. */
  mcpServerItemId?: string;
  /** The timeout in milliseconds of the failed call; present only when the reply is incomplete because a call timed out. */
  timeoutMs?: number;
}

/**
 * `rule` is the stored heartbeat rule; clients format it for the user's time zone. `projectName` is null when the
 * project is trashed or gone. `canTrigger` is true when the heartbeat is enabled and its rule is not `onItemEvent`.
 */
export interface SempTickThreadHeartbeat {
  id: string;
  name: string;
  rule: { kind: string } & Record<string, unknown>;
  enabled: boolean;
  projectItemId: string;
  projectName: string | null;
  canTrigger: boolean;
}

export interface SempThreadActiveRun {
  agentRunId: string;
  startedAt: string;
}

/** Only a tick thread carries `heartbeat` (null when gone) and `activeRun` (null when none is running). */
export interface SempThreadDetail {
  id: string;
  kind: "chat" | "item" | "tick";
  title: string | null;
  subject: { inboxItemId: string | null; proposalId: string | null } | null;
  createdAt: string;
  lastActivityAt: string;
  heartbeat?: SempTickThreadHeartbeat | null;
  activeRun?: SempThreadActiveRun | null;
}
