package cz.semprec.app.sdk

import cz.semprec.app.core.FailureKind
import cz.semprec.app.presentation.OverviewPhase
import cz.semprec.app.presentation.SearchAction
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
class OverviewSDKTest {
    private val dispatcher = StandardTestDispatcher()

    @BeforeTest fun installMain() = Dispatchers.setMain(dispatcher)

    @AfterTest fun removeMain() = Dispatchers.resetMain()

    @Test fun `every call returns a new overview and search ViewModel that its caller owns`() = runTest(dispatcher) {
        val sdk = HomeSDK()
        val pairs = listOf(
            sdk.overviewViewModel() to sdk.overviewViewModel(),
            sdk.searchViewModel() to sdk.searchViewModel(),
        )
        pairs.forEach { (first, second) ->
            assertNotSame(first, second)
            first.close()
            assertTrue(first.isClosed)
            assertFalse(second.isClosed)
            second.close()
        }
    }

    @Test fun `without a session the overview ends in the unauthorized failure`() = runTest(dispatcher) {
        val vm = HomeSDK().overviewViewModel()
        runCurrent()
        assertEquals(OverviewPhase.ERROR, vm.state.value.phase)
        assertEquals(FailureKind.UNAUTHORIZED, vm.state.value.failure)
        vm.close()
    }

    @Test fun `the recent searches of one SDK outlive the search overlay and are not shared with another SDK`() =
        runTest(dispatcher) {
            val sdk = HomeSDK()
            val first = sdk.searchViewModel()
            first.onAction(SearchAction.Submit("faktura"))
            first.close()
            val second = sdk.searchViewModel()
            val other = HomeSDK().searchViewModel()
            assertEquals(listOf("faktura"), second.state.value.recents)
            assertEquals(emptyList<String>(), other.state.value.recents)
            second.close()
            other.close()
        }
}
