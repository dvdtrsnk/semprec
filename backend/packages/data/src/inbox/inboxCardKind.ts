import {
  AREAS_MODULE_ID,
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
 * The canonical kind of an Inbox card, derived on read and stored nowhere. The whole union is
 * declared up front; `journal` (#1975), `recording` (#1978), `mcp` (#1973) and the primary
 * step of a multi-step proposal (#1492) are produced by those issues, not by this function yet.
 */
export type InboxCardKind =
  | "task"
  | "event"
  | "page"
  | "journal"
  | "project"
  | "area"
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
  /** The kind of the target the card writes or edits. */
  baseKind: InboxCardKind;
}

export interface InboxCardKindInput {
  /** The Processing proposals card's `kind`. */
  kind: "inbox" | "transcript";
  /** The stored proposal status, or the compute state (`computing`, `computeFailed`) of a card being computed. */
  status: string;
  /** The stored envelope, or `null` when none was computed. */
  envelope: ProposalEnvelope | UnknownKindProposalEnvelope | null;
  /**
   * `databases.owner_module_id` of the envelope's target: the target database of a `database`
   * envelope, or the database owning the target page of a `pageContent` envelope (the Journal
   * module for a day's Journal page). `null` when unknown.
   */
  ownerModuleId: string | null;
}

const KIND_BY_OWNER_MODULE: Readonly<Record<string, InboxCardKind>> = {
  [TASKS_MODULE_ID]: "task",
  [EVENTS_MODULE_ID]: "event",
  [PROJECTS_MODULE_ID]: "project",
  [AREAS_MODULE_ID]: "area",
  [COMPANIES_MODULE_ID]: "company",
  [PEOPLE_MODULE_ID]: "person",
  [HEALTH_RECORDS_MODULE_ID]: "health",
  [FILES_MODULE_ID]: "file",
};

const CLARIFY: InboxCardKinds = { cardKind: "clarify", baseKind: "clarify" };

/** The kinds of a pending approval request. */
export function deriveApprovalCardKind(): InboxCardKinds {
  return { cardKind: "approval", baseKind: "approval" };
}

function deriveFromEnvelope(
  input: InboxCardKindInput,
  envelope: ProposalEnvelope | UnknownKindProposalEnvelope,
): InboxCardKinds {
  if ("unknownKind" in envelope) return { cardKind: "clarify", baseKind: "page" };
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
    default:
      return { cardKind: "clarify", baseKind: "page" };
  }
}

/** Pure: derives a card's `cardKind` and `baseKind` from already-loaded data and never reads storage. */
export function deriveInboxCardKind(input: InboxCardKindInput): InboxCardKinds {
  const { status, envelope } = input;
  if (status === "needsClarification") return CLARIFY;
  if (status === "invalid") {
    return { cardKind: "invalid", baseKind: envelope ? deriveFromEnvelope(input, envelope).baseKind : "invalid" };
  }
  // `computing`, `computeFailed` and every other status resolve the same way from the envelope.
  return envelope ? deriveFromEnvelope(input, envelope) : CLARIFY;
}
