import { createBoundedSempHistory, type ReconstructConversationHistory } from "@semprec/agent-runtime";
import type { BlobStorageWriter } from "@semprec/data";
import { expandSempRefs } from "./refExpansion.js";

export function createSempHistoryReconstruction(roots?: {
  files: BlobStorageWriter;
  mailAttachments: BlobStorageWriter;
}): ReconstructConversationHistory {
  const reconstruct = createBoundedSempHistory();
  return async (pool, wake) => {
    const history = await reconstruct(pool, wake);
    if (!history) return null;
    const entries = [];
    for (const entry of history.entries) {
      wake.signal?.throwIfAborted();
      if (entry.message.kind !== "user_message") {
        entries.push(entry);
        continue;
      }
      const expanded = await expandSempRefs(pool, entry.message.context, roots, wake.signal, wake.projectItemId);
      const text = typeof entry.message.text === "string" ? entry.message.text : "";
      entries.push({
        ...entry,
        message: { ...entry.message, text: expanded.text ? `${expanded.text}\n\n${text}` : text },
        images: expanded.images,
      });
    }
    return { entries, compacted: false };
  };
}
