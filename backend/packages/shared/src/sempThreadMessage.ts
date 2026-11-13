/**
 * One card of the items a reply changed (issue #1888): the change as stored with the message (issue #1885) and the
 * item's current state. `itemId` and `databaseId` are the ids a client opens the object from, present in every state.
 * `before` is the value each changed key had before the reply, as stored, and stays that however the item changes
 * later; it is absent for an item in a sensitive database. `resolved.values` is the current value of each changed key
 * (`null` for a key the item holds no value for; a changed relation key, that is a link made or removed, has no entry,
 * since links are not property values) and is absent for an item in a sensitive database and for a purged
 * item.
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
  agentRunId: string | null;
  eventFromId: string | null;
  status: string | null;
  createdAt: string;
  /** The items the reply changed; absent for a message with no stored changes. */
  changes?: SempThreadChange[];
  run: { startedAt: string; finishedAt: string | null; status: "running" | "done" | "error" } | null;
  /**
   * Whether the reply left a failed tool call (issue #1890), derived on every read from the steps stored on
   * the message and never stored. A message without steps is `complete`.
   */
  outcome: "complete" | "incomplete";
  /** Why the reply is incomplete; present only when `outcome` is `incomplete`. */
  incompleteReason?: "toolTimeout" | "toolUnavailable" | "toolError";
  /**
   * Why a reply whose turn failed (`status` `error`) failed (issue #1907): the closed run error code and its text in
   * the language of the user, rendered on every read and holding no user content. Absent for a reply that did not fail.
   */
  error?: { code: "budgetExceeded" | "modelError" | "cancelled" | "interrupted" | "internal"; message: string };
  /** The MCP server of the failed call; present only for an incomplete reply whose failed call was an MCP call. */
  mcpServerItemId?: string;
  /** The timeout in milliseconds of the failed call; present only when the reply is incomplete because a call timed out. */
  timeoutMs?: number;
}

/**
 * The automation header of a tick thread (issue #1562). `rule` is the stored heartbeat rule, structured
 * (`kind` plus that kind's fields); a client formats it for the user's time zone. `projectName` is null
 * when the project item is trashed or gone. `canTrigger` is true when the heartbeat is enabled and its
 * rule is not `onItemEvent`.
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

/** The run of a tick thread that is still running (issue #1562). */
export interface SempThreadActiveRun {
  agentRunId: string;
  startedAt: string;
}

/**
 * `GET /api/semp/threads/:id`. Only a tick thread carries `heartbeat` (null when its heartbeat no longer
 * exists) and `activeRun` (null when no run of the thread is running); other kinds carry neither key.
 */
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
