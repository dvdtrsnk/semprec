package cz.alldots.app.presentation

import cz.alldots.app.core.SearchGroupType
import cz.alldots.app.domain.InMemoryRecentSearches
import cz.alldots.app.domain.LoadOverview
import cz.alldots.app.domain.Overview
import cz.alldots.app.domain.OverviewCollection
import cz.alldots.app.domain.OverviewProject
import cz.alldots.app.domain.OverviewRepository
import cz.alldots.app.domain.OverviewSummary
import cz.alldots.app.domain.RecentSearches
import cz.alldots.app.domain.RepositoryResult
import cz.alldots.app.domain.SearchEverything
import cz.alldots.app.domain.SearchGroup
import cz.alldots.app.domain.SearchRepository
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.withContext

/** One answer of a scripted repository: it runs when the call is made and may suspend, fail or crash. */
typealias ScriptedStep<T> = suspend () -> RepositoryResult<T>

/** A step that waits until its caller is cancelled. */
fun <T> neverAnswers(): ScriptedStep<T> = { awaitCancellation() }

/** A step that ignores cancellation: it waits for [gate] even after its caller was cancelled, then answers. */
fun <T> answersLate(gate: CompletableDeferred<Unit>, answer: RepositoryResult<T>): ScriptedStep<T> = {
    withContext(NonCancellable) { gate.await() }
    answer
}

/** A step that crashes with an exception nobody expects. */
fun <T> crashes(): ScriptedStep<T> = { error("unexpected") }

/** The calls of a scripted repository: each takes the next step, then the last one repeats. */
class CallScript<T>(private val steps: List<ScriptedStep<T>>) {
    var calls = 0
        private set
    var cancellations = 0
        private set

    suspend fun next(): RepositoryResult<T> {
        val step = steps[minOf(calls, steps.lastIndex)]
        calls += 1
        return try {
            step()
        } catch (cancelled: CancellationException) {
            cancellations += 1
            throw cancelled
        }
    }
}

class ScriptedOverviewRepository(vararg steps: ScriptedStep<Overview>) : OverviewRepository {
    private val script = CallScript(steps.toList())
    val calls get() = script.calls
    val cancellations get() = script.cancellations

    override suspend fun load(): RepositoryResult<Overview> = script.next()
}

class ScriptedSearchRepository(vararg steps: ScriptedStep<List<SearchGroup>>) : SearchRepository {
    private val script = CallScript(steps.toList())
    val calls get() = script.calls
    val cancellations get() = script.cancellations
    val queries = mutableListOf<Triple<String, SearchGroupType?, Int>>()

    override suspend fun search(
        query: String,
        scope: SearchGroupType?,
        perGroupLimit: Int,
    ): RepositoryResult<List<SearchGroup>> {
        queries += Triple(query, scope, perGroupLimit)
        return script.next()
    }
}

/** A search call as the fake records it, typed so that tests compare like with like. */
fun searchCall(query: String, scope: SearchGroupType?, limit: Int) = Triple(query, scope, limit)

val overviewSummary = OverviewSummary(9, 5, 2)

/** Deliberately out of order and with an unpinned project and a hidden collection. */
val overviewData = Overview(
    summary = overviewSummary,
    projects = listOf(
        OverviewProject("p2", "Půlmaraton", "#FF3B30", "inProgress", true, 2.0),
        OverviewProject("p1", "Alldots iOS", "#007AFF", "inProgress", true, 1.0),
        OverviewProject("p3", "Not pinned", null, null, false, null),
    ),
    collections = listOf(
        OverviewCollection("d2", "people", "People", "person", "#30B0C7", 2, true, false),
        OverviewCollection("d1", "events", "Events", "calendar", "#FF3B30", 1, true, false),
        OverviewCollection("d3", "files", "Files", null, null, 3, true, true),
    ),
)

fun overviewFactory(
    overview: ScriptedOverviewRepository = ScriptedOverviewRepository({ RepositoryResult.Content(overviewData) }),
    search: ScriptedSearchRepository = ScriptedSearchRepository({ RepositoryResult.Content(emptyList()) }),
    recents: RecentSearches = InMemoryRecentSearches(),
    auth: FakeAuthRepository = FakeAuthRepository(),
) = OverviewViewModelFactory(LoadOverview(overview), SearchEverything(search), recents, auth)
