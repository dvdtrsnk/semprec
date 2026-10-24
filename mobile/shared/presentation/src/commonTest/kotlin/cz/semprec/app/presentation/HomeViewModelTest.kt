package cz.semprec.app.presentation

import androidx.lifecycle.ViewModelStore
import cz.semprec.app.core.FailureKind
import cz.semprec.app.presentation.FakeRepository.Behavior
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

@OptIn(ExperimentalCoroutinesApi::class)
class HomeViewModelTest : MainDispatcherTest() {
    private val content = HomeState(HomePhase.CONTENT, listOf(HomeItem("item-1", 1), HomeItem("item-2", 2)))

    @Test fun `starts loading and publishes the ordered content`() = runTest(dispatcher) {
        val vm = factory(FakeRepository(catalog)).homeViewModel()
        assertEquals(HomeState(), vm.state.value)
        runCurrent()
        assertEquals(content, vm.state.value)
        vm.close()
    }

    @Test fun `an empty list is the empty state`() = runTest(dispatcher) {
        val vm = factory(FakeRepository(Behavior.Content(emptyList()))).homeViewModel()
        runCurrent()
        assertEquals(HomeState(HomePhase.EMPTY), vm.state.value)
        vm.close()
    }

    @Test fun `an expected failure is an error with its kind and retry recovers`() = runTest(dispatcher) {
        val repository = FakeRepository(Behavior.Failure, catalog)
        val vm = factory(repository).homeViewModel()
        runCurrent()
        assertEquals(HomeState(HomePhase.ERROR, failure = FailureKind.UNAVAILABLE), vm.state.value)
        vm.onAction(HomeAction.Retry)
        assertEquals(HomeState(), vm.state.value)
        runCurrent()
        assertEquals(HomePhase.CONTENT, vm.state.value.phase)
        assertNull(vm.state.value.failure)
        assertEquals(2, repository.calls)
        vm.close()
    }

    @Test fun `invalid data is an error with its kind`() = runTest(dispatcher) {
        val duplicate = Behavior.Content(listOf(catalog.items.first(), catalog.items.first()))
        val vm = factory(FakeRepository(duplicate)).homeViewModel()
        runCurrent()
        assertEquals(HomeState(HomePhase.ERROR, failure = FailureKind.INVALID_DATA), vm.state.value)
        vm.close()
    }

    @Test fun `an unexpected exception is an error without a failure kind`() = runTest(dispatcher) {
        val vm = factory(FakeRepository(Behavior.Crash)).homeViewModel()
        runCurrent()
        assertEquals(HomeState(HomePhase.ERROR), vm.state.value)
        vm.close()
    }

    @Test fun `selecting an item opens its detail exactly once`() = runTest(dispatcher) {
        val vm = factory(FakeRepository(catalog)).homeViewModel()
        vm.onAction(HomeAction.SelectItem("item-2"))
        val received = mutableListOf<HomeEffect>()
        val collector = launch { vm.effects.collect { received += it } }
        runCurrent()
        collector.cancel()
        val again = mutableListOf<HomeEffect>()
        val secondCollector = launch { vm.effects.collect { again += it } }
        runCurrent()
        assertEquals(listOf<HomeEffect>(HomeEffect.OpenDetail("item-2")), received)
        assertEquals(emptyList(), again)
        secondCollector.cancel()
        vm.close()
    }

    @Test fun `retry cancels the running load and publishes the new result`() = runTest(dispatcher) {
        val repository = FakeRepository(Behavior.Never, catalog)
        val vm = factory(repository).homeViewModel()
        runCurrent()
        vm.onAction(HomeAction.Retry)
        runCurrent()
        assertEquals(1, repository.cancellations)
        assertEquals(2, repository.calls)
        assertEquals(HomePhase.CONTENT, vm.state.value.phase)
        vm.close()
    }

    @Test fun `a superseded load that completes late never overwrites the newer result`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        val repository = FakeRepository(Behavior.Late(gate, Behavior.Failure), catalog)
        val vm = factory(repository).homeViewModel()
        runCurrent()
        vm.onAction(HomeAction.Retry)
        runCurrent()
        assertEquals(content, vm.state.value)
        gate.complete(Unit)
        runCurrent()
        assertEquals(1, repository.lateAnswers)
        assertEquals(content, vm.state.value)
        vm.close()
    }

    @Test fun `close cancels in-flight work without a failure state and is idempotent`() = runTest(dispatcher) {
        val repository = FakeRepository(Behavior.Never)
        val vm = factory(repository).homeViewModel()
        runCurrent()
        vm.close()
        vm.close()
        runCurrent()
        assertTrue(vm.isClosed)
        assertEquals(1, repository.cancellations)
        assertEquals(HomeState(), vm.state.value)
    }

    @Test fun `a closed ViewModel ignores actions`() = runTest(dispatcher) {
        val repository = FakeRepository(catalog)
        val vm = factory(repository).homeViewModel()
        runCurrent()
        assertEquals(content, vm.state.value)
        vm.close()
        vm.onAction(HomeAction.Retry)
        vm.onAction(HomeAction.SelectItem("item-1"))
        runCurrent()
        assertEquals(content, vm.state.value)
        assertEquals(1, repository.calls)
        assertEquals(emptyList(), vm.effects.toList())
    }

    @Test fun `a load that completes late after close never publishes`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        val repository = FakeRepository(Behavior.Late(gate, catalog))
        val vm = factory(repository).homeViewModel()
        runCurrent()
        vm.close()
        gate.complete(Unit)
        runCurrent()
        assertEquals(1, repository.lateAnswers)
        assertEquals(HomeState(), vm.state.value)
    }

    @Test fun `clearing the owning store cancels in-flight work and ends the effects without close`() =
        runTest(dispatcher) {
            val repository = FakeRepository(Behavior.Never)
            val store = ViewModelStore()
            val vm = store.provide { factory(repository).homeViewModel() }
            val collected = mutableListOf<HomeEffect>()
            val collector = launch { collected += vm.effects.toList() }
            runCurrent()
            vm.onAction(HomeAction.SelectItem("item-2"))
            store.clear()
            runCurrent()
            assertTrue(vm.isClosed)
            assertEquals(1, repository.cancellations)
            assertEquals(HomeState(), vm.state.value)
            assertTrue(collector.isCompleted)
            assertEquals(listOf<HomeEffect>(HomeEffect.OpenDetail("item-2")), collected)
        }

    @Test fun `a cleared ViewModel ignores actions`() = runTest(dispatcher) {
        val repository = FakeRepository(catalog)
        val store = ViewModelStore()
        val vm = store.provide { factory(repository).homeViewModel() }
        runCurrent()
        assertEquals(content, vm.state.value)
        store.clear()
        vm.onAction(HomeAction.Retry)
        vm.onAction(HomeAction.SelectItem("item-1"))
        runCurrent()
        assertTrue(vm.isClosed)
        assertEquals(content, vm.state.value)
        assertEquals(1, repository.calls)
        assertEquals(emptyList(), vm.effects.toList())
    }
}
