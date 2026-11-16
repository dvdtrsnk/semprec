package cz.semprec.app.presentation

import cz.semprec.app.core.AccountDeviceKind
import cz.semprec.app.core.AccountPlatform
import cz.semprec.app.core.FailureKind

enum class DevicesPhase { LOADING, CONTENT, ERROR }

/** One signed-in device; [createdAt] and [lastSeenAt] are the server's instants (ISO 8601). */
data class DeviceItem(
    val id: String,
    val kind: AccountDeviceKind,
    val platform: AccountPlatform,
    val name: String?,
    val createdAt: String,
    val lastSeenAt: String,
)

/** What the person is asked to confirm before a device is signed out. */
sealed interface DevicesConfirm {
    data class One(val device: DeviceItem) : DevicesConfirm
    data object Others : DevicesConfirm
}

/**
 * The signed-in devices: [current] is this one, [others] can be signed out. [working] is true while a sign-out runs;
 * [writeFailure] is the last one that failed.
 */
data class DevicesState(
    val phase: DevicesPhase = DevicesPhase.LOADING,
    val failure: FailureKind? = null,
    val current: DeviceItem? = null,
    val others: List<DeviceItem> = emptyList(),
    val confirm: DevicesConfirm? = null,
    val working: Boolean = false,
    val writeFailure: Failed? = null,
)
