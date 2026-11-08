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
import kotlin.test.assertTrue

@OptIn(ExperimentalCoroutinesApi::class)
class DetailViewModelTest : MainDispatcherTest() {
    private val content = DetailState(DetailPhase.CONTENT, HomeItem("item-1", 1))

    @Test fun `starts loading and publishes the requested item`() = runTest(dispatcher) {
        val vm = factory(FakeRepository(catalog)).detailViewModel("item-2")
        assertEquals(DetailState(), vm.state.value)
        runCurrent()
        assertEquals(DetailState(DetailPhase.CONTENT, HomeItem("item-2", 2)), vm.state.value)
        vm.close()
    }

    @Test fun `an unknown id is not found`() = runTest(dispatcher) {
        val vm = factory(FakeRepository(catalog)).detailViewModel("item-9")
        runCurrent()
        assertEquals(DetailState(DetailPhase.NOT_FOUND), vm.state.value)
        vm.close()
    }

    @Test fun `an expected failure is an error with its kind and retry recovers`() = runTest(dispatcher) {
        val repository = FakeRepository(Behavior.Failure, catalog)
        val vm = factory(repository).detailViewModel("item-1")
        runCurrent()
        assertEquals(DetailState(DetailPhase.ERROR, failure = FailureKind.UNAVAILABLE), vm.state.value)
        vm.onAction(DetailAction.Retry)
        assertEquals(DetailState(), vm.state.value)
        runCurrent()
        assertEquals(content, vm.state.value)
        assertEquals(2, repository.calls)
        vm.close()
    }

    @Test fun `an unexpected exception is an error without a failure kind`() = runTest(dispatcher) {
        val vm = factory(FakeRepository(Behavior.Crash)).detailViewModel("item-1")
        runCurrent()
        assertEquals(DetailState(DetailPhase.ERROR), vm.state.value)
        vm.close()
    }

    @Test fun `retry cancels the running load and publishes the new result`() = runTest(dispatcher) {
        val repository = FakeRepository(Behavior.Never, catalog)
        val vm = factory(repository).detailViewModel("item-1")
        runCurrent()
        vm.onAction(DetailAction.Retry)
        runCurrent()
        assertEquals(1, repository.cancellations)
        assertEquals(2, repository.calls)
        assertEquals(DetailPhase.CONTENT, vm.state.value.phase)
        vm.close()
    }

    @Test fun `a superseded load that completes late never overwrites the newer result`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        val repository = FakeRepository(Behavior.Late(gate, Behavior.Failure), catalog)
        val vm = factory(repository).detailViewModel("item-1")
        runCurrent()
        vm.onAction(DetailAction.Retry)
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
        val vm = factory(repository).detailViewModel("item-1")
        runCurrent()
        vm.close()
        vm.close()
        runCurrent()
        assertTrue(vm.isClosed)
        assertEquals(1, repository.cancellations)
        assertEquals(DetailState(), vm.state.value)
    }

    @Test fun `a closed ViewModel ignores retry`() = runTest(dispatcher) {
        val repository = FakeRepository(catalog)
        val vm = factory(repository).detailViewModel("item-1")
        runCurrent()
        assertEquals(content, vm.state.value)
        vm.close()
        vm.onAction(DetailAction.Retry)
        runCurrent()
        assertEquals(content, vm.state.value)
        assertEquals(1, repository.calls)
    }

    @Test fun `a load that completes late after close never publishes`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        val repository = FakeRepository(Behavior.Late(gate, catalog))
        val vm = factory(repository).detailViewModel("item-1")
        runCurrent()
        vm.close()
        gate.complete(Unit)
        runCurrent()
        assertEquals(1, repository.lateAnswers)
        assertEquals(DetailState(), vm.state.value)
    }

    @Test fun `clearing the owning store cancels in-flight work and ends the effects without close`() =
        runTest(dispatcher) {
            val repository = FakeRepository(Behavior.Never)
            val store = ViewModelStore()
            val vm = store.provide { factory(repository).detailViewModel("item-1") }
            val collector = launch { vm.effects.toList() }
            runCurrent()
            store.clear()
            runCurrent()
            assertTrue(vm.isClosed)
            assertEquals(1, repository.cancellations)
            assertEquals(DetailState(), vm.state.value)
            assertTrue(collector.isCompleted)
        }

    @Test fun `a cleared ViewModel ignores retry`() = runTest(dispatcher) {
        val repository = FakeRepository(catalog)
        val store = ViewModelStore()
        val vm = store.provide { factory(repository).detailViewModel("item-1") }
        runCurrent()
        assertEquals(content, vm.state.value)
        store.clear()
        vm.onAction(DetailAction.Retry)
        runCurrent()
        assertTrue(vm.isClosed)
        assertEquals(content, vm.state.value)
        assertEquals(1, repository.calls)
    }
}
