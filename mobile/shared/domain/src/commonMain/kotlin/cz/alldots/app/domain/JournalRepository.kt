package cz.alldots.app.domain

/** The Journal on the server: periods and their page documents. */
interface JournalRepository {
    /** Reads one period with what belongs to it; a period nobody wrote on has no [JournalPeriodPage.itemId]. */
    suspend fun period(period: JournalPeriod): RepositoryResult<JournalPeriodPage>

    /** Creates the page of a period when it has none and returns the id of its item. */
    suspend fun ensurePage(period: JournalPeriod): RepositoryResult<String>

    /** Reads the canonical Markdown and the version of the page of an item. */
    suspend fun page(itemId: String): RepositoryResult<PageDocument>

    /**
     * Replaces the page of an item with [markdown], edited from [base] (the Markdown of the page last read or written
     * there), when [etag] is still its version; otherwise [PageWrite.Conflict], or with the offline set kept on the
     * device, the merge or the kept change that [PageWrite] describes.
     */
    suspend fun replacePage(itemId: String, markdown: String, etag: String, base: String): RepositoryResult<PageWrite>
}
