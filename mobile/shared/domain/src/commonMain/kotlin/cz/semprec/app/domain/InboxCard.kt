package cz.semprec.app.domain

/** The canonical kind of a card, which decides how it is presented; the server derives it. */
enum class InboxCardKind {
    TASK, EVENT, PAGE, JOURNAL, PROJECT, AREA, COMPANY, PERSON, HEALTH, FILE, RECORDING, MCP,
    INVALID, CLARIFY, TRANSCRIPT_EVENT, SPEAKER, APPROVAL,

    /** A kind this version of the app does not know; such a card can only be discarded. */
    UNSUPPORTED,
}

/** Where a card stands: [PENDING] is the only status of an approval, the others are the stored proposal statuses. */
enum class InboxCardStatus { PROPOSED, COMPUTING, COMPUTE_FAILED, NEEDS_CLARIFICATION, INVALID, PENDING }

/** What a card was made from. */
sealed interface InboxOrigin {
    /** The capture of an Inbox item: its text, the day and time it was captured, its type and its files. */
    data class Capture(
        val itemId: String,
        val text: String?,
        val date: String?,
        val time: String?,
        val typeLabel: String?,
        val typeEmoji: String?,
        val attachments: List<InboxAttachment> = emptyList(),
    ) : InboxOrigin

    data class Transcript(val name: String?, val date: String?) : InboxOrigin

    /** The run that raised an approval; [sourceKind] is `tick`, `mcp` or `chat`. */
    data class Run(
        val sourceKind: String,
        val threadTitle: String?,
        val heartbeatName: String?,
        val mcpClientName: String?,
    ) : InboxOrigin
}

/** The database a card writes to, labelled in the language of the person. */
data class InboxTarget(val databaseKey: String, val label: String)

/** Why an invalid card cannot be approved: the stored [code], the [field] it is about and the sentence for it. */
data class InboxInvalid(val code: String, val field: String, val text: String)

/** How much harm an approval may do, as the server derives it. */
enum class InboxRisk { IRREVERSIBLE, OUTBOUND, BREAKS_LINK, WRITE }

/** What an approval request asks for: the operation, how risky it is and why the agent asked. */
data class InboxApproval(val risk: InboxRisk, val operation: String, val reason: String?)

/** An event the recording may belong to, or a person a speaker may be, as the producer of the card proposed it. */
data class InboxCandidate(
    val id: String,
    val label: String,
    val detail: String? = null,
    val date: String? = null,
    val timeFrom: String? = null,
    val timeTo: String? = null,
)

/** What the producer of a card put beside its proposal, for the cards that need more than their envelope. */
sealed interface InboxContext {
    data object None : InboxContext

    /** A recording that overlaps these events. */
    data class Recording(val candidates: List<InboxCandidate>) : InboxContext

    /** A transcript that overlaps these events; [recommended] is the one the assistant picked. */
    data class Meeting(val candidates: List<InboxCandidate>, val recommended: String?, val reason: String?) :
        InboxContext

    /** A speaker of a transcript: the key the transcript knows, what they said and the people they may be. */
    data class Speaker(
        val speaker: String,
        val ordinal: Int,
        val quotes: List<String>,
        val reason: String,
        val alternatives: List<InboxCandidate>,
    ) : InboxContext
}

/**
 * One card of the stack. [version] is the card's `version` (the `ifVersion` of every decision on it). [schema] is
 * the editor of its kind; [properties] says what the target database knows of each property the editor names.
 * [userValues] and [editedKeys] are what the person changed in this session: the server's answer to an edit, which
 * the card list does not carry.
 */
data class InboxCard(
    val id: String,
    val kind: InboxCardKind,
    val baseKind: InboxCardKind,
    val status: InboxCardStatus,
    val version: String?,
    val origin: InboxOrigin?,
    val targets: List<InboxTarget>,
    val envelope: InboxEnvelope?,
    val schema: InboxSchema?,
    val invalid: InboxInvalid? = null,
    val approval: InboxApproval? = null,
    val context: InboxContext = InboxContext.None,
    val properties: Map<String, InboxPropertyInfo> = emptyMap(),
    val userValues: Map<String, InboxValue> = emptyMap(),
    val editedKeys: Set<String> = emptySet(),
    val timedOut: Boolean = false,
)

/** The stack of open cards and how many of them wait for a decision (computing ones are listed, not counted). */
data class InboxStack(val cards: List<InboxCard>, val total: Int)

/** An Inbox item type: what a card that needs clarification may become. */
data class InboxType(val id: String, val label: String, val emoji: String, val targetLabel: String?)
