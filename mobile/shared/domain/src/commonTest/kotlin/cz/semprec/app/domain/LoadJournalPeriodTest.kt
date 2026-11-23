package cz.semprec.app.domain

import cz.semprec.app.core.FailureKind
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs

private val DAY = JournalPeriod(JournalPeriodType.DAY, "2026-10-16")
private val OTHER_DAY = JournalPeriod(JournalPeriodType.DAY, "2026-10-17")

private class ScriptedJournal(
    var period: RepositoryResult<JournalPeriodPage> = RepositoryResult.Failure(FailureKind.UNAVAILABLE),
    var ensure: RepositoryResult<String> = RepositoryResult.Content("item-new"),
    var page: RepositoryResult<PageDocument> = RepositoryResult.Content(PageDocument("one", "\"v1\"")),
    var write: RepositoryResult<PageWrite> = RepositoryResult.Content(PageWrite.Saved("\"v2\"")),
) : JournalRepository {
    val written = mutableListOf<Triple<String, String, String>>()
    var ensured = 0

    override suspend fun period(period: JournalPeriod) = this.period
    override suspend fun ensurePage(period: JournalPeriod): RepositoryResult<String> {
        ensured += 1
        return ensure
    }
    override suspend fun page(itemId: String) = page
    override suspend fun replacePage(
        itemId: String,
        markdown: String,
        etag: String,
        base: String,
    ): RepositoryResult<PageWrite> {
        written += Triple(itemId, markdown, etag)
        return write
    }
}

private fun pageFor(period: JournalPeriod) = JournalPeriodPage(
    period = period,
    from = CalendarDay(2026, 10, 16),
    to = CalendarDay(2026, 10, 16),
    today = CalendarDay(2026, 10, 16),
    itemId = null,
    markdown = null,
    weeks = emptyList(),
    inbox = emptyList(),
    events = emptyList(),
    birthdays = emptyList(),
)

class LoadJournalPeriodTest {
    @Test fun `loading a period passes its page through`() = runTest {
        val repository = ScriptedJournal(period = RepositoryResult.Content(pageFor(DAY)))
        assertEquals(RepositoryResult.Content(pageFor(DAY)), LoadJournalPeriod(repository)(DAY))
    }

    @Test fun `loading a period refuses an answer about another one`() = runTest {
        val repository =
            ScriptedJournal(period = RepositoryResult.Content(pageFor(OTHER_DAY)))
        val result = LoadJournalPeriod(repository)(DAY)
        assertEquals(FailureKind.INVALID_DATA, assertIs<RepositoryResult.Failure>(result).kind)
    }

    @Test fun `loading a period keeps a failure`() = runTest {
        val repository = ScriptedJournal(period = RepositoryResult.Failure(FailureKind.NOT_FOUND))
        assertEquals(FailureKind.NOT_FOUND, assertIs<RepositoryResult.Failure>(LoadJournalPeriod(repository)(DAY)).kind)
    }
}
