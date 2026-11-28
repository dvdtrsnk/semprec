package cz.alldots.app.presentation

import cz.alldots.app.domain.NoOfflineStatus
import cz.alldots.app.domain.OfflineStatus
import cz.alldots.app.domain.OfflineStatusSource
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals

/** A status the test sets, counting how often the failures were forgotten; [refusing] makes forgetting throw. */
private class FakeOfflineStatus : OfflineStatusSource {
    override val status = MutableStateFlow(OfflineStatus(offline = false, waiting = 0, failed = 0))
    var forgotten = 0
    var refusing = false

    override suspend fun forgetFailures() {
        forgotten += 1
        check(!refusing) { "the store could not be written" }
        status.value = status.value.copy(failed = 0)
    }
}

@OptIn(ExperimentalCoroutinesApi::class)
class SyncStatusViewModelTest : MainDispatcherTest() {
    private val source = FakeOfflineStatus()

    @Test fun `the state follows the offline state and the changes that wait or were refused`() = runTest(dispatcher) {
        val vm = SyncStatusViewModel(source)
        runCurrent()
        assertEquals(SyncStatusState(offline = false, waiting = 0, failed = 0), vm.state.value)

        source.status.value = OfflineStatus(offline = true, waiting = 3, failed = 0)
        runCurrent()
        assertEquals(SyncStatusState(offline = true, waiting = 3, failed = 0), vm.state.value)

        source.status.value = OfflineStatus(offline = false, waiting = 0, failed = 2)
        runCurrent()
        assertEquals(SyncStatusState(offline = false, waiting = 0, failed = 2), vm.state.value)
        vm.close()
    }

    @Test fun `dismissing the failures forgets them once and the state shows none`() = runTest(dispatcher) {
        source.status.value = OfflineStatus(offline = false, waiting = 0, failed = 2)
        val vm = SyncStatusViewModel(source)
        runCurrent()
        vm.onAction(SyncStatusAction.DismissFailures)
        runCurrent()
        assertEquals(1, source.forgotten)
        assertEquals(0, vm.state.value.failed)
        vm.close()
    }

    @Test fun `a forgetting that fails leaves the failures shown`() = runTest(dispatcher) {
        source.status.value = OfflineStatus(offline = false, waiting = 0, failed = 2)
        source.refusing = true
        val vm = SyncStatusViewModel(source)
        runCurrent()
        vm.onAction(SyncStatusAction.DismissFailures)
        runCurrent()
        assertEquals(1, source.forgotten)
        assertEquals(2, vm.state.value.failed)
        vm.close()
    }

    @Test fun `a closed ViewModel forgets nothing and stops following`() = runTest(dispatcher) {
        val vm = SyncStatusViewModel(source)
        runCurrent()
        vm.close()
        vm.onAction(SyncStatusAction.DismissFailures)
        source.status.value = OfflineStatus(offline = true, waiting = 1, failed = 0)
        runCurrent()
        assertEquals(0, source.forgotten)
        assertEquals(SyncStatusState(), vm.state.value)
    }

    @Test fun `without a device store it is online with nothing waiting`() = runTest(dispatcher) {
        val vm = SyncStatusViewModel(NoOfflineStatus)
        runCurrent()
        vm.onAction(SyncStatusAction.DismissFailures)
        runCurrent()
        assertEquals(SyncStatusState(offline = false, waiting = 0, failed = 0), vm.state.value)
        vm.close()
    }
}
