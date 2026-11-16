package cz.semprec.app.domain

/** Whether an invitation asks for an answer or only tells that something was added to a shared calendar. */
enum class InvitationKind { INVITE, SHARED_CALENDAR_NOTICE }

/** Where an invitation stands; every status but [PENDING] is an answer. */
enum class InvitationStatus { PENDING, ACCEPTED, TENTATIVE, DECLINED, ACKNOWLEDGED, CANCELLED }

/** What a person can answer to an invitation; a notice is only acknowledged. */
enum class InvitationAnswer { ACCEPT, TENTATIVE, DECLINE, ACKNOWLEDGE }

/**
 * One invitation. [startsAt] and [endsAt] are ISO instants as the server stores them, [timeZone] the zone the
 * organizer wrote them in; the screen turns them into a day and a time.
 */
data class CalendarInvitation(
    val id: String,
    val kind: InvitationKind,
    val status: InvitationStatus,
    val title: String,
    val startsAt: String?,
    val endsAt: String?,
    val timeZone: String?,
    val allDay: Boolean,
    val place: String?,
    val organizerName: String?,
    val organizerEmail: String?,
)

/** The invitations of the person, and the one write: the answer. */
interface InvitationRepository {
    suspend fun invitations(): RepositoryResult<List<CalendarInvitation>>

    suspend fun respond(invitationId: String, answer: InvitationAnswer): RepositoryResult<Unit>
}

/** Whether [answer] is one the server accepts for an invitation of [kind]. */
fun InvitationAnswer.fits(kind: InvitationKind): Boolean =
    (this == InvitationAnswer.ACKNOWLEDGE) == (kind == InvitationKind.SHARED_CALENDAR_NOTICE)

/** Whether a person still has to answer: a pending invitation. A cancelled one has nothing to answer. */
val CalendarInvitation.needsAnswer: Boolean get() = status == InvitationStatus.PENDING

/** The answer a status records, or `null` for one that is no answer. */
fun InvitationStatus.answer(): InvitationAnswer? = when (this) {
    InvitationStatus.ACCEPTED -> InvitationAnswer.ACCEPT
    InvitationStatus.TENTATIVE -> InvitationAnswer.TENTATIVE
    InvitationStatus.DECLINED -> InvitationAnswer.DECLINE
    InvitationStatus.ACKNOWLEDGED -> InvitationAnswer.ACKNOWLEDGE
    InvitationStatus.PENDING, InvitationStatus.CANCELLED -> null
}
