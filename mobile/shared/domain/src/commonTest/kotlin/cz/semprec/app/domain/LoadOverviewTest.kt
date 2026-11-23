package cz.semprec.app.domain

import cz.semprec.app.core.FailureKind
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs

private val SUMMARY = OverviewSummary(9, 5, 2)

private fun area(id: String, position: Double?, active: Boolean = true) =
    OverviewArea(id, id.uppercase(), null, null, position, active)

private fun project(id: String, order: Double?, pinned: Boolean = true) =
    OverviewProject(id, id, null, null, "inProgress", pinned, order)

private fun collection(id: String, order: Int?, visible: Boolean = true, hidden: Boolean = false) =
    OverviewCollection(id, "owner-$id", id, null, null, order, visible, hidden)

private class FakeOverviewRepository(private val answer: RepositoryResult<Overview>) : OverviewRepository {
    override suspend fun load(): RepositoryResult<Overview> = answer
}

class LoadOverviewTest {
    private suspend fun load(overview: Overview): Overview {
        val result = LoadOverview(FakeOverviewRepository(RepositoryResult.Content(overview)))()
        return assertIs<RepositoryResult.Content<Overview>>(result).value
    }

    @Test fun `areas are the active ones by position then name with unpositioned last`() = runTest {
        val loaded = load(
            Overview(
                SUMMARY,
                listOf(
                    area("c", null),
                    area("b", 2.0),
                    area("gone", 1.0, active = false),
                    area("a", 2.0),
                    area("d", 1.0),
                ),
                emptyList(),
                emptyList(),
            ),
        )

        assertEquals(listOf("d", "a", "b", "c"), loaded.areas.map { it.id })
    }

    @Test fun `projects are the pinned ones by their pinned order`() = runTest {
        val loaded = load(
            Overview(
                SUMMARY,
                emptyList(),
                listOf(
                    project("b", 2.0),
                    project("unpinned", 0.0, pinned = false),
                    project("a", 1.0),
                    project("z", null),
                ),
                emptyList(),
            ),
        )

        assertEquals(listOf("a", "b", "z"), loaded.projects.map { it.id })
    }

    @Test fun `collections are the visible ones by the server order`() = runTest {
        val loaded = load(
            Overview(
                SUMMARY,
                emptyList(),
                emptyList(),
                listOf(
                    collection("b", 2),
                    collection("hidden", 1, hidden = true),
                    collection("internal", 1, visible = false),
                    collection("a", 1),
                    collection("last", null),
                ),
            ),
        )

        assertEquals(listOf("a", "b", "last"), loaded.collections.map { it.databaseId })
    }

    @Test fun `the summary passes through and a failure is kept`() = runTest {
        assertEquals(SUMMARY, load(Overview(SUMMARY, emptyList(), emptyList(), emptyList())).summary)

        val failed = LoadOverview(FakeOverviewRepository(RepositoryResult.Failure(FailureKind.UNAVAILABLE)))()

        assertEquals(FailureKind.UNAVAILABLE, assertIs<RepositoryResult.Failure>(failed).kind)
    }
}
