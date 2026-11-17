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
    override suspend fun replacePage(itemId: String, markdown: String, etag: String): RepositoryResult<PageWrite> {
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

class JournalUseCasesTest {
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

    @Test fun `editing a page of a known item reads then writes with the version it read`() = runTest {
        val repository = ScriptedJournal()
        val outcome =
            EditJournalPage(repository)(PageTarget.OfItem("item-1"), PageEdit.Append(PageBlockType.TEXT, "two"))
        assertEquals(RepositoryResult.Content(PageEditOutcome.Saved("item-1", "one\n\ntwo")), outcome)
        assertEquals(listOf(Triple("item-1", "one\n\ntwo", "\"v1\"")), repository.written)
        assertEquals(0, repository.ensured)
    }

    @Test fun `editing the page of a period without an item creates it first`() = runTest {
        val repository = ScriptedJournal()
        EditJournalPage(repository)(PageTarget.OfPeriod(DAY, null), PageEdit.Append(PageBlockType.TEXT, "two"))
        assertEquals(1, repository.ensured)
        assertEquals("item-new", repository.written.single().first)
        EditJournalPage(repository)(PageTarget.OfPeriod(DAY, "item-old"), PageEdit.Append(PageBlockType.TEXT, "two"))
        assertEquals(1, repository.ensured)
        assertEquals("item-old", repository.written.last().first)
    }

    @Test fun `a failure to create the page stops the edit`() = runTest {
        val repository = ScriptedJournal(ensure = RepositoryResult.Failure(FailureKind.UNAUTHORIZED))
        val outcome =
            EditJournalPage(repository)(PageTarget.OfPeriod(DAY, null), PageEdit.Append(PageBlockType.TEXT, "x"))
        assertEquals(FailureKind.UNAUTHORIZED, assertIs<RepositoryResult.Failure>(outcome).kind)
        assertEquals(emptyList(), repository.written)
    }

    @Test fun `a failure to read the page stops the edit`() = runTest {
        val repository = ScriptedJournal(page = RepositoryResult.Failure(FailureKind.UNAVAILABLE))
        val outcome = EditJournalPage(repository)(PageTarget.OfItem("i"), PageEdit.Append(PageBlockType.TEXT, "x"))
        assertEquals(FailureKind.UNAVAILABLE, assertIs<RepositoryResult.Failure>(outcome).kind)
        assertEquals(emptyList(), repository.written)
    }

    @Test fun `an edit that no longer fits is stale and writes nothing`() = runTest {
        val repository = ScriptedJournal()
        val outcome = EditJournalPage(repository)(PageTarget.OfItem("i"), PageEdit.SetText(0, "something else", "x"))
        assertEquals(RepositoryResult.Content(PageEditOutcome.Stale), outcome)
        assertEquals(emptyList(), repository.written)
    }

    @Test fun `a conflict at write time is stale`() = runTest {
        val repository = ScriptedJournal(write = RepositoryResult.Content(PageWrite.Conflict))
        val outcome = EditJournalPage(repository)(PageTarget.OfItem("i"), PageEdit.Append(PageBlockType.TEXT, "x"))
        assertEquals(RepositoryResult.Content(PageEditOutcome.Stale), outcome)
    }

    @Test fun `a failed write keeps its kind`() = runTest {
        val repository = ScriptedJournal(write = RepositoryResult.Failure(FailureKind.REJECTED))
        val outcome = EditJournalPage(repository)(PageTarget.OfItem("i"), PageEdit.Append(PageBlockType.TEXT, "x"))
        assertEquals(FailureKind.REJECTED, assertIs<RepositoryResult.Failure>(outcome).kind)
    }

    @Test fun `loading a page returns the document`() = runTest {
        val repository = ScriptedJournal()
        assertEquals(RepositoryResult.Content(PageDocument("one", "\"v1\"")), LoadJournalPage(repository)("i"))
    }
}
