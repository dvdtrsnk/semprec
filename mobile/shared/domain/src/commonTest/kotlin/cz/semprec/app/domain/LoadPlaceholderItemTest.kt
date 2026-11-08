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
class LoadPlaceholderItemTest {
    private fun repository(result: RepositoryResult<PlaceholderItem?>) = object : PlaceholderRepository {
        override suspend fun items(): RepositoryResult<List<PlaceholderItem>> = error("not used")
        override suspend fun item(id: String) = result
    }

    @Test fun `the requested item is content`() = runTest {
        val found = RepositoryResult.Content(PlaceholderItem("item-1", 1))
        assertEquals(found, LoadPlaceholderItem(repository(found))("item-1"))
    }

    @Test fun `an unknown id is content without an item`() = runTest {
        val missing = RepositoryResult.Content(null)
        assertEquals(missing, LoadPlaceholderItem(repository(missing))("item-9"))
    }

    @Test fun `an item with another id is invalid data`() = runTest {
        val other = repository(RepositoryResult.Content(PlaceholderItem("item-2", 2)))
        assertEquals(RepositoryResult.Failure(FailureKind.INVALID_DATA), LoadPlaceholderItem(other)("item-1"))
    }

    @Test fun `a repository failure passes through unchanged`() = runTest {
        val failure = RepositoryResult.Failure(FailureKind.UNAVAILABLE)
        assertEquals(failure, LoadPlaceholderItem(repository(failure))("item-1"))
    }

    @Test fun `cancellation propagates without becoming a failure`() = runTest {
        val useCase = LoadPlaceholderItem(object : PlaceholderRepository {
            override suspend fun items(): RepositoryResult<List<PlaceholderItem>> = error("not used")
            override suspend fun item(id: String): RepositoryResult<PlaceholderItem?> = awaitCancellation()
        })
        var returned = false
        val job = launch {
            useCase("item-1")
            returned = true
        }
        runCurrent()
        job.cancel()
        job.join()
        assertTrue(job.isCancelled)
        assertFalse(returned)
    }
}
