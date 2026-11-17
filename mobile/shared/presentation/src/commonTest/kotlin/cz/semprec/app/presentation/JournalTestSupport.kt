package cz.semprec.app.presentation

import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.CalendarDay
import cz.semprec.app.domain.ClockTime
import cz.semprec.app.domain.JournalBirthday
import cz.semprec.app.domain.JournalEvent
import cz.semprec.app.domain.JournalInboxEntry
import cz.semprec.app.domain.JournalPeriod
import cz.semprec.app.domain.JournalPeriodPage
import cz.semprec.app.domain.JournalPeriodType
import cz.semprec.app.domain.JournalRepository
import cz.semprec.app.domain.JournalWeekPage
import cz.semprec.app.domain.PageDocument
import cz.semprec.app.domain.PageWrite
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.endOf
import cz.semprec.app.domain.isoWeek
import cz.semprec.app.domain.startOf
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.withContext

val TODAY = CalendarDay(2026, 10, 16)

/** A repository whose every call is a replaceable lambda; calls are recorded. */
class FakeJournalRepository : JournalRepository {
    val periodCalls = mutableListOf<JournalPeriod>()
    val ensureCalls = mutableListOf<JournalPeriod>()
    val replaced = mutableListOf<Triple<String, String, String>>()
    var cancellations = 0

    var onPeriod: suspend (JournalPeriod) -> RepositoryResult<JournalPeriodPage> = { content(periodPage(it)) }
    var onEnsure: suspend (JournalPeriod) -> RepositoryResult<String> = { content("item-new") }
    var onPage: suspend (String) -> RepositoryResult<PageDocument> = { content(PageDocument("", "\"v1\"")) }
    var onReplace: suspend (String, String, String) -> RepositoryResult<PageWrite> =
        { _, _, _ -> content(PageWrite.Saved("\"v2\"")) }

    override suspend fun period(period: JournalPeriod): RepositoryResult<JournalPeriodPage> {
        periodCalls += period
        return onPeriod(period)
    }

    override suspend fun ensurePage(period: JournalPeriod): RepositoryResult<String> {
        ensureCalls += period
        return onEnsure(period)
    }

    override suspend fun page(itemId: String): RepositoryResult<PageDocument> = onPage(itemId)

    override suspend fun replacePage(itemId: String, markdown: String, etag: String): RepositoryResult<PageWrite> {
        replaced += Triple(itemId, markdown, etag)
        return onReplace(itemId, markdown, etag)
    }

    /** Never answers; counts the cancellation of the caller. */
    suspend fun <T> never(): T = try {
        awaitCancellation()
    } finally {
        cancellations += 1
    }

    /** Answers [answer] only after [gate] opens, also when the caller was cancelled meanwhile. */
    suspend fun <T> late(gate: CompletableDeferred<Unit>, answer: T): T {
        withContext(NonCancellable) { gate.await() }
        return answer
    }
}

fun <T> content(value: T): RepositoryResult<T> = RepositoryResult.Content(value)

fun journalFailure(kind: FailureKind = FailureKind.UNAVAILABLE): RepositoryResult.Failure =
    RepositoryResult.Failure(kind)

/** The answer for [period]: a day with an event, a birthday and an Inbox item, a month with two weeks, else a page. */
fun periodPage(
    period: JournalPeriod,
    markdown: String? = "Hello",
    itemId: String? = "item-${period.key}",
    weekMarkdown: String? = null,
    weekItemId: String? = null,
): JournalPeriodPage {
    val dayKey = period.key.takeIf { it.length == DAY_KEY_LENGTH }.orEmpty()
    val first = CalendarDay.parse(dayKey) ?: monthOrWiderStart(period)
    val weeks = when (period.type) {
        JournalPeriodType.DAY -> listOf(weekOf(first, weekMarkdown, weekItemId))
        JournalPeriodType.MONTH ->
            listOf(weekOf(first, weekMarkdown, weekItemId), weekOf(first.plusDays(WEEK), null, null))
        else -> emptyList()
    }
    val isDay = period.type == JournalPeriodType.DAY
    return JournalPeriodPage(
        period = period,
        from = first.startOf(period.type),
        to = first.endOf(period.type),
        today = TODAY,
        itemId = itemId,
        markdown = markdown,
        weeks = weeks,
        inbox = if (isDay) listOf(inboxEntry()) else emptyList(),
        events = if (isDay) listOf(event()) else emptyList(),
        birthdays = if (isDay) listOf(JournalBirthday("b1", "Jana Kovarova")) else emptyList(),
    )
}

private const val DAY_KEY_LENGTH = 10
private const val WEEK = 7

private fun monthOrWiderStart(period: JournalPeriod): CalendarDay {
    val year = period.key.take(YEAR_DIGITS).toInt()
    return when (period.type) {
        JournalPeriodType.MONTH -> CalendarDay(year, period.key.takeLast(2).toInt(), 1)
        JournalPeriodType.QUARTER -> CalendarDay(year, (period.key.last().digitToInt() - 1) * 3 + 1, 1)
        else -> CalendarDay(year, 1, 1)
    }
}

private const val YEAR_DIGITS = 4

private fun weekOf(day: CalendarDay, markdown: String?, itemId: String?): JournalWeekPage {
    val iso = day.isoWeek()
    return JournalWeekPage(
        period = "${iso.weekYear}-W${iso.week.toString().padStart(2, '0')}",
        week = iso.week,
        from = day.startOf(JournalPeriodType.WEEK),
        to = day.endOf(JournalPeriodType.WEEK),
        itemId = itemId,
        markdown = markdown,
    )
}

fun event() = JournalEvent(
    id = "e1",
    title = "Standup",
    timeFrom = ClockTime(540),
    timeTo = ClockTime(570),
    allDay = false,
    place = "Office",
    projectName = "Semprec iOS",
    projectColor = "#007AFF",
    hasTranscript = true,
)

fun inboxEntry() = JournalInboxEntry(
    id = "i1",
    time = "08:15",
    text = "Idea",
    typeEmoji = "x",
    status = "proposed",
    processing = null,
    attachmentName = "scan.pdf",
    attachmentCount = 2,
)

/** The captures of the diary's Inbox row, which the diary's own tests never reach. */
internal object UnusedInboxCaptures : cz.semprec.app.domain.InboxCaptureRepository {
    override suspend fun types(): RepositoryResult<List<cz.semprec.app.domain.InboxType>> =
        error("The diary's tests do not read Inbox types")

    override suspend fun capture(capture: cz.semprec.app.domain.InboxCapture): RepositoryResult<Unit> =
        error("The diary's tests do not capture")
}
