package cz.alldots.app.presentation

import androidx.lifecycle.viewModelScope
import cz.alldots.app.domain.AccountDevice
import cz.alldots.app.domain.AccountRepository
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch

/**
 * The devices the person is signed in on, with the sign-out of one or of all the others. Signing out always asks
 * first: a confirmation is state, and nothing is revoked until [DevicesAction.Confirm].
 */
class DevicesViewModel internal constructor(
    private val account: AccountRepository,
) : ScreenViewModel<DevicesState, DevicesAction, Nothing>(DevicesState()) {
    private var loadJob: Job? = null

    init {
        load()
    }

    override fun onAction(action: DevicesAction) {
        if (isClosed) return
        when (action) {
            DevicesAction.Retry -> load()
            is DevicesAction.Ask -> ask(action.deviceId)
            DevicesAction.AskOthers -> askOthers()
            DevicesAction.Cancel -> if (!state.value.working) update { it.copy(confirm = null) }
            DevicesAction.Confirm -> confirm()
            DevicesAction.DismissFailure -> update { it.copy(writeFailure = null) }
        }
    }

    private fun askOthers() {
        if (state.value.others.isNotEmpty()) update { it.copy(confirm = DevicesConfirm.Others) }
    }

    private fun ask(deviceId: String) {
        val device = state.value.others.firstOrNull { it.id == deviceId } ?: return
        update { it.copy(confirm = DevicesConfirm.One(device)) }
    }

    private fun load() {
        loadJob?.cancel()
        update { DevicesState() }
        loadJob = viewModelScope.launch {
            val result = answer { account.devices() }
            ensureActive()
            update {
                when (result) {
                    is Answer.Done -> result.value.toState()
                    is Answer.Rejected -> DevicesState(DevicesPhase.ERROR, result.kind)
                }
            }
        }
    }

    private fun confirm() {
        val asked = state.value.confirm
        if (asked == null || state.value.working) return
        update { it.copy(working = true, writeFailure = null) }
        viewModelScope.launch {
            val result = answer {
                when (asked) {
                    is DevicesConfirm.One -> account.revokeDevice(asked.device.id)
                    DevicesConfirm.Others -> account.revokeOtherDevices()
                }
            }
            ensureActive()
            update {
                when (result) {
                    is Answer.Done -> it.copy(working = false, confirm = null, others = it.others.without(asked))
                    is Answer.Rejected ->
                        it.copy(working = false, confirm = null, writeFailure = Failed(result.kind))
                }
            }
        }
    }
}

private fun List<DeviceItem>.without(asked: DevicesConfirm): List<DeviceItem> = when (asked) {
    is DevicesConfirm.One -> filter { it.id != asked.device.id }
    DevicesConfirm.Others -> emptyList()
}

/** This device first, the others as the server lists them; no session of this device leaves `current` null. */
private fun List<AccountDevice>.toState(): DevicesState = DevicesState(
    phase = DevicesPhase.CONTENT,
    current = firstOrNull { it.current }?.toItem(),
    others = filter { !it.current }.map { it.toItem() },
)

private fun AccountDevice.toItem() = DeviceItem(id, kind, platform, name, createdAt, lastSeenAt)
