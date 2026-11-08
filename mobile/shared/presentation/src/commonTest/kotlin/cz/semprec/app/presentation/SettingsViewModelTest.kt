package cz.semprec.app.presentation

import androidx.lifecycle.ViewModelStore
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

@OptIn(ExperimentalCoroutinesApi::class)
class SettingsViewModelTest : MainDispatcherTest() {
    @Test fun `lists the about row`() = runTest(dispatcher) {
        val vm = factory(FakeRepository(catalog)).settingsViewModel()
        assertEquals(listOf(SettingsRow.ABOUT), vm.state.value.rows)
        vm.close()
    }

    @Test fun `selecting the about row shows about exactly once`() = runTest(dispatcher) {
        val vm = factory(FakeRepository(catalog)).settingsViewModel()
        vm.onAction(SettingsAction.SelectRow(SettingsRow.ABOUT))
        val received = mutableListOf<SettingsEffect>()
        val collector = launch { vm.effects.collect { received += it } }
        runCurrent()
        collector.cancel()
        val again = mutableListOf<SettingsEffect>()
        val secondCollector = launch { vm.effects.collect { again += it } }
        runCurrent()
        assertEquals(listOf<SettingsEffect>(SettingsEffect.ShowAbout), received)
        assertEquals(emptyList(), again)
        secondCollector.cancel()
        vm.close()
    }

    @Test fun `a closed ViewModel ignores actions`() = runTest(dispatcher) {
        val vm = factory(FakeRepository(catalog)).settingsViewModel()
        vm.close()
        vm.onAction(SettingsAction.SelectRow(SettingsRow.ABOUT))
        assertEquals(emptyList(), vm.effects.toList())
    }

    @Test fun `clearing the owning store ends the effects and later actions without close`() = runTest(dispatcher) {
        val store = ViewModelStore()
        val vm = store.provide { factory(FakeRepository(catalog)).settingsViewModel() }
        val collected = mutableListOf<SettingsEffect>()
        val collector = launch { collected += vm.effects.toList() }
        runCurrent()
        vm.onAction(SettingsAction.SelectRow(SettingsRow.ABOUT))
        store.clear()
        runCurrent()
        assertTrue(vm.isClosed)
        assertTrue(collector.isCompleted)
        assertEquals(listOf<SettingsEffect>(SettingsEffect.ShowAbout), collected)
        vm.onAction(SettingsAction.SelectRow(SettingsRow.ABOUT))
        assertEquals(emptyList(), vm.effects.toList())
    }
}
