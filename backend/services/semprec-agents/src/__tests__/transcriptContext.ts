import type { Tool, TranscriptContext } from "@earendil-works/pi-ai";

/** The system prompt a request carried; pi folds it into the transcript's leading system message. */
export function systemPromptOf(context: TranscriptContext): string | undefined {
  const lead = context.messages[0];
  if (lead?.role !== "system") return undefined;
  return typeof lead.content === "string" ? lead.content : lead.content.map((block) => block.text).join("");
}

/** The tools a request offered; pi folds them into the transcript's system messages. */
export function toolsOf(context: TranscriptContext): Tool[] {
  return context.messages.flatMap((message) => (message.role === "system" ? (message.toolsAdded ?? []) : []));
}

type TranscriptMessage = TranscriptContext["messages"][number];

/** The conversation a request carried, without the system messages pi folds the prompt and tools into. */
export function conversationOf(context: TranscriptContext): Exclude<TranscriptMessage, { role: "system" }>[] {
  return context.messages.filter(
    (message): message is Exclude<TranscriptMessage, { role: "system" }> => message.role !== "system",
  );
}
