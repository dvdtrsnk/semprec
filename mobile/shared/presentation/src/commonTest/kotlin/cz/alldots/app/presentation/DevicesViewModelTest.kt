package cz.alldots.app.presentation

import androidx.lifecycle.ViewModelStore
import cz.alldots.app.core.AccountDeviceKind
import cz.alldots.app.core.AccountPlatform
import cz.alldots.app.core.FailureKind
import cz.alldots.app.domain.AccountDevice
import cz.alldots.app.domain.AccountRepository
import cz.alldots.app.domain.AccountSummary
import cz.alldots.app.domain.RepositoryResult
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

private val THIS = AccountDevice("s1", true, AccountPlatform.IOS, AccountDeviceKind.IPHONE, "iPhone", "c1", "l1")
private val MAC = AccountDevice("s2", false, AccountPlatform.MACOS, AccountDeviceKind.MAC, "MacBook", "c2", "l2")
private val WEB = AccountDevice("s3", false, AccountPlatform.WEB, AccountDeviceKind.BROWSER, null, "c3", "l3")

private class ScriptedDevices(
    devices: List<ScriptedStep<List<AccountDevice>>> = listOf({ RepositoryResult.Content(listOf(WEB, THIS, MAC)) }),
    private val revoke: ScriptedStep<Unit> = { RepositoryResult.Content(Unit) },
) : AccountRepository {
    val lists = CallScript(devices)
    val revoked = mutableListOf<String>()
    var revokedOthers = 0
        private set

    override suspend fun summary(): RepositoryResult<AccountSummary> = error("not used")

    override suspend fun devices() = lists.next()

    override suspend fun revokeDevice(deviceId: String): RepositoryResult<Unit> {
        revoked += deviceId
        return revoke()
    }

    override suspend fun revokeOtherDevices(): RepositoryResult<Unit> {
        revokedOthers += 1
        return revoke()
    }

    override suspend fun changeLocale(locale: String): RepositoryResult<Unit> = error("not used")
}

@OptIn(ExperimentalCoroutinesApi::class)
class DevicesViewModelTest : MainDispatcherTest() {
    private fun viewModel(devices: ScriptedDevices) =
        accountFactory(devices, FakeAuthRepository()).devicesViewModel()

    private val web = DeviceItem("s3", AccountDeviceKind.BROWSER, AccountPlatform.WEB, null, "c3", "l3")
    private val mac = DeviceItem("s2", AccountDeviceKind.MAC, AccountPlatform.MACOS, "MacBook", "c2", "l2")

    @Test fun `loads this device apart from the others in the order of the server`() = runTest(dispatcher) {
        val vm = viewModel(ScriptedDevices())
        assertEquals(DevicesState(), vm.state.value)
        runCurrent()
        assertEquals(DevicesPhase.CONTENT, vm.state.value.phase)
        val current = DeviceItem("s1", AccountDeviceKind.IPHONE, AccountPlatform.IOS, "iPhone", "c1", "l1")
        assertEquals(current, vm.state.value.current)
        assertEquals(listOf(web, mac), vm.state.value.others)
        vm.close()
    }

    @Test fun `a list without this device has no current one`() = runTest(dispatcher) {
        val vm = viewModel(ScriptedDevices(devices = listOf({ RepositoryResult.Content(listOf(MAC)) })))
        runCurrent()
        assertNull(vm.state.value.current)
        assertEquals(listOf(mac), vm.state.value.others)
        vm.close()
    }

    @Test fun `a failed load is an error with its kind and retry loads again`() = runTest(dispatcher) {
        val devices = ScriptedDevices(
            devices = listOf(
                { RepositoryResult.Failure(FailureKind.UNAVAILABLE) },
                { RepositoryResult.Content(listOf(THIS)) },
            ),
        )
        val vm = viewModel(devices)
        runCurrent()
        assertEquals(DevicesState(DevicesPhase.ERROR, FailureKind.UNAVAILABLE), vm.state.value)
        vm.onAction(DevicesAction.Retry)
        assertEquals(DevicesState(), vm.state.value)
        runCurrent()
        assertEquals(DevicesPhase.CONTENT, vm.state.value.phase)
        vm.close()
    }

    @Test fun `an unexpected exception is an error without a kind`() = runTest(dispatcher) {
        val vm = viewModel(ScriptedDevices(devices = listOf(crashes())))
        runCurrent()
        assertEquals(DevicesState(DevicesPhase.ERROR, null), vm.state.value)
        vm.close()
    }

    @Test fun `a load that was superseded and answers late is not published`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        val devices = ScriptedDevices(
            devices = listOf(
                answersLate(gate, RepositoryResult.Content(listOf(THIS, MAC, WEB))),
                { RepositoryResult.Content(listOf(THIS)) },
            ),
        )
        val vm = viewModel(devices)
        runCurrent()
        vm.onAction(DevicesAction.Retry)
        runCurrent()
        gate.complete(Unit)
        runCurrent()
        assertTrue(vm.state.value.others.isEmpty())
        vm.close()
    }

    @Test fun `asking about a device opens the confirmation and nothing is revoked until it is confirmed`() =
        runTest(dispatcher) {
            val devices = ScriptedDevices()
            val vm = viewModel(devices)
            runCurrent()
            vm.onAction(DevicesAction.Ask("s2"))
            assertEquals(DevicesConfirm.One(mac), vm.state.value.confirm)
            assertTrue(devices.revoked.isEmpty())
            vm.onAction(DevicesAction.Cancel)
            assertNull(vm.state.value.confirm)
            vm.close()
        }

    @Test fun `this device and an unknown id cannot be asked about`() = runTest(dispatcher) {
        val vm = viewModel(ScriptedDevices())
        runCurrent()
        vm.onAction(DevicesAction.Ask("s1"))
        vm.onAction(DevicesAction.Ask("nope"))
        assertNull(vm.state.value.confirm)
        vm.close()
    }

    @Test fun `confirming signs out that device and removes it from the list`() = runTest(dispatcher) {
        val devices = ScriptedDevices()
        val vm = viewModel(devices)
        runCurrent()
        vm.onAction(DevicesAction.Ask("s2"))
        vm.onAction(DevicesAction.Confirm)
        assertTrue(vm.state.value.working)
        runCurrent()
        assertEquals(listOf("s2"), devices.revoked)
        assertEquals(listOf(web), vm.state.value.others)
        assertNull(vm.state.value.confirm)
        assertEquals(false, vm.state.value.working)
        vm.close()
    }

    @Test fun `signing out all the others empties the list and keeps this device`() = runTest(dispatcher) {
        val devices = ScriptedDevices()
        val vm = viewModel(devices)
        runCurrent()
        vm.onAction(DevicesAction.AskOthers)
        assertEquals(DevicesConfirm.Others, vm.state.value.confirm)
        vm.onAction(DevicesAction.Confirm)
        runCurrent()
        assertEquals(1, devices.revokedOthers)
        assertTrue(vm.state.value.others.isEmpty())
        assertEquals("s1", vm.state.value.current?.id)
        vm.close()
    }

    @Test fun `there is nothing to confirm without other devices`() = runTest(dispatcher) {
        val vm = viewModel(ScriptedDevices(devices = listOf({ RepositoryResult.Content(listOf(THIS)) })))
        runCurrent()
        vm.onAction(DevicesAction.AskOthers)
        vm.onAction(DevicesAction.Confirm)
        runCurrent()
        assertNull(vm.state.value.confirm)
        assertEquals(false, vm.state.value.working)
        vm.close()
    }

    @Test fun `a refused sign out keeps the list closes the confirmation and says why until dismissed`() =
        runTest(dispatcher) {
            val devices = ScriptedDevices(revoke = { RepositoryResult.Failure(FailureKind.UNAVAILABLE) })
            val vm = viewModel(devices)
            runCurrent()
            vm.onAction(DevicesAction.Ask("s3"))
            vm.onAction(DevicesAction.Confirm)
            runCurrent()
            assertEquals(listOf(web, mac), vm.state.value.others)
            assertNull(vm.state.value.confirm)
            assertEquals(Failed(FailureKind.UNAVAILABLE), vm.state.value.writeFailure)
            vm.onAction(DevicesAction.DismissFailure)
            assertNull(vm.state.value.writeFailure)
            vm.close()
        }

    @Test fun `a crashing sign out is a failure without a kind`() = runTest(dispatcher) {
        val vm = viewModel(ScriptedDevices(revoke = { error("unexpected") }))
        runCurrent()
        vm.onAction(DevicesAction.Ask("s3"))
        vm.onAction(DevicesAction.Confirm)
        runCurrent()
        assertEquals(Failed(null), vm.state.value.writeFailure)
        vm.close()
    }

    @Test fun `while a sign out runs cancel and a second confirm do nothing`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        val devices = ScriptedDevices(revoke = {
            gate.await()
            RepositoryResult.Content(Unit)
        })
        val vm = viewModel(devices)
        runCurrent()
        vm.onAction(DevicesAction.Ask("s3"))
        vm.onAction(DevicesAction.Confirm)
        vm.onAction(DevicesAction.Cancel)
        vm.onAction(DevicesAction.Confirm)
        runCurrent()
        assertTrue(vm.state.value.confirm != null)
        gate.complete(Unit)
        runCurrent()
        assertEquals(listOf("s3"), devices.revoked)
        vm.close()
    }

    @Test fun `closing cancels the load and ignores later actions and clearing the store does the same`() =
        runTest(dispatcher) {
            val devices = ScriptedDevices(devices = listOf(neverAnswers()))
            val vm = viewModel(devices)
            runCurrent()
            vm.close()
            runCurrent()
            assertEquals(1, devices.lists.cancellations)
            vm.onAction(DevicesAction.Retry)
            runCurrent()
            assertEquals(1, devices.lists.calls)

            val stored = ScriptedDevices(devices = listOf(neverAnswers()))
            val store = ViewModelStore()
            val owned = store.provide {
                accountFactory(stored, FakeAuthRepository()).devicesViewModel()
            }
            runCurrent()
            store.clear()
            runCurrent()
            assertTrue(owned.isClosed)
            assertEquals(1, stored.lists.cancellations)
        }
}
