package cz.alldots.app.presentation

import cz.alldots.app.core.FailureKind

enum class InboxPhase { LOADING, CONTENT, ERROR }

/** The kind of a card, which decides how it is presented. */
enum class InboxCardType {
    TASK, EVENT, PAGE, JOURNAL, PROJECT, COMPANY, PERSON, HEALTH, FILE, RECORDING, MCP,
    INVALID, CLARIFY, TRANSCRIPT_EVENT, SPEAKER, APPROVAL, UNSUPPORTED,
}

/** Where a card stands; [PENDING] is the only phase of an approval of Semp. */
enum class InboxCardPhase { PROPOSED, COMPUTING, COMPUTE_FAILED, NEEDS_CLARIFICATION, INVALID, PENDING }

/** Whether a card may be approved now, and if not, why. */
enum class InboxApprovable { READY, MISSING_FIELDS, COMPUTING, COMPUTE_FAILED, INVALID, UNSUPPORTED }

enum class InboxFieldType { TEXT, AREA, DATE, DATETIME, SELECT, MULTI, TOGGLE, SEG, COLOR, SECRET, INFO, CHOICE, TILE }

enum class InboxKeyboard { TEXT, EMAIL, URL, TEL }

enum class InboxRiskLevel { IRREVERSIBLE, OUTBOUND, BREAKS_LINK, WRITE }

enum class InboxOriginKind { CAPTURE, TRANSCRIPT, RUN }

/** What went wrong that the person should hear about; [InboxState.problemFailure] says why when it is known. */
enum class InboxProblem { EDIT, DECISION, UNDO, RECOMPUTE }

enum class InboxPickerPhase { LOADING, READY, ERROR }

/**
 * One choice of a picker, a segmented control, a colour row or a list of choices. [id] is `null` for the "none"
 * choice. [label] is empty for a static option whose text the screen knows by its [id].
 */
data class InboxChoiceItem(
    val id: String?,
    val label: String,
    val color: String?,
    val initials: String?,
    val hint: String?,
    val date: String?,
    val timeFrom: String?,
    val timeTo: String?,
    val selected: Boolean,
    val disabled: Boolean,
    val suggested: Boolean,
    val none: Boolean,
    val isNew: Boolean,
)

/**
 * One control of a card and what it holds. Which members matter follows [type]: [text] for a text, a Markdown text or
 * the label of a read-only note; [flag] for a switch, and for a secret whether one is typed; [date] and [time] for a
 * date and the time of a date-and-time (which has none while [showTime] is `false`); [selected] and [options] for
 * every control that chooses. [label] is empty for a field the app declares itself, whose text the screen knows by
 * its [key].
 */
data class InboxFieldState(
    val key: String,
    val type: InboxFieldType,
    val keyboard: InboxKeyboard,
    val label: String,
    val placeholder: String?,
    val required: Boolean,
    val missing: Boolean,
    val edited: Boolean,
    val text: String,
    val flag: Boolean,
    val date: String?,
    val time: String?,
    val showTime: Boolean,
    val selected: List<InboxChoiceItem>,
    val options: List<InboxChoiceItem>,
    val needsPicker: Boolean,
    val info: String?,
)

data class InboxGroupState(val key: String, val fields: List<InboxFieldState>)

/** What a card was made from. Which members matter follows [kind]. */
data class InboxOriginState(
    val kind: InboxOriginKind,
    val text: String?,
    val date: String?,
    val time: String?,
    val typeLabel: String?,
    val typeEmoji: String?,
    val name: String?,
    val sourceKind: String?,
    val threadTitle: String?,
    val heartbeatName: String?,
    val mcpClientName: String?,
)

data class InboxApprovalState(val risk: InboxRiskLevel, val operation: String, val reason: String?)

/** One card of the stack. */
data class InboxCardState(
    val id: String,
    val type: InboxCardType,
    val baseType: InboxCardType,
    val phase: InboxCardPhase,
    val approvable: InboxApprovable,
    val origin: InboxOriginState?,
    val targets: List<String>,
    val invalidText: String?,
    val invalidField: String?,
    val approval: InboxApprovalState?,
    val groups: List<InboxGroupState>,
    val quotes: List<String>,
    val reason: String?,
    val edited: Boolean,
    val saving: Boolean,
)

/** The item a decision created or changed, which the toast offers to show. */
data class InboxResultState(val label: String, val databaseKey: String?, val itemId: String?)

/** The picker of the field [key] of the card [cardId], open over the card. */
data class InboxPickerState(
    val cardId: String,
    val key: String,
    val multi: Boolean,
    val phase: InboxPickerPhase,
    val options: List<InboxChoiceItem>,
)

/**
 * The Inbox: the cards that wait for a decision, the top one first. [handled] and [dropped] count what the person
 * decided in this visit, for the summary shown once the stack is empty.
 */
data class InboxState(
    val phase: InboxPhase = InboxPhase.LOADING,
    val failure: FailureKind? = null,
    val cards: List<InboxCardState> = emptyList(),
    val handled: Int = 0,
    val dropped: Int = 0,
    val canUndo: Boolean = false,
    val refreshing: Boolean = false,
    val busy: Boolean = false,
    val result: InboxResultState? = null,
    val problem: InboxProblem? = null,
    val problemFailure: FailureKind? = null,
    val picker: InboxPickerState? = null,
)
