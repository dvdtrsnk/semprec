package cz.semprec.app.presentation

import cz.semprec.app.core.FailureKind

enum class InvitationsPhase { LOADING, CONTENT, ERROR }

/** Which of the two lists the sheet shows: the invitations that wait for an answer, or the answered ones. */
enum class InvitationsTab { PENDING, ANSWERED }

enum class InvitationItemKind { INVITE, SHARED_CALENDAR_NOTICE }

/** Where an invitation stands; every status but [PENDING] is an answer. */
enum class InvitationItemStatus { PENDING, ACCEPTED, TENTATIVE, DECLINED, ACKNOWLEDGED, CANCELLED }

/** What a person answers; a notice is only acknowledged. */
enum class InvitationReply { ACCEPT, TENTATIVE, DECLINE, ACKNOWLEDGE }

/**
 * One invitation. [startsAt] and [endsAt] are ISO instants, [timeZone] the zone to show them in; the screen turns
 * them into a day and a time of day.
 */
data class InvitationItem(
    val id: String,
    val kind: InvitationItemKind,
    val status: InvitationItemStatus,
    val title: String,
    val startsAt: String?,
    val endsAt: String?,
    val timeZone: String?,
    val allDay: Boolean,
    val place: String?,
    val organizerName: String?,
)

/**
 * The invitations sheet. [items] are the ones of the shown [tab]; [pending] is how many wait for an answer, which
 * is also the count on the calendar's badge. [answering] is the invitation whose answer is being sent.
 */
data class InvitationsState(
    val phase: InvitationsPhase,
    val failure: FailureKind?,
    val tab: InvitationsTab,
    val items: List<InvitationItem>,
    val pending: Int,
    val answering: String?,
    val problem: Boolean,
    val problemFailure: FailureKind?,
)

sealed interface InvitationsAction {
    data object Retry : InvitationsAction

    data class ShowTab(val tab: InvitationsTab) : InvitationsAction

    data class Answer(val invitationId: String, val reply: InvitationReply) : InvitationsAction

    data object DismissProblem : InvitationsAction
}
