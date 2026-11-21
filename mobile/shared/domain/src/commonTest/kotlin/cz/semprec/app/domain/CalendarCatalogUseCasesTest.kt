package cz.semprec.app.domain

import cz.semprec.app.core.FailureKind
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

private class RecordingCatalog : CalendarCatalogRepository {
    val calls = mutableListOf<String>()

    override suspend fun calendars(): RepositoryResult<List<CalendarInfo>> = RepositoryResult.Content(emptyList())

    override suspend fun edit(calendar: CalendarInfo, change: CalendarEdit): RepositoryResult<Unit> {
        calls += "edit ${calendar.id} ${change.name} ${change.hidden}" + if (change.useRemoteColor) " remote" else ""
        return RepositoryResult.Content(Unit)
    }

    override suspend fun create(name: String, color: String): RepositoryResult<String> {
        calls += "create $name $color"
        return RepositoryResult.Content("c9")
    }

    override suspend fun cancellationImpact(calendarId: String): RepositoryResult<CalendarCancellationImpact> =
        RepositoryResult.Content(CalendarCancellationImpact(1, 2, 3))

    override suspend fun delete(calendarId: String): RepositoryResult<Unit> {
        calls += "delete $calendarId"
        return RepositoryResult.Content(Unit)
    }
}

private class RecordingInvitations : InvitationRepository {
    val calls = mutableListOf<String>()

    override suspend fun invitations(): RepositoryResult<List<CalendarInvitation>> =
        RepositoryResult.Content(emptyList())

    override suspend fun respond(invitationId: String, answer: InvitationAnswer): RepositoryResult<Unit> {
        calls += "$invitationId $answer"
        return RepositoryResult.Content(Unit)
    }
}

private fun invitation(
    kind: InvitationKind = InvitationKind.INVITE,
    status: InvitationStatus = InvitationStatus.PENDING,
) = CalendarInvitation("i1", kind, status, "Review", null, null, null, false, null, null, null)

class CalendarCatalogUseCasesTest {
    @Test fun `an own calendar is renamed with a trimmed name`() = runTest {
        val catalog = RecordingCatalog()
        EditCalendars(catalog).edit(calendar("work"), CalendarEdit(name = "  Job "))
        assertEquals(listOf("edit work Job null"), catalog.calls)
    }

    @Test fun `an empty name and the rename of a system calendar are refused`() = runTest {
        val catalog = RecordingCatalog()
        val edits = EditCalendars(catalog)
        val refused = RepositoryResult.Failure(FailureKind.REJECTED)
        assertEquals(refused, edits.edit(calendar("work"), CalendarEdit(name = "  ")))
        assertEquals(refused, edits.edit(calendar("tasks", kind = CalendarKind.SYSTEM), CalendarEdit(name = "X")))
        assertTrue(catalog.calls.isEmpty())
    }

    @Test fun `any calendar can be hidden or recoloured`() = runTest {
        val catalog = RecordingCatalog()
        val system = calendar("tasks", kind = CalendarKind.SYSTEM)
        val result = EditCalendars(catalog).edit(system, CalendarEdit(hidden = true))
        assertEquals(RepositoryResult.Content(Unit), result)
        assertEquals(listOf("edit tasks null true"), catalog.calls)
    }

    @Test fun `an account calendar is renamed here and goes back to the provider colour`() = runTest {
        val catalog = RecordingCatalog()
        val edits = EditCalendars(catalog)
        val account = calendar("google", kind = CalendarKind.ACCOUNT)
        assertEquals(RepositoryResult.Content(Unit), edits.edit(account, CalendarEdit(name = " Rodina ")))
        assertEquals(RepositoryResult.Content(Unit), edits.edit(account, CalendarEdit(useRemoteColor = true)))
        assertEquals(listOf("edit google Rodina null", "edit google null null remote"), catalog.calls)
    }

    @Test fun `only an account calendar goes back to a provider colour`() = runTest {
        val catalog = RecordingCatalog()
        val edits = EditCalendars(catalog)
        val refused = RepositoryResult.Failure(FailureKind.REJECTED)
        listOf(CalendarKind.OWN, CalendarKind.SYSTEM, CalendarKind.SUBSCRIPTION).forEach { kind ->
            assertEquals(refused, edits.edit(calendar("c", kind = kind), CalendarEdit(useRemoteColor = true)), "$kind")
        }
        assertTrue(catalog.calls.isEmpty())
    }

    @Test fun `an account calendar is not deleted`() = runTest {
        val catalog = RecordingCatalog()
        val refused = RepositoryResult.Failure(FailureKind.REJECTED)
        assertEquals(refused, EditCalendars(catalog).delete(calendar("google", kind = CalendarKind.ACCOUNT)))
        assertTrue(catalog.calls.isEmpty())
    }

    @Test fun `a new event goes on an own calendar or a writable account calendar`() {
        val cases = listOf(
            calendar("own") to true,
            calendar("google", kind = CalendarKind.ACCOUNT) to true,
            calendar("shared", kind = CalendarKind.ACCOUNT).copy(readOnly = true) to false,
            calendar("tasks", kind = CalendarKind.SYSTEM) to false,
            calendar("feed", kind = CalendarKind.SUBSCRIPTION) to false,
        )
        cases.forEach { (calendar, takes) -> assertEquals(takes, calendar.takesNewEvents, calendar.id) }
    }

    @Test fun `a new calendar needs a name`() = runTest {
        val catalog = RecordingCatalog()
        val edits = EditCalendars(catalog)
        assertEquals(RepositoryResult.Failure(FailureKind.REJECTED), edits.create("   ", "#FF9500"))
        assertEquals(RepositoryResult.Content("c9"), edits.create(" Trips ", "#FF9500"))
        assertEquals(listOf("create Trips #FF9500"), catalog.calls)
    }

    @Test fun `only an own calendar that is not the default is deleted`() = runTest {
        val catalog = RecordingCatalog()
        val edits = EditCalendars(catalog)
        val refused = RepositoryResult.Failure(FailureKind.REJECTED)
        assertEquals(refused, edits.delete(calendar("personal", isDefault = true)))
        assertEquals(refused, edits.delete(calendar("tasks", kind = CalendarKind.SYSTEM)))
        assertEquals(refused, edits.delete(calendar("feed", kind = CalendarKind.SUBSCRIPTION)))
        assertEquals(RepositoryResult.Content(Unit), edits.delete(calendar("work")))
        assertEquals(listOf("delete work"), catalog.calls)
    }

    @Test fun `an invitation takes accept maybe and decline and a notice only an acknowledgement`() = runTest {
        val repository = RecordingInvitations()
        val answer = AnswerInvitation(repository)
        val refused = RepositoryResult.Failure(FailureKind.REJECTED)
        val notice = invitation(InvitationKind.SHARED_CALENDAR_NOTICE)
        assertEquals(RepositoryResult.Content(Unit), answer(invitation(), InvitationAnswer.ACCEPT))
        assertEquals(RepositoryResult.Content(Unit), answer(invitation(), InvitationAnswer.TENTATIVE))
        assertEquals(refused, answer(invitation(), InvitationAnswer.ACKNOWLEDGE))
        assertEquals(refused, answer(notice, InvitationAnswer.ACCEPT))
        assertEquals(RepositoryResult.Content(Unit), answer(notice, InvitationAnswer.ACKNOWLEDGE))
        assertEquals(listOf("i1 ACCEPT", "i1 TENTATIVE", "i1 ACKNOWLEDGE"), repository.calls)
    }

    @Test fun `an answered or cancelled invitation is not answered again`() = runTest {
        val repository = RecordingInvitations()
        val answer = AnswerInvitation(repository)
        val refused = RepositoryResult.Failure(FailureKind.REJECTED)
        assertEquals(refused, answer(invitation(status = InvitationStatus.ACCEPTED), InvitationAnswer.DECLINE))
        assertEquals(refused, answer(invitation(status = InvitationStatus.CANCELLED), InvitationAnswer.ACCEPT))
        assertTrue(repository.calls.isEmpty())
    }

    @Test fun `a status records the answer that made it`() {
        assertEquals(InvitationAnswer.ACCEPT, InvitationStatus.ACCEPTED.answer())
        assertEquals(InvitationAnswer.TENTATIVE, InvitationStatus.TENTATIVE.answer())
        assertEquals(InvitationAnswer.DECLINE, InvitationStatus.DECLINED.answer())
        assertEquals(InvitationAnswer.ACKNOWLEDGE, InvitationStatus.ACKNOWLEDGED.answer())
        assertEquals(null, InvitationStatus.PENDING.answer())
        assertEquals(null, InvitationStatus.CANCELLED.answer())
    }

    @Test fun `the change counter rises with each change`() {
        val changes = CalendarChanges()
        assertEquals(0, changes.revision.value)
        changes.changed()
        changes.changed()
        assertEquals(2, changes.revision.value)
    }
}
