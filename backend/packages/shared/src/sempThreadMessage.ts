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
  run: { startedAt: string; finishedAt: string | null; status: "running" | "done" | "error" } | null;
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
