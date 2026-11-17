package cz.semprec.app.domain

import cz.semprec.app.core.FailureKind
import cz.semprec.app.core.SearchGroupType
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue

private fun result(title: String) = SearchResult("i-$title", null, "tasks", title, emptyList(), null, null, null)

private fun call(query: String, scope: SearchGroupType?, limit: Int) = Triple(query, scope, limit)

private class RecordingSearch(var answer: RepositoryResult<List<SearchGroup>>) : SearchRepository {
    val calls = mutableListOf<Triple<String, SearchGroupType?, Int>>()

    override suspend fun search(
        query: String,
        scope: SearchGroupType?,
        perGroupLimit: Int,
    ): RepositoryResult<List<SearchGroup>> {
        calls += Triple(query, scope, perGroupLimit)
        return answer
    }
}

class SearchEverythingTest {
    @Test fun `a blank query matches nothing without asking`() = runTest {
        val repository = RecordingSearch(RepositoryResult.Content(emptyList()))

        val result = SearchEverything(repository)("   ", null)

        assertEquals(emptyList<SearchGroup>(), assertIs<RepositoryResult.Content<List<SearchGroup>>>(result).value)
        assertTrue(repository.calls.isEmpty())
    }

    @Test fun `the text is trimmed and all kinds list four of each`() = runTest {
        val repository = RecordingSearch(RepositoryResult.Content(emptyList()))

        SearchEverything(repository)("  faktura ", null)

        assertEquals(listOf(call("faktura", null, 4)), repository.calls)
    }

    @Test fun `one kind lists fifty and a long text is cut to what the server takes`() = runTest {
        val repository = RecordingSearch(RepositoryResult.Content(emptyList()))

        SearchEverything(repository)("a".repeat(MAX_SEARCH_LENGTH + 20), SearchGroupType.TASK)

        assertEquals(MAX_SEARCH_LENGTH, repository.calls.single().first.length)
        assertEquals(SearchGroupType.TASK, repository.calls.single().second)
        assertEquals(50, repository.calls.single().third)
    }

    @Test fun `groups without results are left out`() = runTest {
        val repository = RecordingSearch(
            RepositoryResult.Content(
                listOf(
                    SearchGroup(SearchGroupType.TASK, 1, listOf(result("a"))),
                    SearchGroup(SearchGroupType.EVENT, 0, emptyList()),
                ),
            ),
        )

        val result = SearchEverything(repository)("a", null)

        val groups = assertIs<RepositoryResult.Content<List<SearchGroup>>>(result).value
        assertEquals(listOf(SearchGroupType.TASK), groups.map { it.type })
    }

    @Test fun `a failure is kept`() = runTest {
        val repository = RecordingSearch(RepositoryResult.Failure(FailureKind.UNAVAILABLE))

        val result = SearchEverything(repository)("a", null)

        assertEquals(FailureKind.UNAVAILABLE, assertIs<RepositoryResult.Failure>(result).kind)
    }
}
