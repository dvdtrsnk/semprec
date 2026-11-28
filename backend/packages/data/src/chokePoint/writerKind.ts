// Who made a write. Derived server-side by the caller's composition root, never read from a request.

export type WriterKind = "user" | "agent" | "system";

/** The system processes a domain rule tells apart from other system writes. */
export type SystemWriterProcess = "calendarSync";

export interface WriterIdentity {
  writerKind: WriterKind;
  /** Set only for an `agent` written under a run credential. */
  agentRunId?: string;
  /** Set only for an `agent` written under a run credential. */
  agentProjectItemId?: string;
  /** An external AI client on `/mcp` with a human token; refused sensitive databases. Never set with `agentProjectItemId`. */
  externalClient?: true;
  /** The user whose session or run made the write; set on every `agent` value. */
  onBehalfOfUserId?: string;
  /** Set by the approved executor only for its revalidated mutation. */
  approvedRequestId?: string;
  /** Set only on a `system` value, by the named process. */
  systemProcess?: SystemWriterProcess;
}

export const SYSTEM_WRITER: WriterIdentity = Object.freeze({ writerKind: "system" });

/** The calendar sync: writes account calendars, their remote fields and the events of read-only ones. */
export const CALENDAR_SYNC_WRITER: WriterIdentity = Object.freeze({
  writerKind: "system",
  systemProcess: "calendarSync",
});
