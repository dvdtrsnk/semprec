package cz.semprec.app.domain

/** Source of the placeholder items. Expected failures are [RepositoryResult.Failure]; cancellation propagates. */
interface PlaceholderRepository {
    suspend fun items(): RepositoryResult<List<PlaceholderItem>>

    /** [RepositoryResult.Content] without an item when no item has [id]. */
    suspend fun item(id: String): RepositoryResult<PlaceholderItem?>
}
