package cz.alldots.app.presentation

import androidx.lifecycle.viewModelScope
import cz.alldots.app.core.WakeSettings
import cz.alldots.app.domain.WakeCodes
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.launch

/** What the wake settings do to the sleep alarms of this device. */
enum class WakeMode {
    /** An alarm stops with the system's button. */
    OFF,

    /** A code is asked for, but none is stored, so an alarm still stops with the system's button. */
    NEEDS_CODE,

    /** An alarm rings until one of the codes is scanned. */
    ACTIVE,
}

/** Why the wake settings are not what the person asked for. */
enum class WakeSettingsFailure {
    /** The code is empty once its surrounding whitespace is removed. */
    EMPTY_CODE,

    /** The person has not allowed the app to ring alarms. */
    NOT_AUTHORIZED,

    /** The device holds as many alarms as it lets the app hold. */
    LIMIT_REACHED,

    /** The sleep plan could not be read, so the alarms stay as they were. */
    READ_FAILED,

    /** The device could not list, remove or ring an alarm for a reason the app cannot explain. */
    DEVICE_FAILED,
}

data class WakeSettingsState(
    val requiresCode: Boolean = false,
    val codes: List<String> = emptyList(),
    val mode: WakeMode = WakeMode.OFF,
    val failure: WakeSettingsFailure? = null,
)

sealed interface WakeSettingsAction {
    data class SetRequiresCode(val required: Boolean) : WakeSettingsAction
    data class AddCode(val code: String) : WakeSettingsAction
    data class RemoveCode(val code: String) : WakeSettingsAction
    data object DismissFailure : WakeSettingsAction
}

/**
 * The wake settings of this device: whether only a scanned code stops a sleep alarm, and the codes. Every change is
 * kept at once and the sleep alarms are brought in step with it; what the device refused is the state's [failure].
 * Closing the screen while the alarms are being changed ends that run, and the next one picks it up.
 */
class WakeSettingsViewModel internal constructor(
    private val wake: WakeMissions,
    private val sleepAlarms: SleepAlarmSync,
) : ScreenViewModel<WakeSettingsState, WakeSettingsAction, Nothing>(stateOf(wake.settings.value, null)) {
    init {
        wake.settings.onEach { settings -> update { stateOf(settings, it.failure) } }.launchIn(viewModelScope)
    }

    override fun onAction(action: WakeSettingsAction) {
        if (isClosed) return
        when (action) {
            is WakeSettingsAction.SetRequiresCode -> change { it.copy(requiresCode = action.required) }
            is WakeSettingsAction.AddCode -> add(action.code)
            is WakeSettingsAction.RemoveCode -> {
                val code = action.code.trim()
                change { settings -> settings.copy(codes = settings.codes.filter { it != code }) }
            }
            WakeSettingsAction.DismissFailure -> update { it.copy(failure = null) }
        }
    }

    private fun add(code: String) {
        val added = WakeCodes.normalize(listOf(code))
        if (added.isEmpty()) {
            update { it.copy(failure = WakeSettingsFailure.EMPTY_CODE) }
        } else {
            change { it.copy(codes = WakeCodes.normalize(it.codes + added)) }
        }
    }

    private fun change(transform: (WakeSettings) -> WakeSettings) {
        wake.changeSettings(transform)
        update { stateOf(wake.settings.value, null) }
        viewModelScope.launch {
            val failure = sleepAlarms.sync().failure()
            if (failure != null) update { it.copy(failure = failure) }
        }
    }

    private fun SleepAlarmSyncResult.failure(): WakeSettingsFailure? = when (this) {
        SleepAlarmSyncResult.SYNCED, SleepAlarmSyncResult.UNSUPPORTED -> null
        SleepAlarmSyncResult.READ_FAILED -> WakeSettingsFailure.READ_FAILED
        SleepAlarmSyncResult.NOT_AUTHORIZED -> WakeSettingsFailure.NOT_AUTHORIZED
        SleepAlarmSyncResult.LIMIT_REACHED -> WakeSettingsFailure.LIMIT_REACHED
        SleepAlarmSyncResult.DEVICE_FAILED -> WakeSettingsFailure.DEVICE_FAILED
    }
}

private fun stateOf(settings: WakeSettings, failure: WakeSettingsFailure?): WakeSettingsState = WakeSettingsState(
    requiresCode = settings.requiresCode,
    codes = settings.codes,
    mode = when {
        !settings.requiresCode -> WakeMode.OFF
        WakeCodes.active(settings).isEmpty() -> WakeMode.NEEDS_CODE
        else -> WakeMode.ACTIVE
    },
    failure = failure,
)
