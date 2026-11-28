package cz.alldots.app.presentation

import androidx.lifecycle.ViewModelStore
import cz.alldots.app.core.FailureKind
import cz.alldots.app.domain.LoadOverview
import cz.alldots.app.domain.RepositoryResult
import cz.alldots.app.domain.SessionStatus
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

private val CONTENT = RepositoryResult.Content(overviewData)
private val SIGNED_IN = FakeAuthRepository(initial = SessionStatus.SignedIn(testSession))

@OptIn(ExperimentalCoroutinesApi::class)
class OverviewViewModelTest : MainDispatcherTest() {
    private fun viewModel(
        repository: ScriptedOverviewRepository,
        auth: FakeAuthRepository = SIGNED_IN,
    ) = overviewFactory(overview = repository, auth = auth).overviewViewModel()

    private val loaded = OverviewState(
        phase = OverviewPhase.CONTENT,
        accountEmail = "a@b.cz",
        inboxPending = 9,
        mailUnread = 5,
        problemCount = 2,
        projects = listOf(
            OverviewProjectItem("p1", "Alldots iOS", "#007AFF", "inProgress"),
            OverviewProjectItem("p2", "Půlmaraton", "#FF3B30", "inProgress"),
        ),
        collections = listOf(
            OverviewCollectionItem("d1", "events", "Events", "calendar", "#FF3B30"),
            OverviewCollectionItem("d2", "people", "People", "person", "#30B0C7"),
        ),
    )

    @Test fun `starts loading with the account and publishes the arranged content`() = runTest(dispatcher) {
        val vm = viewModel(ScriptedOverviewRepository({ CONTENT }))
        assertEquals(OverviewState(accountEmail = "a@b.cz"), vm.state.value)
        runCurrent()
        assertEquals(loaded, vm.state.value)
        vm.close()
    }

    @Test fun `the account carries its display name while loading and with content`() = runTest(dispatcher) {
        val named = testSession.copy(user = testSession.user.copy(displayName = "Jana Dvořák"))
        val vm = viewModel(ScriptedOverviewRepository({ CONTENT }), FakeAuthRepository(SessionStatus.SignedIn(named)))
        assertEquals("Jana Dvořák", vm.state.value.accountName)
        runCurrent()
        assertEquals(loaded.copy(accountName = "Jana Dvořák"), vm.state.value)
        vm.close()
    }

    @Test fun `without a signed in session there is no account`() = runTest(dispatcher) {
        val vm = viewModel(ScriptedOverviewRepository({ CONTENT }), FakeAuthRepository())
        runCurrent()
        assertEquals(null, vm.state.value.accountEmail)
        assertEquals(OverviewPhase.CONTENT, vm.state.value.phase)
        vm.close()
    }

    @Test fun `an expected failure is an error with its kind and retry recovers`() = runTest(dispatcher) {
        val repository = ScriptedOverviewRepository({ RepositoryResult.Failure(FailureKind.UNAUTHORIZED) }, { CONTENT })
        val vm = viewModel(repository)
        runCurrent()
        assertEquals(OverviewState(OverviewPhase.ERROR, FailureKind.UNAUTHORIZED), vm.state.value)
        vm.onAction(OverviewAction.Retry)
        assertEquals(OverviewState(accountEmail = "a@b.cz"), vm.state.value)
        runCurrent()
        assertEquals(loaded, vm.state.value)
        assertEquals(2, repository.calls)
        vm.close()
    }

    @Test fun `an unexpected exception is an error without a failure kind`() = runTest(dispatcher) {
        val vm = viewModel(ScriptedOverviewRepository(crashes()))
        runCurrent()
        assertEquals(OverviewState(OverviewPhase.ERROR), vm.state.value)
        vm.close()
    }

    @Test fun `a refresh keeps the content on screen while it reloads`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        val fresh = RepositoryResult.Content(overviewData.copy(summary = overviewSummary.copy(inboxPending = 1)))
        val vm = viewModel(ScriptedOverviewRepository({ CONTENT }, answersLate(gate, fresh)))
        runCurrent()
        vm.onAction(OverviewAction.Refresh)
        assertEquals(loaded.copy(refreshing = true), vm.state.value)
        gate.complete(Unit)
        runCurrent()
        assertEquals(loaded.copy(inboxPending = 1), vm.state.value)
        vm.close()
    }

    @Test fun `a refresh that fails leaves the content as it was`() = runTest(dispatcher) {
        val failure = RepositoryResult.Failure(FailureKind.UNAVAILABLE)
        val vm = viewModel(ScriptedOverviewRepository({ CONTENT }, { failure }))
        runCurrent()
        vm.onAction(OverviewAction.Refresh)
        runCurrent()
        assertEquals(loaded, vm.state.value)
        vm.close()
    }

    @Test fun `a refresh without content is a retry`() = runTest(dispatcher) {
        val repository = ScriptedOverviewRepository({ RepositoryResult.Failure(FailureKind.UNAVAILABLE) }, { CONTENT })
        val vm = viewModel(repository)
        runCurrent()
        vm.onAction(OverviewAction.Refresh)
        assertEquals(OverviewPhase.LOADING, vm.state.value.phase)
        runCurrent()
        assertEquals(loaded, vm.state.value)
        vm.close()
    }

    @Test fun `opening a row raises its target exactly once`() = runTest(dispatcher) {
        val vm = viewModel(ScriptedOverviewRepository({ CONTENT }))
        val targets = listOf(
            OverviewTarget.Inbox,
            OverviewTarget.Mail,
            OverviewTarget.Recordings,
            OverviewTarget.Tasks,
            OverviewTarget.Finance,
            OverviewTarget.Profile,
            OverviewTarget.Project("p1"),
            OverviewTarget.Collection("events", "d1"),
        )
        targets.forEach { vm.onAction(OverviewAction.Open(it)) }
        val received = mutableListOf<OverviewTarget>()
        val collector = launch { vm.effects.collect { received += it } }
        runCurrent()
        collector.cancel()
        val again = mutableListOf<OverviewTarget>()
        val second = launch { vm.effects.collect { again += it } }
        runCurrent()
        assertEquals(targets, received)
        assertEquals(emptyList(), again)
        second.cancel()
        vm.close()
    }

    @Test fun `retry cancels the running load and publishes the new result`() = runTest(dispatcher) {
        val repository = ScriptedOverviewRepository(neverAnswers(), { CONTENT })
        val vm = viewModel(repository)
        runCurrent()
        vm.onAction(OverviewAction.Retry)
        runCurrent()
        assertEquals(1, repository.cancellations)
        assertEquals(2, repository.calls)
        assertEquals(loaded, vm.state.value)
        vm.close()
    }

    @Test fun `a superseded load that completes late never overwrites the newer result`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        val failure = RepositoryResult.Failure(FailureKind.UNAVAILABLE)
        val vm = viewModel(ScriptedOverviewRepository(answersLate(gate, failure), { CONTENT }))
        runCurrent()
        vm.onAction(OverviewAction.Retry)
        runCurrent()
        assertEquals(loaded, vm.state.value)
        gate.complete(Unit)
        runCurrent()
        assertEquals(loaded, vm.state.value)
        vm.close()
    }

    @Test fun `close cancels in-flight work without a failure state and is idempotent`() = runTest(dispatcher) {
        val repository = ScriptedOverviewRepository(neverAnswers())
        val vm = viewModel(repository)
        runCurrent()
        vm.close()
        vm.close()
        runCurrent()
        assertTrue(vm.isClosed)
        assertEquals(1, repository.cancellations)
        assertEquals(OverviewState(accountEmail = "a@b.cz"), vm.state.value)
    }

    @Test fun `a closed ViewModel ignores actions`() = runTest(dispatcher) {
        val repository = ScriptedOverviewRepository({ CONTENT })
        val vm = viewModel(repository)
        runCurrent()
        vm.close()
        vm.onAction(OverviewAction.Retry)
        vm.onAction(OverviewAction.Refresh)
        vm.onAction(OverviewAction.Open(OverviewTarget.Inbox))
        runCurrent()
        assertEquals(loaded, vm.state.value)
        assertEquals(1, repository.calls)
        assertEquals(emptyList(), vm.effects.toList())
    }

    @Test fun `a load that completes late after close never publishes`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        val vm = viewModel(ScriptedOverviewRepository(answersLate(gate, CONTENT)))
        runCurrent()
        vm.close()
        gate.complete(Unit)
        runCurrent()
        assertEquals(OverviewPhase.LOADING, vm.state.value.phase)
    }

    @Test fun `clearing the owning store ends it like close without calling close`() = runTest(dispatcher) {
        val store = ViewModelStore()
        val repository = ScriptedOverviewRepository(neverAnswers())
        val vm = store.provide { viewModel(repository) }
        runCurrent()
        store.clear()
        runCurrent()
        assertTrue(vm.isClosed)
        assertEquals(1, repository.cancellations)
        vm.onAction(OverviewAction.Retry)
        assertEquals(1, repository.calls)
    }

    @Test fun `a write elsewhere in the window reloads the overview`() = runTest(dispatcher) {
        val changes = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
        val repository = ScriptedOverviewRepository(
            { CONTENT },
            { RepositoryResult.Content(overviewData.copy(summary = overviewSummary.copy(mailUnread = 7))) },
        )
        val vm = OverviewViewModel(LoadOverview(repository), SIGNED_IN, changes)
        runCurrent()
        assertEquals(1, repository.calls)
        changes.emit(Unit)
        runCurrent()
        assertEquals(2, repository.calls)
        assertEquals(7, vm.state.value.mailUnread)
        vm.close()
    }
}
