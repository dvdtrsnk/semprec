package cz.alldots.app.sdk

import cz.alldots.app.core.FailureKind
import cz.alldots.app.presentation.InboxPhase
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
class InboxSDKTest {
    private val dispatcher = StandardTestDispatcher()

    @BeforeTest fun installMain() = Dispatchers.setMain(dispatcher)

    @AfterTest fun removeMain() = Dispatchers.resetMain()

    @Test fun `every call returns a new inbox ViewModel that its caller owns`() = runTest(dispatcher) {
        val sdk = HomeSDK()
        val first = sdk.inbox.inboxViewModel()
        val second = sdk.inbox.inboxViewModel()
        assertNotSame(first, second)
        first.close()
        assertTrue(first.isClosed)
        assertFalse(second.isClosed)
        second.close()
    }

    @Test fun `without a session the inbox ends in the unauthorized failure`() = runTest(dispatcher) {
        val vm = HomeSDK().inbox.inboxViewModel()
        runCurrent()
        assertEquals(InboxPhase.ERROR, vm.state.value.phase)
        assertEquals(FailureKind.UNAUTHORIZED, vm.state.value.failure)
        vm.close()
    }
}
