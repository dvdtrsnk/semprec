package cz.semprec.app.presentation

import androidx.lifecycle.ViewModelStore
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** Counts actions in its state and echoes each action as an effect. */
private class EchoViewModel : ScreenViewModel<Int, String, String>(0) {
    override fun onAction(action: String) {
        update { it + 1 }
        emit(action)
    }
}

@OptIn(ExperimentalCoroutinesApi::class)
class ScreenViewModelTest : MainDispatcherTest() {
    @Test fun `state starts with the initial value and holds the latest update`() = runTest(dispatcher) {
        val vm = EchoViewModel()
        assertEquals(0, vm.state.value)
        vm.onAction("a")
        vm.onAction("b")
        assertEquals(2, vm.state.value)
        vm.close()
    }

    @Test fun `effects sent before collection are buffered and delivered once in order`() = runTest(dispatcher) {
        val vm = EchoViewModel()
        vm.onAction("a")
        vm.onAction("b")
        val first = mutableListOf<String>()
        val firstCollector = launch { vm.effects.collect { first += it } }
        runCurrent()
        firstCollector.cancel()
        val second = mutableListOf<String>()
        val secondCollector = launch { vm.effects.collect { second += it } }
        runCurrent()
        assertEquals(listOf("a", "b"), first)
        assertEquals(emptyList(), second)
        secondCollector.cancel()
        vm.close()
    }

    @Test fun `each effect reaches only one of several collectors`() = runTest(dispatcher) {
        val vm = EchoViewModel()
        val received = mutableListOf<String>()
        val collectors = List(2) { launch { vm.effects.collect { received += it } } }
        runCurrent()
        vm.onAction("a")
        vm.onAction("b")
        runCurrent()
        assertEquals(listOf("a", "b"), received.sorted())
        collectors.forEach { it.cancel() }
        vm.close()
    }

    @Test fun `close is idempotent and ends the effect stream but keeps the last state`() = runTest(dispatcher) {
        val vm = EchoViewModel()
        vm.onAction("a")
        val collected = mutableListOf<String>()
        val collector = launch { collected += vm.effects.toList() }
        runCurrent()
        assertFalse(vm.isClosed)
        vm.close()
        vm.close()
        runCurrent()
        assertTrue(vm.isClosed)
        assertTrue(collector.isCompleted)
        assertEquals(listOf("a"), collected)
        assertEquals(1, vm.state.value)
    }

    @Test fun `effects emitted before close are still delivered and later ones are dropped`() = runTest(dispatcher) {
        val vm = EchoViewModel()
        vm.onAction("early")
        vm.close()
        vm.onAction("late")
        assertEquals(listOf("early"), vm.effects.toList())
    }

    @Test fun `clearing the owning store ends the ViewModel as close does`() = runTest(dispatcher) {
        val store = ViewModelStore()
        val vm = store.provide { EchoViewModel() }
        vm.onAction("a")
        val collected = mutableListOf<String>()
        val collector = launch { collected += vm.effects.toList() }
        runCurrent()
        vm.onAction("b")
        assertFalse(vm.isClosed)
        store.clear()
        runCurrent()
        assertTrue(vm.isClosed)
        assertTrue(collector.isCompleted)
        assertEquals(listOf("a", "b"), collected)
        assertEquals(2, vm.state.value)
        vm.onAction("late")
        assertEquals(emptyList(), vm.effects.toList())
    }

    @Test fun `effects emitted before clearing are still delivered`() = runTest(dispatcher) {
        val store = ViewModelStore()
        val vm = store.provide { EchoViewModel() }
        vm.onAction("early")
        store.clear()
        assertEquals(listOf("early"), vm.effects.toList())
    }
}
