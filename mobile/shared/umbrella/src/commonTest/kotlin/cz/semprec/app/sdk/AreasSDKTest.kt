package cz.semprec.app.sdk

import cz.semprec.app.core.FailureKind
import cz.semprec.app.presentation.AreaPhase
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
class AreasSDKTest {
    private val dispatcher = StandardTestDispatcher()
    @BeforeTest fun installMain() = Dispatchers.setMain(dispatcher)
    @AfterTest fun removeMain() = Dispatchers.resetMain()

    @Test fun `every call returns a new area ViewModel that its caller owns`() = runTest(dispatcher) {
        val sdk = HomeSDK()
        val first = sdk.areas.areaViewModel("a1") { "2026-10-21" }
        val second = sdk.areas.areaViewModel("a1") { "2026-10-21" }
        assertNotSame(first, second)
        first.close()
        assertTrue(first.isClosed)
        assertFalse(second.isClosed)
        second.close()
    }

    @Test fun `without a signed in session an area is unauthorized`() = runTest(dispatcher) {
        val area = HomeSDK().areas.areaViewModel("a1") { "2026-10-21" }
        runCurrent()
        assertEquals(AreaPhase.ERROR, area.state.value.phase)
        assertEquals(FailureKind.UNAUTHORIZED, area.state.value.failure)
        area.close()
    }
}
