package cz.semprec.app.domain

import cz.semprec.app.core.FailureKind
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

@OptIn(ExperimentalCoroutinesApi::class)
class LoadPlaceholderItemsTest {
    private fun repository(result: RepositoryResult<List<PlaceholderItem>>) = object : PlaceholderRepository {
        override suspend fun items() = result
        override suspend fun item(id: String): RepositoryResult<PlaceholderItem?> = error("not used")
    }

    private fun items(vararg items: PlaceholderItem) = repository(RepositoryResult.Content(items.toList()))

    @Test fun `items are ordered by ordinal and then by id`() = runTest {
        val result = LoadPlaceholderItems(
            items(PlaceholderItem("b", 2), PlaceholderItem("z", 1), PlaceholderItem("a", 2)),
        )()
        assertEquals(
            RepositoryResult.Content(listOf(PlaceholderItem("z", 1), PlaceholderItem("a", 2), PlaceholderItem("b", 2))),
            result,
        )
    }

    @Test fun `an empty list is content and not a failure`() = runTest {
        assertEquals(RepositoryResult.Content(emptyList()), LoadPlaceholderItems(items())())
    }

    @Test fun `duplicate or blank ids are invalid data`() = runTest {
        val invalid = RepositoryResult.Failure(FailureKind.INVALID_DATA)
        assertEquals(invalid, LoadPlaceholderItems(items(PlaceholderItem("a", 1), PlaceholderItem("a", 2)))())
        assertEquals(invalid, LoadPlaceholderItems(items(PlaceholderItem(" ", 1)))())
    }

    @Test fun `a repository failure passes through unchanged`() = runTest {
        val failure = RepositoryResult.Failure(FailureKind.UNAVAILABLE)
        assertEquals(failure, LoadPlaceholderItems(repository(failure))())
    }

    @Test fun `cancellation propagates without becoming a failure`() = runTest {
        val useCase = LoadPlaceholderItems(object : PlaceholderRepository {
            override suspend fun items(): RepositoryResult<List<PlaceholderItem>> = awaitCancellation()
            override suspend fun item(id: String): RepositoryResult<PlaceholderItem?> = error("not used")
        })
        var returned = false
        val job = launch {
            useCase()
            returned = true
        }
        runCurrent()
        job.cancel()
        job.join()
        assertTrue(job.isCancelled)
        assertFalse(returned)
    }
}
