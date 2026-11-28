package cz.alldots.app.sdk

import cz.alldots.app.core.FailureKind
import cz.alldots.app.presentation.SleepPhase
import cz.alldots.app.presentation.SleepScreen
import cz.alldots.app.presentation.WakeGuardPhase
import cz.alldots.app.presentation.WakeSettingsAction
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotSame
import kotlin.test.assertTrue

@OptIn(ExperimentalCoroutinesApi::class)
class SleepSDKTest {
    private val dispatcher = StandardTestDispatcher()
    @BeforeTest fun installMain() = Dispatchers.setMain(dispatcher)
    @AfterTest fun removeMain() = Dispatchers.resetMain()

    @Test fun `every call returns a new sleep ViewModel that its caller owns`() = runTest(dispatcher) {
        val sdk = HomeSDK()
        val first = sdk.sleep.sleepViewModel("2026-10-16", startOnNight = false)
        val second = sdk.sleep.sleepViewModel("2026-10-16", startOnNight = false)
        assertNotSame(first, second)
        first.close()
        assertTrue(first.isClosed)
        assertFalse(second.isClosed)
        second.close()
    }

    @Test fun `without a session the sleep sheet fails as unauthorized and opens on the night when asked`() =
        runTest(dispatcher) {
            val vm = HomeSDK().sleep.sleepViewModel("2026-10-16", startOnNight = true)
            runCurrent()
            assertEquals(SleepPhase.ERROR, vm.state.value.phase)
            assertEquals(FailureKind.UNAUTHORIZED, vm.state.value.failure)
            assertEquals(SleepScreen.NIGHT, vm.state.value.screen)
            vm.close()
        }

    @Test fun `every call returns a new wake ViewModel and they work without the process's services`() =
        runTest(dispatcher) {
            val sdk = HomeSDK()
            val settings = sdk.sleep.wakeSettingsViewModel()
            val guard = sdk.sleep.wakeGuardViewModel()
            assertNotSame(settings, sdk.sleep.wakeSettingsViewModel())
            assertNotSame(guard, sdk.sleep.wakeGuardViewModel())

            settings.onAction(WakeSettingsAction.AddCode("123"))
            runCurrent()

            assertEquals(listOf("123"), settings.state.value.codes)
            assertEquals(WakeGuardPhase.IDLE, guard.state.value.phase)
            settings.close()
            guard.close()
        }
}
