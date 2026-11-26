package cz.semprec.app.presentation

import androidx.lifecycle.ViewModelStore
import cz.semprec.app.core.DeviceAlarmAuthorization
import cz.semprec.app.core.DeviceAlarmFailure
import cz.semprec.app.core.DeviceAlarmScheduling
import cz.semprec.app.core.FailureKind
import cz.semprec.app.core.InMemorySleepAlarmLedger
import cz.semprec.app.core.InMemoryWakeStorage
import cz.semprec.app.core.WakeSettings
import cz.semprec.app.domain.CalendarDay
import cz.semprec.app.domain.LoadSleepAlarmNights
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.SleepNight
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.datetime.Instant
import kotlinx.datetime.TimeZone
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

private val TODAY_FOR_SETTINGS = CalendarDay(2026, 11, 25)

private fun ringingNight() =
    SleepNight(TODAY_FOR_SETTINGS, "p1", "Weekdays", sleepClock("23:00"), sleepClock("06:45"), true, false, 465)

@OptIn(ExperimentalCoroutinesApi::class)
class WakeSettingsViewModelTest : MainDispatcherTest() {
    private val device = ScriptedAlarms()
    private val storage = InMemoryWakeStorage()
    private val wake = WakeMissions(storage, device)
    private val repository = FakeSleepRepository(
        sleepContent(),
        nightsAnswer = RepositoryResult.Content(listOf(ringingNight())),
    )

    private fun viewModel(repository: FakeSleepRepository = this.repository) = WakeSettingsViewModel(
        wake,
        SleepAlarmSync(
            LoadSleepAlarmNights(repository),
            device,
            InMemorySleepAlarmLedger(),
            wake,
            now = { Instant.parse("2026-11-25T08:30:00Z") },
            zone = { TimeZone.of("Europe/Prague") },
        ),
    )

    @Test fun `the settings the device holds are the first state`() = runTest(dispatcher) {
        wake.changeSettings { WakeSettings(requiresCode = true, codes = listOf("123")) }

        val vm = viewModel()

        assertEquals(WakeSettingsState(true, listOf("123"), WakeMode.ON, null), vm.state.value)
        vm.close()
    }

    @Test fun `the mode says what an alarm needs`() = runTest(dispatcher) {
        val vm = viewModel()
        assertEquals(WakeMode.OFF, vm.state.value.mode)

        vm.onAction(WakeSettingsAction.SetRequiresCode(true))
        runCurrent()
        assertEquals(WakeMode.NEEDS_CODE, vm.state.value.mode)

        vm.onAction(WakeSettingsAction.AddCode("123"))
        runCurrent()
        assertEquals(WakeMode.ON, vm.state.value.mode)

        vm.onAction(WakeSettingsAction.SetRequiresCode(false))
        runCurrent()
        assertEquals(WakeMode.OFF, vm.state.value.mode)
        assertEquals(listOf("123"), vm.state.value.codes, "the codes stay while the switch is off")
        vm.close()
    }

    @Test fun `a change is kept at once and the alarms follow it`() = runTest(dispatcher) {
        val vm = viewModel()

        vm.onAction(WakeSettingsAction.SetRequiresCode(true))
        vm.onAction(WakeSettingsAction.AddCode("  123 "))
        assertEquals(WakeSettings(true, listOf("123")), storage.loadSettings())
        runCurrent()

        assertEquals(listOf(true), device.opensWakeGuard.take(1))
        assertEquals("sleep:2026-11-26T05:45:00Z", wake.missions.value.single().key)
        assertNull(vm.state.value.failure)
        vm.close()
    }

    @Test fun `a code is added once, trimmed, and removed by its text`() = runTest(dispatcher) {
        val vm = viewModel()

        vm.onAction(WakeSettingsAction.AddCode("123"))
        vm.onAction(WakeSettingsAction.AddCode(" 123"))
        vm.onAction(WakeSettingsAction.AddCode("456"))
        assertEquals(listOf("123", "456"), vm.state.value.codes)

        vm.onAction(WakeSettingsAction.RemoveCode(" 123 "))
        vm.onAction(WakeSettingsAction.RemoveCode("unknown"))
        assertEquals(listOf("456"), vm.state.value.codes)
        runCurrent()
        vm.close()
    }

    @Test fun `a blank code is a failure and changes nothing`() = runTest(dispatcher) {
        val vm = viewModel()

        vm.onAction(WakeSettingsAction.AddCode("   "))

        assertEquals(WakeSettingsFailure.EMPTY_CODE, vm.state.value.failure)
        assertTrue(vm.state.value.codes.isEmpty())
        vm.onAction(WakeSettingsAction.DismissFailure)
        assertNull(vm.state.value.failure)
        assertEquals(0, repository.overviewCalls)
        vm.close()
    }

    @Test fun `what the device refused is the failure and the next change clears it`() = runTest(dispatcher) {
        val vm = viewModel()
        wake.changeSettings { WakeSettings(true, listOf("1")) }
        val cases = mapOf(
            DeviceAlarmFailure.NOT_AUTHORIZED to WakeSettingsFailure.NOT_AUTHORIZED,
            DeviceAlarmFailure.LIMIT_REACHED to WakeSettingsFailure.LIMIT_REACHED,
        )
        for ((refusal, expected) in cases) {
            device.scheduleAnswers = ArrayDeque(listOf(DeviceAlarmScheduling.Refused(refusal)))
            vm.onAction(WakeSettingsAction.AddCode("c-$refusal"))
            runCurrent()
            assertEquals(expected, vm.state.value.failure)
        }

        vm.onAction(WakeSettingsAction.AddCode("fine"))
        assertNull(vm.state.value.failure, "a new change starts without the old failure")
        vm.close()
    }

    @Test fun `a plan that cannot be read and a device that fails are failures of their own`() = runTest(dispatcher) {
        val unreadable = viewModel(FakeSleepRepository(sleepUnavailable()))
        unreadable.onAction(WakeSettingsAction.SetRequiresCode(true))
        runCurrent()
        assertEquals(WakeSettingsFailure.READ_FAILED, unreadable.state.value.failure)

        device.unreadable = true
        val broken = viewModel()
        broken.onAction(WakeSettingsAction.SetRequiresCode(false))
        runCurrent()
        assertEquals(WakeSettingsFailure.DEVICE_FAILED, broken.state.value.failure)
        unreadable.close()
        broken.close()
    }

    @Test fun `a device without alarms is no failure`() = runTest(dispatcher) {
        device.authorization = DeviceAlarmAuthorization.UNSUPPORTED
        val vm = viewModel()

        vm.onAction(WakeSettingsAction.SetRequiresCode(true))
        runCurrent()

        assertNull(vm.state.value.failure)
        assertTrue(vm.state.value.requiresCode)
        vm.close()
    }

    @Test fun `two windows see the same settings`() = runTest(dispatcher) {
        val first = viewModel()
        val second = viewModel()

        first.onAction(WakeSettingsAction.SetRequiresCode(true))
        runCurrent()

        assertTrue(second.state.value.requiresCode)
        first.close()
        second.close()
    }

    @Test fun `closing while the alarms change ends the run and an action after close does nothing`() =
        runTest(dispatcher) {
            val vm = viewModel(
                FakeSleepRepository(sleepContent(), nightsAnswer = RepositoryResult.Content(listOf(ringingNight())))
                    .also { it.gate = CompletableDeferred() },
            )
            vm.onAction(WakeSettingsAction.SetRequiresCode(true))
            runCurrent()

            vm.close()
            vm.onAction(WakeSettingsAction.AddCode("123"))
            runCurrent()

            assertTrue(vm.isClosed)
            assertTrue(wake.settings.value.codes.isEmpty())
            assertEquals(0, device.heldReads)
        }

    @Test fun `a plan read that fails with a typed failure is the read failure`() = runTest(dispatcher) {
        val vm = viewModel(
            FakeSleepRepository(sleepContent(), nightsAnswer = RepositoryResult.Failure(FailureKind.REJECTED)),
        )

        vm.onAction(WakeSettingsAction.SetRequiresCode(true))
        runCurrent()

        assertEquals(WakeSettingsFailure.READ_FAILED, vm.state.value.failure)
        vm.close()
    }

    @Test fun `clearing the store ends the ViewModel like close`() = runTest(dispatcher) {
        val store = ViewModelStore()
        val vm = store.provide { viewModel() }

        store.clear()
        vm.onAction(WakeSettingsAction.SetRequiresCode(true))

        assertTrue(vm.isClosed)
        assertEquals(WakeSettings(), wake.settings.value)
    }
}
