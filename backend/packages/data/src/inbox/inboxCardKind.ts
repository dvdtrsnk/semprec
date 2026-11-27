import {
  COMPANIES_MODULE_ID,
  EVENTS_MODULE_ID,
  FILES_MODULE_ID,
  HEALTH_RECORDS_MODULE_ID,
  JOURNAL_MODULE_ID,
  PEOPLE_MODULE_ID,
  PROJECTS_MODULE_ID,
  TASKS_MODULE_ID,
} from "../seed/tenDatabaseKeys.js";
import type { ProposalEnvelope } from "./inboxTickAction.js";
import type { UnknownKindProposalEnvelope } from "./proposalEnvelope.js";
import { transcriptCardRole } from "./proposalActions.js";

/**
 * Derived on read and stored nowhere. `mcp` and the multi-step primary kind are declared but not produced here yet.
 * `journal` is a `journalEntry` envelope or page content on a Journal day; `recording` is a `transcription` envelope.
 */
export type InboxCardKind =
  | "task"
  | "event"
  | "page"
  | "journal"
  | "project"
  | "company"
  | "person"
  | "health"
  | "file"
  | "recording"
  | "mcp"
  | "invalid"
  | "clarify"
  | "transcriptEvent"
  | "speaker"
  | "approval";

export interface InboxCardKinds {
  cardKind: InboxCardKind;
  baseKind: InboxCardKind;
}

export interface InboxCardKindInput {
  kind: "inbox" | "transcript" | "mailThread";
  /** The stored proposal status, or a compute state (`computing`, `computeFailed`). */
  status: string;
  envelope: ProposalEnvelope | UnknownKindProposalEnvelope | null;
  /**
   * `databases.owner_module_id` of the target database, or of the database owning the target page of a
   * `pageContent` envelope. `null` when unknown.
   */
  ownerModuleId: string | null;
}

const KIND_BY_OWNER_MODULE: Readonly<Record<string, InboxCardKind>> = {
  [TASKS_MODULE_ID]: "task",
  [EVENTS_MODULE_ID]: "event",
  [PROJECTS_MODULE_ID]: "project",
  [COMPANIES_MODULE_ID]: "company",
  [PEOPLE_MODULE_ID]: "person",
  [HEALTH_RECORDS_MODULE_ID]: "health",
  [FILES_MODULE_ID]: "file",
};

const CLARIFY: InboxCardKinds = { cardKind: "clarify", baseKind: "clarify" };

export function deriveApprovalCardKind(): InboxCardKinds {
  return { cardKind: "approval", baseKind: "approval" };
}

function deriveFromEnvelope(
  input: InboxCardKindInput,
  envelope: ProposalEnvelope | UnknownKindProposalEnvelope,
): InboxCardKinds {
  if ("unknownKind" in envelope) return { cardKind: "clarify", baseKind: "page" };
  // A thread task card only ever proposes a task.
  if (input.kind === "mailThread") {
    return envelope.entityKind === "database" && input.ownerModuleId === TASKS_MODULE_ID
      ? { cardKind: "task", baseKind: "task" }
      : { cardKind: "clarify", baseKind: "page" };
  }
  if (input.kind === "transcript" && envelope.entityKind === "database") {
    return input.ownerModuleId === EVENTS_MODULE_ID
      ? { cardKind: "transcriptEvent", baseKind: "event" }
      : { cardKind: "clarify", baseKind: "page" };
  }
  if (input.kind === "transcript" && envelope.entityKind === "relation") {
    return transcriptCardRole(envelope) === "speaker"
      ? { cardKind: "speaker", baseKind: "speaker" }
      : { cardKind: "transcriptEvent", baseKind: "event" };
  }
  switch (envelope.entityKind) {
    case "database": {
      const known =
        input.ownerModuleId !== null && Object.hasOwn(KIND_BY_OWNER_MODULE, input.ownerModuleId)
          ? KIND_BY_OWNER_MODULE[input.ownerModuleId]
          : undefined;
      return known ? { cardKind: known, baseKind: known } : { cardKind: "clarify", baseKind: "page" };
    }
    case "pageContent": {
      const kind = input.ownerModuleId === JOURNAL_MODULE_ID ? "journal" : "page";
      return { cardKind: kind, baseKind: kind };
    }
    // The target of a `journalEntry` envelope is the Journal database itself, never a page, so no owner decides it.
    case "journalEntry":
      return { cardKind: "journal", baseKind: "journal" };
    case "transcription":
      return { cardKind: "recording", baseKind: "recording" };
    default:
      return { cardKind: "clarify", baseKind: "page" };
  }
}

export function deriveInboxCardKind(input: InboxCardKindInput): InboxCardKinds {
  const { status, envelope } = input;
  if (status === "needsClarification") return CLARIFY;
  if (status === "invalid") {
    return { cardKind: "invalid", baseKind: envelope ? deriveFromEnvelope(input, envelope).baseKind : "invalid" };
  }
  return envelope ? deriveFromEnvelope(input, envelope) : CLARIFY;
}
