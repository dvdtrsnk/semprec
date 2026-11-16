package cz.semprec.app.presentation

import androidx.lifecycle.ViewModelStore
import cz.semprec.app.core.FailureKind
import cz.semprec.app.core.SearchGroupType
import cz.semprec.app.core.SearchSubtitleKind
import cz.semprec.app.domain.InMemoryRecentSearches
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.SearchGroup
import cz.semprec.app.domain.SearchResult
import cz.semprec.app.domain.SearchSubtitlePart
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

private const val DEBOUNCE = 250L

private val TASK_RESULT = SearchResult(
    itemId = "t1",
    threadId = null,
    databaseKey = "tasks",
    title = "Odeslat fakturu",
    subtitle = listOf(SearchSubtitlePart(SearchSubtitleKind.DATE, "2026-10-16", null)),
    snippet = null,
    journalType = null,
    journalPeriod = null,
)
private val MAIL_RESULT = SearchResult("m1", "th1", "emails", "Re: Nabídka", emptyList(), "fragment", null, null)
private val JOURNAL_RESULT = SearchResult("j1", null, "journal", "Pátek", emptyList(), null, "day", "2026-10-16")
private val GROUPS = listOf(
    SearchGroup(SearchGroupType.TASK, 6, listOf(TASK_RESULT)),
    SearchGroup(SearchGroupType.JOURNAL, 1, listOf(JOURNAL_RESULT)),
    SearchGroup(SearchGroupType.MAIL, 1, listOf(MAIL_RESULT)),
)
private val ANSWER = RepositoryResult.Content(GROUPS)

@OptIn(ExperimentalCoroutinesApi::class)
class SearchViewModelTest : MainDispatcherTest() {
    private val recents = InMemoryRecentSearches()

    private fun viewModel(repository: ScriptedSearchRepository) =
        overviewFactory(search = repository, recents = recents).searchViewModel()

    private val taskItem = SearchResultItem(
        key = "t1",
        itemId = "t1",
        threadId = null,
        databaseKey = "tasks",
        title = "Odeslat fakturu",
        subtitle = listOf(SearchSubtitleItem(SearchSubtitleKind.DATE, "2026-10-16", null)),
        snippet = null,
        journalType = null,
        journalPeriod = null,
    )

    @Test fun `starts on the recent searches`() = runTest(dispatcher) {
        recents.remember("faktura")
        val vm = viewModel(ScriptedSearchRepository({ ANSWER }))
        assertEquals(SearchState(recents = listOf("faktura")), vm.state.value)
        vm.close()
    }

    @Test fun `a text is searched once the person pauses typing`() = runTest(dispatcher) {
        val repository = ScriptedSearchRepository({ ANSWER })
        val vm = viewModel(repository)
        vm.onAction(SearchAction.QueryChanged("fakt"))
        assertEquals(SearchPhase.SEARCHING, vm.state.value.phase)
        advanceTimeBy(DEBOUNCE - 1)
        runCurrent()
        assertEquals(0, repository.calls)
        advanceTimeBy(1)
        runCurrent()
        assertEquals(listOf(searchCall("fakt", null, 4)), repository.queries)
        val state = vm.state.value
        assertEquals(SearchPhase.RESULTS, state.phase)
        val types = listOf(SearchGroupType.TASK, SearchGroupType.JOURNAL, SearchGroupType.MAIL)
        assertEquals(types, state.groups.map { it.type })
        assertEquals(6, state.groups[0].total)
        assertEquals(taskItem, state.groups[0].results.single())
        assertEquals("th1", state.groups[2].results.single().key)
        assertEquals("day", state.groups[1].results.single().journalType)
        vm.close()
    }

    @Test fun `typing again before the pause supersedes the earlier text`() = runTest(dispatcher) {
        val repository = ScriptedSearchRepository({ ANSWER })
        val vm = viewModel(repository)
        vm.onAction(SearchAction.QueryChanged("f"))
        advanceTimeBy(DEBOUNCE / 2)
        vm.onAction(SearchAction.QueryChanged("fa"))
        advanceTimeBy(DEBOUNCE)
        runCurrent()
        assertEquals(listOf(searchCall("fa", null, 4)), repository.queries)
        vm.close()
    }

    @Test fun `a blank text shows the recent searches again and searches nothing`() = runTest(dispatcher) {
        recents.remember("koupelna")
        val repository = ScriptedSearchRepository({ ANSWER })
        val vm = viewModel(repository)
        vm.onAction(SearchAction.QueryChanged("fakt"))
        advanceTimeBy(DEBOUNCE)
        runCurrent()
        vm.onAction(SearchAction.QueryChanged("  "))
        runCurrent()
        assertEquals(SearchState(recents = listOf("koupelna")), vm.state.value)
        assertEquals(1, repository.calls)
        vm.close()
    }

    @Test fun `no match is the empty phase`() = runTest(dispatcher) {
        val vm = viewModel(ScriptedSearchRepository({ RepositoryResult.Content(emptyList()) }))
        vm.onAction(SearchAction.QueryChanged("zzz"))
        advanceTimeBy(DEBOUNCE)
        runCurrent()
        assertEquals(SearchPhase.EMPTY, vm.state.value.phase)
        vm.close()
    }

    @Test fun `an expected failure is an error with its kind and retry searches again`() = runTest(dispatcher) {
        val repository = ScriptedSearchRepository({ RepositoryResult.Failure(FailureKind.UNAVAILABLE) }, { ANSWER })
        val vm = viewModel(repository)
        vm.onAction(SearchAction.QueryChanged("a"))
        advanceTimeBy(DEBOUNCE)
        runCurrent()
        assertEquals(SearchPhase.ERROR, vm.state.value.phase)
        assertEquals(FailureKind.UNAVAILABLE, vm.state.value.failure)
        vm.onAction(SearchAction.Retry)
        runCurrent()
        assertEquals(SearchPhase.RESULTS, vm.state.value.phase)
        assertEquals(null, vm.state.value.failure)
        vm.close()
    }

    @Test fun `an unexpected exception is an error without a failure kind`() = runTest(dispatcher) {
        val vm = viewModel(ScriptedSearchRepository(crashes()))
        vm.onAction(SearchAction.QueryChanged("a"))
        advanceTimeBy(DEBOUNCE)
        runCurrent()
        assertEquals(SearchState(phase = SearchPhase.ERROR), vm.state.value)
        vm.close()
    }

    @Test fun `selecting a scope searches that kind at once and asks for fifty of it`() = runTest(dispatcher) {
        val repository = ScriptedSearchRepository({ ANSWER })
        val vm = viewModel(repository)
        vm.onAction(SearchAction.QueryChanged("fakt"))
        advanceTimeBy(DEBOUNCE)
        runCurrent()
        vm.onAction(SearchAction.SelectScope(SearchGroupType.TASK))
        runCurrent()
        assertEquals(searchCall("fakt", SearchGroupType.TASK, 50), repository.queries.last())
        assertEquals(SearchGroupType.TASK, vm.state.value.scope)
        vm.onAction(SearchAction.SelectScope(null))
        runCurrent()
        assertEquals(searchCall("fakt", null, 4), repository.queries.last())
        vm.close()
    }

    @Test fun `the scope survives a blank text`() = runTest(dispatcher) {
        val vm = viewModel(ScriptedSearchRepository({ ANSWER }))
        vm.onAction(SearchAction.SelectScope(SearchGroupType.EVENT))
        assertEquals(SearchState(scope = SearchGroupType.EVENT), vm.state.value)
        vm.close()
    }

    @Test fun `earlier results stay while the next text is searched`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        val vm =
            viewModel(ScriptedSearchRepository({ ANSWER }, answersLate(gate, RepositoryResult.Content(emptyList()))))
        vm.onAction(SearchAction.QueryChanged("a"))
        advanceTimeBy(DEBOUNCE)
        runCurrent()
        vm.onAction(SearchAction.QueryChanged("ab"))
        assertEquals(SearchPhase.SEARCHING, vm.state.value.phase)
        assertEquals(3, vm.state.value.groups.size)
        vm.close()
    }

    @Test fun `submitting remembers the text once and searches without waiting`() = runTest(dispatcher) {
        val repository = ScriptedSearchRepository({ ANSWER })
        val vm = viewModel(repository)
        vm.onAction(SearchAction.QueryChanged("faktura"))
        vm.onAction(SearchAction.Submit("faktura"))
        runCurrent()
        assertEquals(listOf("faktura"), vm.state.value.recents)
        assertEquals(SearchPhase.RESULTS, vm.state.value.phase)
        assertEquals(1, repository.calls)
        vm.onAction(SearchAction.Submit("  "))
        assertEquals(listOf("faktura"), vm.state.value.recents)
        vm.close()
    }

    @Test fun `opening a result raises it with everything the app needs`() = runTest(dispatcher) {
        val vm = viewModel(ScriptedSearchRepository({ ANSWER }))
        vm.onAction(SearchAction.QueryChanged("a"))
        advanceTimeBy(DEBOUNCE)
        runCurrent()
        vm.onAction(SearchAction.Open(SearchGroupType.TASK, "t1"))
        vm.onAction(SearchAction.Open(SearchGroupType.MAIL, "th1"))
        vm.onAction(SearchAction.Open(SearchGroupType.JOURNAL, "j1"))
        vm.onAction(SearchAction.Open(SearchGroupType.TASK, "unknown"))
        vm.onAction(SearchAction.Open(SearchGroupType.EVENT, "t1"))
        val received = mutableListOf<SearchEffect>()
        val collector = launch { vm.effects.collect { received += it } }
        runCurrent()
        collector.cancel()
        assertEquals(
            listOf<SearchEffect>(
                SearchEffect.OpenResult(SearchGroupType.TASK, "t1", null, "tasks", null, null),
                SearchEffect.OpenResult(SearchGroupType.MAIL, "m1", "th1", "emails", null, null),
                SearchEffect.OpenResult(SearchGroupType.JOURNAL, "j1", null, "journal", "day", "2026-10-16"),
            ),
            received,
        )
        vm.close()
    }

    @Test fun `a newer text cancels the running search and a late older answer is dropped`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        val repository = ScriptedSearchRepository(answersLate(gate, ANSWER), { RepositoryResult.Content(emptyList()) })
        val vm = viewModel(repository)
        vm.onAction(SearchAction.QueryChanged("a"))
        advanceTimeBy(DEBOUNCE)
        runCurrent()
        vm.onAction(SearchAction.QueryChanged("ab"))
        advanceTimeBy(DEBOUNCE)
        runCurrent()
        assertEquals(SearchPhase.EMPTY, vm.state.value.phase)
        gate.complete(Unit)
        runCurrent()
        assertEquals(SearchPhase.EMPTY, vm.state.value.phase)
        vm.close()
    }

    @Test fun `close cancels a running search without a failure state and is idempotent`() = runTest(dispatcher) {
        val repository = ScriptedSearchRepository(neverAnswers())
        val vm = viewModel(repository)
        vm.onAction(SearchAction.QueryChanged("a"))
        advanceTimeBy(DEBOUNCE)
        runCurrent()
        vm.close()
        vm.close()
        runCurrent()
        assertTrue(vm.isClosed)
        assertEquals(1, repository.cancellations)
        assertEquals(SearchPhase.SEARCHING, vm.state.value.phase)
    }

    @Test fun `a closed ViewModel ignores actions`() = runTest(dispatcher) {
        val repository = ScriptedSearchRepository({ ANSWER })
        val vm = viewModel(repository)
        vm.close()
        vm.onAction(SearchAction.QueryChanged("a"))
        vm.onAction(SearchAction.Submit("a"))
        vm.onAction(SearchAction.SelectScope(SearchGroupType.TASK))
        vm.onAction(SearchAction.Retry)
        advanceTimeBy(DEBOUNCE)
        runCurrent()
        assertEquals(SearchState(), vm.state.value)
        assertEquals(0, repository.calls)
        assertEquals(emptyList<String>(), recents.list())
        assertEquals(emptyList(), vm.effects.toList())
    }

    @Test fun `clearing the owning store ends it like close without calling close`() = runTest(dispatcher) {
        val store = ViewModelStore()
        val repository = ScriptedSearchRepository(neverAnswers())
        val vm = store.provide { viewModel(repository) }
        vm.onAction(SearchAction.QueryChanged("a"))
        advanceTimeBy(DEBOUNCE)
        runCurrent()
        store.clear()
        runCurrent()
        assertTrue(vm.isClosed)
        assertEquals(1, repository.cancellations)
    }
}
