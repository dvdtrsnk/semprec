package cz.semprec.app.presentation

import androidx.lifecycle.viewModelScope
import cz.semprec.app.core.DeviceAlarmAuthorization
import cz.semprec.app.domain.DebugAlarmRules
import cz.semprec.app.domain.DebugSchedule
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlin.experimental.ExperimentalObjCRefinement
import kotlin.native.HiddenFromObjC

/** How long from now a test alarm rings. */
@Suppress("MagicNumber") // The seconds are the point of the three delays.
enum class DebugAlarmDelay(internal val seconds: Int) {
    TEN_SECONDS(10),
    ONE_MINUTE(60),
    FIVE_MINUTES(300),
}

/** Whether an alarm at a chosen time rings once or on every one of the next days. */
enum class DebugAlarmRepeat { ONCE, DAILY }

/**
 * [authorization] is what the person decided about alarms; [alarms] are the alarms and missions the app holds, soonest
 * first; [codeCount] is how many codes the wake settings hold for a mission; [dailyDays] is how many days a daily
 * alarm rings; [busy] says that an action has not finished, and [failure] why the last one did not do what was asked.
 */
data class DebugAlarmState(
    val authorization: DeviceAlarmAuthorization,
    val alarms: List<DebugAlarmRow> = emptyList(),
    val codeCount: Int = 0,
    val dailyDays: Int = DebugAlarmRules.DAILY_DAYS,
    val busy: Boolean = false,
    val failure: DebugAlarmFailure? = null,
)

sealed interface DebugAlarmAction {
    /** Reads the alarms the device holds again. */
    data object Refresh : DebugAlarmAction

    /** Asks the person to allow alarms, when never asked. */
    data object RequestAuthorization : DebugAlarmAction

    /** Rings [delay] from now; with [withCodes] as a wake mission that the codes of the wake settings stop. */
    data class RingIn(val delay: DebugAlarmDelay, val withCodes: Boolean) : DebugAlarmAction

    /**
     * Rings at the moment [epochSeconds], or with [DebugAlarmRepeat.DAILY] every day at the time of day it has on the
     * device's clock; with [withCodes] as a wake mission that the codes of the wake settings stop.
     */
    data class RingAt(val epochSeconds: Long, val repeat: DebugAlarmRepeat, val withCodes: Boolean) : DebugAlarmAction

    /** Removes the alarm or mission [id], and stops it when it rings. */
    data class Cancel(val id: String) : DebugAlarmAction

    /** Removes every alarm and mission of the app. */
    data object CancelAll : DebugAlarmAction

    data object DismissFailure : DebugAlarmAction
}

/**
 * The debug alarm tool: the permission, the alarms and missions the device holds, ringing a test alarm and removing
 * one or all of them. It runs over the same device alarms and wake missions as the sleep alarms, so a mission it rings
 * stops only with a scanned code. Actions run one after another in the order they came; the state holds no text.
 * Closing the screen ends what is running; an alarm whose answer did not come is removed by the next sleep alarm sync.
 */
class DebugAlarmViewModel internal constructor(
    private val debug: DebugAlarms,
) : ScreenViewModel<DebugAlarmState, DebugAlarmAction, Nothing>(
    DebugAlarmState(debug.authorization(), codeCount = debug.codes().size),
) {
    private val queue = Mutex()
    private var pending = 0

    init {
        // Whatever changes the missions, the guard ending one among it, reads the alarms again; the first value too.
        debug.changes.onEach { enqueue { refresh(clearsReadFailure = true) } }.launchIn(viewModelScope)
    }

    override fun onAction(action: DebugAlarmAction) {
        if (isClosed) return
        when (action) {
            DebugAlarmAction.Refresh -> enqueue { refresh(clearsReadFailure = true) }
            DebugAlarmAction.RequestAuthorization -> enqueue {
                val decided = debug.requestAuthorization()
                update { it.copy(authorization = decided) }
                refresh(clearsReadFailure = false)
            }
            is DebugAlarmAction.RingIn -> enqueue {
                finish(debug.ring(DebugSchedule.In(action.delay.seconds), action.withCodes))
            }
            is DebugAlarmAction.RingAt -> enqueue {
                finish(debug.ring(schedule(action.epochSeconds, action.repeat), action.withCodes))
            }
            is DebugAlarmAction.Cancel -> enqueue { finish(debug.cancel(action.id)) }
            DebugAlarmAction.CancelAll -> enqueue { finish(debug.cancelAll()) }
            DebugAlarmAction.DismissFailure -> update { it.copy(failure = null) }
        }
    }

    /** Runs [work] after the actions before it, with the state saying that one is running. */
    private fun enqueue(work: suspend () -> Unit) {
        pending += 1
        update { it.copy(busy = true) }
        viewModelScope.launch {
            try {
                queue.withLock { work() }
            } finally {
                pending -= 1
                // Closing ends the work, and nothing changes the state after it.
                if (!isClosed) update { it.copy(busy = pending > 0) }
            }
        }
    }

    /** Shows [failure], or none when the action did what was asked, and reads the alarms the device holds now. */
    private suspend fun finish(failure: DebugAlarmFailure?) {
        update { it.copy(failure = failure) }
        refresh(clearsReadFailure = false)
    }

    /**
     * Reads the alarms the device holds; a read that fails is the failure and keeps the list. A read that works ends a
     * failed read before it, but only where nothing else was asked since, so [clearsReadFailure] is set for a refresh
     * that is the request itself and not for the one that follows another action.
     */
    private suspend fun refresh(clearsReadFailure: Boolean) {
        val rows = debug.rows()
        update {
            val readFailure = it.failure == DebugAlarmFailure.READ_FAILED
            it.copy(
                authorization = debug.authorization(),
                alarms = rows ?: it.alarms,
                codeCount = debug.codes().size,
                failure = when {
                    rows == null -> DebugAlarmFailure.READ_FAILED
                    clearsReadFailure && readFailure -> null
                    else -> it.failure
                },
            )
        }
    }

    private fun schedule(epochSeconds: Long, repeat: DebugAlarmRepeat): DebugSchedule = when (repeat) {
        DebugAlarmRepeat.ONCE -> DebugSchedule.Once(epochSeconds)
        DebugAlarmRepeat.DAILY -> DebugSchedule.Daily(epochSeconds)
    }
}

/**
 * Creates the debug alarm ViewModel, whose constructor is internal, for the SDK in the umbrella module. Hidden from
 * Objective-C and Swift so that the service it takes stays out of the exported native API.
 */
@OptIn(ExperimentalObjCRefinement::class)
@HiddenFromObjC
class DebugAlarmViewModelFactory(private val debug: DebugAlarms) {
    /** One new ViewModel per call; the caller owns it (see [ScreenViewModel]). */
    fun debugAlarmViewModel(): DebugAlarmViewModel = DebugAlarmViewModel(debug)
}
