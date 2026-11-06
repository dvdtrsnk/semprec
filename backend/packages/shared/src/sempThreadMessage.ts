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
