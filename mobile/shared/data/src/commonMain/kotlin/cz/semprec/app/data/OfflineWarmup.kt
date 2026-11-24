package cz.semprec.app.data

import cz.semprec.app.domain.CalendarChanges
import cz.semprec.app.domain.CalendarDay
import cz.semprec.app.domain.JournalPeriod
import cz.semprec.app.domain.JournalPeriodType
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.TaskScope
import kotlinx.coroutines.CancellationException

/** How many days before and after today the diary is read ahead. */
internal const val WARMUP_DIARY_DAYS = 7

/** The months the calendar is read ahead for: the one before the current month up to the second after it. */
private val WARMUP_MONTHS = -1..2

/**
 * Reads the offline set ahead of the screens of a window, with the requests those screens send, so that the answers
 * are kept under them and the screens open without a connection
 * (docs/adr/2026-11-23-mobile-answers-from-the-device-at-once-and-reads-again-behind.md). In order: the schema and the databases, the
 * task lists of every [TaskScope], the areas, projects and people, the calendars, the invitations, the calendar
 * windows of the current month, the one before and the two after, the agenda's first page from today, the diary's days
 * from [WARMUP_DIARY_DAYS] back to as many ahead with their pages, the overview, the sleep of tonight, and the Inbox
 * cards and types. Each read goes through a repository over the window's [api], as the screens' do; one that fails or
 * throws is left as it is, the next one goes on, and cancelling the caller stops the rest. [today] is the device's
 * day, `yyyy-MM-dd`, as the screens are given it.
 */
class OfflineWarmup(private val api: AuthenticatedApi, private val today: () -> String = ::localToday) {
    /** The account the window is signed in with, or `null` when nobody is. */
    internal fun account(): String? = api.session()?.let(::accountKey)

    /** Sends every read in order while [online] holds; nothing when [today] is not a day. */
    internal suspend fun run(online: suspend () -> Boolean) {
        val day = CalendarDay.parse(today()) ?: return
        val reads = Reads(online)
        val schemas = HttpCollectionReads(api)
        reads.read { schemas.schema() }
        reads.read { ItemsApi(api).databases() }
        work(reads)
        calendar(reads, day)
        diary(reads, day)
        reads.read { HttpOverviewRepository(api).load() }
        reads.read { HttpSleepRepository(api).overview(day) }
        val inbox = HttpInboxRepository(api, schemas)
        reads.read { inbox.stack() }
        reads.read { inbox.types() }
    }

    private suspend fun work(reads: Reads) {
        val work = WorkData(api)
        TaskScope.entries.forEach { scope -> reads.read { work.tasks.tasks(scope) } }
        reads.read { work.catalog.areas() }
        reads.read { work.catalog.projects() }
        reads.read { work.catalog.people() }
    }

    private suspend fun calendar(reads: Reads, day: CalendarDay) {
        val changes = CalendarChanges()
        reads.read { HttpCalendarCatalogRepository(api, changes).calendars() }
        reads.read { HttpInvitationRepository(api, changes).invitations() }
        val calendar = HttpCalendarRepository(api, changes)
        for (months in WARMUP_MONTHS) {
            val (from, to) = day.plusMonths(months).calendarWindow()
            reads.read { calendar.window(from, to) }
        }
        reads.read { HttpCalendarAgendaRepository(api).page(day, null) }
    }

    private suspend fun diary(reads: Reads, day: CalendarDay) {
        val journal = HttpJournalRepository(api)
        for (offset in -WARMUP_DIARY_DAYS..WARMUP_DIARY_DAYS) {
            reads.read {
                val period = journal.period(JournalPeriod.containing(JournalPeriodType.DAY, day.plusDays(offset)))
                val itemId = (period as? RepositoryResult.Content)?.value?.itemId
                if (itemId != null) journal.page(itemId)
            }
        }
    }

    /** Runs each read while [online] holds; once it does not, the rest is skipped. A read that throws is left too. */
    private class Reads(private val online: suspend () -> Boolean) {
        suspend fun read(read: suspend () -> Unit) {
            if (!online()) return
            try {
                read()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                // A read ahead only fills what its screen would read itself; one that throws is left as a failed one,
                // so the reads after it still run and nothing escapes into the background scope of the layer.
            }
        }
    }
}
