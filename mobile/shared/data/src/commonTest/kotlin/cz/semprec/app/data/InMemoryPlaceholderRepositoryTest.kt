package cz.semprec.app.data

import cz.semprec.app.domain.PlaceholderItem
import cz.semprec.app.domain.RepositoryResult
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals

class InMemoryPlaceholderRepositoryTest {
    private val expected = listOf(
        PlaceholderItem("item-1", 1),
        PlaceholderItem("item-2", 2),
        PlaceholderItem("item-3", 3),
        PlaceholderItem("item-4", 4),
        PlaceholderItem("item-5", 5),
    )

    @Test fun `items have stable ids and ordinals in every instance`() = runTest {
        assertEquals(RepositoryResult.Content(expected), InMemoryPlaceholderRepository().items())
        assertEquals(RepositoryResult.Content(expected), InMemoryPlaceholderRepository().items())
    }

    @Test fun `every listed item can be loaded by its id`() = runTest {
        val repository = InMemoryPlaceholderRepository()
        expected.forEach { assertEquals(RepositoryResult.Content(it), repository.item(it.id)) }
    }

    @Test fun `an unknown id is content without an item`() = runTest {
        assertEquals(RepositoryResult.Content(null), InMemoryPlaceholderRepository().item("item-6"))
    }
}
