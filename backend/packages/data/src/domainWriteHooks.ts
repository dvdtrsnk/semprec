// The composition point for the choke point's per-process hook registries (chokePoint/hooks.ts):
// the one place that imports every domain's hook by name and registers it, so chokePoint/ itself
// never has to. Side-effect only — imported for its registration calls, not any export.
// `backend/packages/data/src/index.ts` imports this first, before anything else, so every
// process that loads @semprec/data registers these hooks before any write; a test importing a
// choke-point module by its deep path (bypassing the barrel) must import this file itself.
// See docs/adr/2026-09-30-choke-point-domain-hooks-through-a-per-process-registry.md.
import { registerItemCreateHook, registerItemUpdateHook, registerRelationEdgeWriteHook } from "./chokePoint/hooks.js";
import { mcpServerItemCreateHook, mcpServerItemUpdateHook } from "./mcp/mcpServerWriteHook.js";
import { mailMessageFlagsItemUpdateHook } from "./mail/mailMessageFlagSyncStore.js";
import { taskRecurrenceItemUpdateHook } from "./tasks/taskRecurrenceItemUpdateHook.js";
import { transcriptSpeakerEdgeWriteHook } from "./transcription/transcriptionSpeakerEdges.js";

registerItemCreateHook(mcpServerItemCreateHook);
registerItemUpdateHook(mcpServerItemUpdateHook);
registerItemUpdateHook(mailMessageFlagsItemUpdateHook);
registerItemUpdateHook(taskRecurrenceItemUpdateHook);
registerRelationEdgeWriteHook(transcriptSpeakerEdgeWriteHook);
