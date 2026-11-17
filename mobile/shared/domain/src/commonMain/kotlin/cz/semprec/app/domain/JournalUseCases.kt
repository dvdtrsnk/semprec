package cz.semprec.app.domain

import cz.semprec.app.core.FailureKind

/** Reads a period and refuses an answer that is about another period as invalid data. */
class LoadJournalPeriod(private val repository: JournalRepository) {
    suspend operator fun invoke(period: JournalPeriod): RepositoryResult<JournalPeriodPage> =
        when (val result = repository.period(period)) {
            is RepositoryResult.Failure -> result
            is RepositoryResult.Content ->
                if (result.value.period == period) result else RepositoryResult.Failure(FailureKind.INVALID_DATA)
        }
}

/** Reads the page of an item (a subpage of the Journal). */
class LoadJournalPage(private val repository: JournalRepository) {
    suspend operator fun invoke(itemId: String): RepositoryResult<PageDocument> = repository.page(itemId)
}

/** Which page an edit is for: the page of a period (created on the first write) or a page that has an item. */
sealed interface PageTarget {
    data class OfPeriod(val period: JournalPeriod, val itemId: String?) : PageTarget
    data class OfItem(val itemId: String) : PageTarget
}

/** What an edit came to: written, with the new Markdown, or no longer fitting the page as the server has it. */
sealed interface PageEditOutcome {
    data class Saved(val itemId: String, val markdown: String) : PageEditOutcome
    data object Stale : PageEditOutcome
}

/**
 * Applies one [PageEdit] to a page on the server. It always reads the page first and applies the edit to what the
 * server has now, so an edit made on a stale screen still lands when its block is unchanged, and is
 * [PageEditOutcome.Stale] when it is not; the write quotes the version it read, so a change that slips in between
 * is also [PageEditOutcome.Stale].
 */
class EditJournalPage(private val repository: JournalRepository) {
    suspend operator fun invoke(target: PageTarget, edit: PageEdit): RepositoryResult<PageEditOutcome> {
        val itemId = when (target) {
            is PageTarget.OfItem -> RepositoryResult.Content(target.itemId)
            is PageTarget.OfPeriod ->
                target.itemId?.let { RepositoryResult.Content(it) } ?: repository.ensurePage(target.period)
        }
        return when (itemId) {
            is RepositoryResult.Failure -> itemId
            is RepositoryResult.Content -> write(itemId.value, edit)
        }
    }

    private suspend fun write(itemId: String, edit: PageEdit): RepositoryResult<PageEditOutcome> =
        when (val page = repository.page(itemId)) {
            is RepositoryResult.Failure -> page
            is RepositoryResult.Content -> {
                val changed = PageEditor.apply(page.value.markdown, edit)
                if (changed == null) {
                    RepositoryResult.Content(PageEditOutcome.Stale)
                } else {
                    replace(itemId, changed, page.value.etag)
                }
            }
        }

    private suspend fun replace(itemId: String, markdown: String, etag: String): RepositoryResult<PageEditOutcome> =
        when (val written = repository.replacePage(itemId, markdown, etag)) {
            is RepositoryResult.Failure -> written
            is RepositoryResult.Content -> RepositoryResult.Content(
                when (written.value) {
                    is PageWrite.Saved -> PageEditOutcome.Saved(itemId, markdown)
                    PageWrite.Conflict -> PageEditOutcome.Stale
                },
            )
        }
}
