package cz.semprec.app.sdk

import cz.semprec.app.core.FailureKind
import cz.semprec.app.presentation.SleepPhase
import cz.semprec.app.presentation.SleepScreen
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
        val first = sdk.sleepViewModel("2026-10-16", startOnNight = false)
        val second = sdk.sleepViewModel("2026-10-16", startOnNight = false)
        assertNotSame(first, second)
        first.close()
        assertTrue(first.isClosed)
        assertFalse(second.isClosed)
        second.close()
    }

    @Test fun `without a session the sleep sheet fails as unauthorized and opens on the night when asked`() =
        runTest(dispatcher) {
            val vm = HomeSDK().sleepViewModel("2026-10-16", startOnNight = true)
            runCurrent()
            assertEquals(SleepPhase.ERROR, vm.state.value.phase)
            assertEquals(FailureKind.UNAUTHORIZED, vm.state.value.failure)
            assertEquals(SleepScreen.NIGHT, vm.state.value.screen)
            vm.close()
        }
}
