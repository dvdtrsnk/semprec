package cz.semprec.app.presentation

import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.CalendarCancellationImpact
import cz.semprec.app.domain.CalendarCatalogRepository
import cz.semprec.app.domain.CalendarChanges
import cz.semprec.app.domain.CalendarDay
import cz.semprec.app.domain.CalendarEdit
import cz.semprec.app.domain.CalendarEntry
import cz.semprec.app.domain.CalendarEntryKind
import cz.semprec.app.domain.CalendarInfo
import cz.semprec.app.domain.CalendarInvitation
import cz.semprec.app.domain.CalendarKind
import cz.semprec.app.domain.CalendarRepository
import cz.semprec.app.domain.CalendarSchedule
import cz.semprec.app.domain.CalendarTimeline
import cz.semprec.app.domain.CalendarWindow
import cz.semprec.app.domain.ClockTime
import cz.semprec.app.domain.InvitationAnswer
import cz.semprec.app.domain.InvitationKind
import cz.semprec.app.domain.InvitationRepository
import cz.semprec.app.domain.InvitationStatus
import cz.semprec.app.domain.NewCalendarItem
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.SleepNightEntry
import kotlinx.coroutines.CompletableDeferred

val DAY_ZERO = CalendarDay(2026, 10, 16)

fun schedule(from: String?, to: String?, day: CalendarDay = DAY_ZERO, endDay: CalendarDay? = null) =
    CalendarSchedule(day, endDay, from?.let { ClockTime.parse(it) }, to?.let { ClockTime.parse(it) })

fun entry(
    id: String,
    kind: CalendarEntryKind = CalendarEntryKind.EVENT,
    schedule: CalendarSchedule = schedule("10:00", "11:00"),
    calendarId: String? = "work",
    readOnly: Boolean = false,
    status: String? = null,
    seriesId: String? = null,
) = CalendarEntry(
    id = id,
    kind = kind,
    title = "Title $id",
    calendarId = calendarId,
    date = schedule.date,
    endDate = schedule.endDate,
    timeFrom = schedule.timeFrom,
    timeTo = schedule.timeTo,
    effectiveTo = schedule.timeTo,
    allDay = schedule.timeFrom == null,
    status = status,
    place = null,
    readOnly = readOnly,
    version = "v-$id",
    seriesId = seriesId,
    occurrenceDate = schedule.date.takeIf { seriesId != null },
)

fun sleepEntry(night: CalendarDay, bed: String = "23:00", wake: String = "06:45") = CalendarEntry(
    id = "sleep:$night",
    kind = CalendarEntryKind.SLEEP,
    title = "",
    calendarId = null,
    date = night,
    endDate = null,
    timeFrom = null,
    timeTo = null,
    effectiveTo = null,
    allDay = false,
    status = null,
    place = null,
    readOnly = false,
    version = null,
    sleep = SleepNightEntry(
        night,
        ClockTime.parse(bed)!!,
        ClockTime.parse(wake)!!,
        alarm = true,
        changed = false,
        prepReminderAt = "${night}T22:30:00+02:00",
    ),
)

fun calendarInfo(
    id: String,
    color: String = "#007AFF",
    hidden: Boolean = false,
    kind: CalendarKind = CalendarKind.OWN,
    systemKey: String? = null,
    isDefault: Boolean = false,
) = CalendarInfo(id, "Calendar $id", color, true, hidden, isDefault, kind, systemKey, "v-$id")

/** A calendar of the internet account [accountId] with the provider's name and colour, unless [color] was set here. */
fun accountCalendar(
    id: String,
    accountId: String?,
    readOnly: Boolean = false,
    color: String? = null,
) = calendarInfo(id, color ?: "#0B8043", kind = CalendarKind.ACCOUNT).copy(
    name = "Remote $id",
    accountId = accountId,
    readOnly = readOnly,
    remoteName = "Remote $id",
    remoteColor = "#0B8043",
    usesRemoteColor = color == null,
)

fun window(
    entries: List<CalendarEntry>,
    calendars: List<CalendarInfo> = listOf(calendarInfo("work")),
    pending: Int = 0,
): CalendarWindow {
    val timeline = CalendarTimeline("Europe/Prague", DAY_ZERO, 13 * 60 + 24, DAY_ZERO, DAY_ZERO, entries)
    return CalendarWindow(timeline, calendars, pending)
}

/** A scripted calendar repository: every call is recorded and answers what the test set. */
class FakeCalendarRepository(val changes: CalendarChanges = CalendarChanges()) : CalendarRepository {
    val calls = mutableListOf<String>()
    var ranges = mutableListOf<Pair<CalendarDay, CalendarDay>>()
    var onWindow: suspend (CalendarDay, CalendarDay) -> RepositoryResult<CalendarWindow> =
        { _, _ -> RepositoryResult.Content(window(emptyList())) }
    var writeResult: RepositoryResult<Unit> = RepositoryResult.Content(Unit)
    var lastSchedule: CalendarSchedule? = null
    var lastDraft: NewCalendarItem? = null

    override suspend fun window(from: CalendarDay, to: CalendarDay): RepositoryResult<CalendarWindow> {
        calls += "window"
        ranges += from to to
        return onWindow(from, to)
    }

    override suspend fun reschedule(entry: CalendarEntry, schedule: CalendarSchedule): RepositoryResult<Unit> {
        calls += "reschedule ${entry.id}"
        lastSchedule = schedule
        return write()
    }

    override suspend fun setTaskDone(entry: CalendarEntry, done: Boolean): RepositoryResult<Unit> {
        calls += "done ${entry.id} $done"
        return write()
    }

    override suspend fun putTaskInEvent(task: CalendarEntry, event: CalendarEntry): RepositoryResult<Unit> {
        calls += "host ${task.id} ${event.id}"
        return write()
    }

    override suspend fun completeTaskInEvent(task: CalendarEntry, event: CalendarEntry): RepositoryResult<Unit> {
        calls += "complete ${task.id} in ${event.id}"
        return write()
    }

    override suspend fun duplicate(entry: CalendarEntry, schedule: CalendarSchedule): RepositoryResult<String> {
        calls += "duplicate ${entry.id}"
        lastSchedule = schedule
        return when (val result = write()) {
            is RepositoryResult.Content -> RepositoryResult.Content("copy")
            is RepositoryResult.Failure -> result
        }
    }

    override suspend fun delete(entry: CalendarEntry): RepositoryResult<Unit> {
        calls += "delete ${entry.id}"
        return write()
    }

    override suspend fun create(draft: NewCalendarItem): RepositoryResult<String> {
        lastDraft = draft
        calls += "create ${draft.kind} ${draft.title} ${draft.schedule.date} ${draft.schedule.timeFrom} " +
            "${draft.schedule.timeTo} ${draft.place} ${draft.calendarId}"
        return when (val result = write()) {
            is RepositoryResult.Content -> RepositoryResult.Content("new1")
            is RepositoryResult.Failure -> result
        }
    }

    private fun write(): RepositoryResult<Unit> {
        if (writeResult is RepositoryResult.Content) changes.changed()
        return writeResult
    }
}

class FakeCatalogRepository(val changes: CalendarChanges = CalendarChanges()) : CalendarCatalogRepository {
    val calls = mutableListOf<String>()
    var calendars = listOf(
        calendarInfo("personal", isDefault = true),
        calendarInfo("work"),
        calendarInfo("tasks", kind = CalendarKind.SYSTEM, systemKey = "tasks"),
        calendarInfo("feed", kind = CalendarKind.SUBSCRIPTION),
    )
    var listResult: RepositoryResult<List<CalendarInfo>>? = null
    var writeResult: RepositoryResult<Unit> = RepositoryResult.Content(Unit)
    var impact: RepositoryResult<CalendarCancellationImpact> =
        RepositoryResult.Content(CalendarCancellationImpact(3, 2, 1))
    /** When set, every write waits for it before it answers. */
    var writeGate: CompletableDeferred<Unit>? = null

    override suspend fun calendars(): RepositoryResult<List<CalendarInfo>> {
        calls += "list"
        return listResult ?: RepositoryResult.Content(calendars)
    }

    override suspend fun edit(calendar: CalendarInfo, change: CalendarEdit): RepositoryResult<Unit> {
        calls += "edit ${calendar.id} ${change.name} ${change.color} ${change.notify} ${change.hidden}" +
            if (change.useRemoteColor) " remoteColor" else ""
        return write()
    }

    override suspend fun create(name: String, color: String): RepositoryResult<String> {
        calls += "create $name $color"
        return when (val result = write()) {
            is RepositoryResult.Content -> {
                calendars = calendars + calendarInfo("new-cal", color)
                RepositoryResult.Content("new-cal")
            }
            is RepositoryResult.Failure -> result
        }
    }

    override suspend fun cancellationImpact(calendarId: String): RepositoryResult<CalendarCancellationImpact> {
        calls += "impact $calendarId"
        return impact
    }

    override suspend fun delete(calendarId: String): RepositoryResult<Unit> {
        calls += "delete $calendarId"
        return write()
    }

    private suspend fun write(): RepositoryResult<Unit> {
        writeGate?.await()
        if (writeResult is RepositoryResult.Content) changes.changed()
        return writeResult
    }
}

class FakeInvitationRepository(val changes: CalendarChanges = CalendarChanges()) : InvitationRepository {
    val calls = mutableListOf<String>()
    var items = listOf(
        invitation("i1"),
        invitation("i2", kind = InvitationKind.SHARED_CALENDAR_NOTICE),
        invitation("i3", status = InvitationStatus.ACCEPTED),
    )
    var listResult: RepositoryResult<List<CalendarInvitation>>? = null
    var respondResult: RepositoryResult<Unit> = RepositoryResult.Content(Unit)
    /** When set, an answer waits for it before it answers. */
    var respondGate: CompletableDeferred<Unit>? = null

    override suspend fun invitations(): RepositoryResult<List<CalendarInvitation>> {
        calls += "list"
        return listResult ?: RepositoryResult.Content(items)
    }

    override suspend fun respond(invitationId: String, answer: InvitationAnswer): RepositoryResult<Unit> {
        calls += "respond $invitationId $answer"
        respondGate?.await()
        val answered = respondResult
        if (answered is RepositoryResult.Content) {
            items = items.map { if (it.id == invitationId) it.copy(status = answer.status()) else it }
            changes.changed()
        }
        return answered
    }
}

private fun InvitationAnswer.status(): InvitationStatus = when (this) {
    InvitationAnswer.ACCEPT -> InvitationStatus.ACCEPTED
    InvitationAnswer.TENTATIVE -> InvitationStatus.TENTATIVE
    InvitationAnswer.DECLINE -> InvitationStatus.DECLINED
    InvitationAnswer.ACKNOWLEDGE -> InvitationStatus.ACKNOWLEDGED
}

fun invitation(
    id: String,
    kind: InvitationKind = InvitationKind.INVITE,
    status: InvitationStatus = InvitationStatus.PENDING,
) = CalendarInvitation(
    id, kind, status, "Title $id", "2026-10-22T11:00:00.000Z", "2026-10-22T12:00:00.000Z", "Europe/Prague", false,
    "Office", "Petr", "petr@example.com",
)

val unavailable = RepositoryResult.Failure(FailureKind.UNAVAILABLE)
