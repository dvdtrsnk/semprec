package cz.semprec.app.sdk

import cz.semprec.app.core.FailureKind
import cz.semprec.app.presentation.DevicesPhase
import cz.semprec.app.presentation.NotificationSettingsPhase
import cz.semprec.app.presentation.ProfilePhase
import cz.semprec.app.presentation.TrashPhase
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
class AccountSDKTest {
    private val dispatcher = StandardTestDispatcher()
    @BeforeTest fun installMain() = Dispatchers.setMain(dispatcher)
    @AfterTest fun removeMain() = Dispatchers.resetMain()

    @Test fun `every call returns a new ViewModel that its caller owns`() = runTest(dispatcher) {
        val sdk = HomeSDK()
        val pairs = listOf(
            sdk.account.profileViewModel() to sdk.account.profileViewModel(),
            sdk.account.devicesViewModel() to sdk.account.devicesViewModel(),
            sdk.account.notificationSettingsViewModel() to sdk.account.notificationSettingsViewModel(),
            sdk.account.aiUsageViewModel { "2026-10-21" } to sdk.account.aiUsageViewModel { "2026-10-21" },
            sdk.account.trashViewModel() to sdk.account.trashViewModel(),
        )
        pairs.forEach { (first, second) ->
            assertNotSame(first, second)
            first.close()
            assertTrue(first.isClosed)
            assertFalse(second.isClosed)
            second.close()
        }
    }

    @Test fun `without a signed in session every screen is unauthorized and the profile has no identity`() =
        runTest(dispatcher) {
            val sdk = HomeSDK()
            val profile = sdk.account.profileViewModel()
            val devices = sdk.account.devicesViewModel()
            val notifications = sdk.account.notificationSettingsViewModel()
            val trash = sdk.account.trashViewModel()
            runCurrent()
            assertNull(profile.state.value.email)
            assertEquals(ProfilePhase.ERROR, profile.state.value.phase)
            assertEquals(FailureKind.UNAUTHORIZED, profile.state.value.failure)
            assertEquals(DevicesPhase.ERROR, devices.state.value.phase)
            assertEquals(NotificationSettingsPhase.ERROR, notifications.state.value.phase)
            assertEquals(TrashPhase.ERROR, trash.state.value.phase)
            listOf(profile, devices, notifications, trash).forEach { it.close() }
        }
}
