package cz.semprec.app.sdk

import cz.semprec.app.presentation.DetailPhase
import cz.semprec.app.presentation.HomeItem
import cz.semprec.app.presentation.HomePhase
import cz.semprec.app.presentation.SettingsRow
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
import kotlin.test.assertNull
import kotlin.test.assertTrue

@OptIn(ExperimentalCoroutinesApi::class)
class HomeSDKTest {
    private val dispatcher = StandardTestDispatcher()
    @BeforeTest fun installMain() = Dispatchers.setMain(dispatcher)
    @AfterTest fun removeMain() = Dispatchers.resetMain()

    @Test fun `every call returns a new ViewModel that its caller owns`() = runTest(dispatcher) {
        val sdk = HomeSDK()
        val pairs = listOf(
            sdk.homeViewModel() to sdk.homeViewModel(),
            sdk.detailViewModel("item-1") to sdk.detailViewModel("item-1"),
            sdk.settingsViewModel() to sdk.settingsViewModel(),
        )
        pairs.forEach { (first, second) ->
            assertNotSame(first, second)
            first.close()
            assertTrue(first.isClosed)
            assertFalse(second.isClosed)
            second.close()
        }
    }

    @Test fun `home lists the in-memory items in order`() = runTest(dispatcher) {
        val vm = HomeSDK().homeViewModel()
        runCurrent()
        assertEquals(HomePhase.CONTENT, vm.state.value.phase)
        assertEquals((1..5).map { HomeItem("item-$it", it) }, vm.state.value.items)
        vm.close()
    }

    @Test fun `detail loads an in-memory item and reports an unknown id as not found`() = runTest(dispatcher) {
        val sdk = HomeSDK()
        val found = sdk.detailViewModel("item-3")
        val missing = sdk.detailViewModel("item-6")
        runCurrent()
        assertEquals(HomeItem("item-3", 3), found.state.value.item)
        assertEquals(DetailPhase.NOT_FOUND, missing.state.value.phase)
        assertNull(missing.state.value.item)
        found.close()
        missing.close()
    }

    @Test fun `settings lists the about row`() = runTest(dispatcher) {
        val vm = HomeSDK().settingsViewModel()
        assertEquals(listOf(SettingsRow.ABOUT), vm.state.value.rows)
        vm.close()
    }
}
