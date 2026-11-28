package cz.alldots.app.sdk

import cz.alldots.app.core.FailureKind
import cz.alldots.app.core.ItemKind
import cz.alldots.app.presentation.ItemDetailsPhase
import cz.alldots.app.presentation.TasksPhase
import cz.alldots.app.presentation.TasksStart
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

@OptIn(ExperimentalCoroutinesApi::class)
class WorkSDKTest {
    private val dispatcher = StandardTestDispatcher()
    @BeforeTest fun installMain() = Dispatchers.setMain(dispatcher)
    @AfterTest fun removeMain() = Dispatchers.resetMain()

    @Test fun `every call returns a new task screen and sheet that its caller owns`() = runTest(dispatcher) {
        val sdk = HomeSDK()
        val lists = listOf(
            sdk.tasksViewModel({ "2026-10-16" }, TasksStart()),
            sdk.tasksViewModel({ "2026-10-16" }, TasksStart()),
        )
        val sheets = listOf(
            sdk.itemDetailsViewModel(ItemKind.TASK, "t1"),
            sdk.itemDetailsViewModel(ItemKind.TASK, "t1"),
        )
        assertNotSame(lists[0], lists[1])
        assertNotSame(sheets[0], sheets[1])
        lists[0].close()
        sheets[0].close()
        assertFalse(lists[1].isClosed)
        assertFalse(sheets[1].isClosed)
        lists[1].close()
        sheets[1].close()
    }

    @Test fun `without a session the screens fail as unauthorized`() = runTest(dispatcher) {
        val sdk = HomeSDK()
        val list = sdk.tasksViewModel({ "2026-10-16" }, TasksStart())
        val sheet = sdk.itemDetailsViewModel(ItemKind.EVENT, "e1")
        runCurrent()

        assertEquals(TasksPhase.ERROR, list.state.value.phase)
        assertEquals(FailureKind.UNAUTHORIZED, list.state.value.failure)
        assertEquals(ItemDetailsPhase.ERROR, sheet.state.value.phase)
        assertEquals(FailureKind.UNAUTHORIZED, sheet.state.value.failure)
        list.close()
        sheet.close()
    }
}
