package cz.semprec.app.data

import cz.semprec.app.domain.PlaceholderItem
import cz.semprec.app.domain.PlaceholderRepository
import cz.semprec.app.domain.RepositoryResult

/** A fixed list of items with the stable ids `item-1` to `item-5` and the ordinals 1 to 5. It never fails. */
class InMemoryPlaceholderRepository : PlaceholderRepository {
    private val items = (1..ITEM_COUNT).map { PlaceholderItem(id = "item-$it", ordinal = it) }

    override suspend fun items(): RepositoryResult<List<PlaceholderItem>> = RepositoryResult.Content(items)

    override suspend fun item(id: String): RepositoryResult<PlaceholderItem?> =
        RepositoryResult.Content(items.firstOrNull { it.id == id })
}

private const val ITEM_COUNT = 5
