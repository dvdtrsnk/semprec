// Who made a write: a person, an agent acting for a person, or the system itself. Threaded
// additively through the choke point's item and relation writes and into every write hook
// context. It is derived server-side by the caller's composition root, never read from a request.

export type WriterKind = "user" | "agent" | "system";

export interface WriterIdentity {
  writerKind: WriterKind;
  /** The agent run that made the write; set only for an `agent` written under a run credential. */
  agentRunId?: string;
  /** The agent's Projects item; set only for an `agent` written under a run credential. */
  agentProjectItemId?: string;
  /**
   * Set only for an `agent` writer that is an external AI client on `/mcp` with a human token (issue #1998): a
   * sensitive database is refused to it for reads and writes. Never set together with `agentProjectItemId`.
   */
  externalClient?: true;
  /** The user whose session or run made the write; set on every `agent` value. */
  onBehalfOfUserId?: string;
  /** Set by the approved executor only for its revalidated mutation. */
  approvedRequestId?: string;
}

/** The conservative default for internal code that passes no writer. */
export const SYSTEM_WRITER: WriterIdentity = Object.freeze({ writerKind: "system" });
