package cz.semprec.app.sdk

import cz.semprec.app.core.FailureKind
import cz.semprec.app.presentation.ProjectMailSignalsPhase
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
class MailSignalsSDKTest {
    private val dispatcher = StandardTestDispatcher()
    @BeforeTest fun installMain() = Dispatchers.setMain(dispatcher)
    @AfterTest fun removeMain() = Dispatchers.resetMain()

    @Test fun `every call returns a new mail signals ViewModel that its caller owns`() = runTest(dispatcher) {
        val signals = HomeSDK().mailSignals
        val first = signals.projectMailSignalsViewModel("p1")
        val second = signals.projectMailSignalsViewModel("p1")
        assertNotSame(first, second)
        first.close()
        assertTrue(first.isClosed)
        assertFalse(second.isClosed)
        second.close()
    }

    @Test fun `without a signed in session the signals are unauthorized`() = runTest(dispatcher) {
        val viewModel = HomeSDK().mailSignals.projectMailSignalsViewModel("p1")
        runCurrent()
        assertEquals(ProjectMailSignalsPhase.ERROR, viewModel.state.value.phase)
        assertEquals(FailureKind.UNAUTHORIZED, viewModel.state.value.failure)
        viewModel.close()
    }
}
