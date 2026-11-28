package cz.alldots.app.data

import cz.alldots.app.domain.CalendarChanges
import cz.alldots.app.domain.CalendarInvitation
import cz.alldots.app.domain.InvitationAnswer
import cz.alldots.app.domain.InvitationRepository
import cz.alldots.app.domain.RepositoryResult
import io.ktor.http.HttpMethod
import kotlinx.serialization.encodeToString

/**
 * The invitations of the person: the stored items of the Invitations database, newest event first, and the one
 * write the server offers, `POST /api/calendar/invitations/:id/respond`, which also creates or removes the event
 * the answer implies. A successful answer raises [changes], so the calendar shows the event at once.
 */
class HttpInvitationRepository(
    private val api: AuthenticatedApi,
    private val changes: CalendarChanges,
) : InvitationRepository {
    private val databases = CalendarDatabases(api)

    override suspend fun invitations(): RepositoryResult<List<CalendarInvitation>> =
        when (val items = databases.items(CalendarDatabaseKeys.INVITATIONS)) {
            is RepositoryResult.Failure -> items
            is RepositoryResult.Content -> RepositoryResult.Content(
                items.value.mapNotNull { it.toInvitation() }.sortedBy { it.startsAt.orEmpty() },
            )
        }

    override suspend fun respond(invitationId: String, answer: InvitationAnswer): RepositoryResult<Unit> {
        val body = ApiJson.encodeToString(InvitationRespondRequest(answer.wireName()))
        val result = api.send(HttpMethod.Post, "/api/calendar/invitations/$invitationId/respond", body = body)
            .ignoreBody()
        if (result is RepositoryResult.Content) changes.changed()
        return result
    }
}

private fun InvitationAnswer.wireName(): String = when (this) {
    InvitationAnswer.ACCEPT -> "accepted"
    InvitationAnswer.TENTATIVE -> "tentative"
    InvitationAnswer.DECLINE -> "declined"
    InvitationAnswer.ACKNOWLEDGE -> "acknowledged"
}
