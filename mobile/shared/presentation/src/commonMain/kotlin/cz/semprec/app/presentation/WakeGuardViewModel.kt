package cz.semprec.app.presentation

import androidx.lifecycle.viewModelScope
import cz.semprec.app.core.WakeMission
import cz.semprec.app.domain.WakeCodes
import cz.semprec.app.domain.WakeMissionRules
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import kotlinx.datetime.Clock
import kotlinx.datetime.Instant

/** What the guard covers the window with. */
enum class WakeGuardPhase {
    /** No mission rings: the window shows its app. */
    IDLE,

    /** The camera waits for one of the mission's codes. */
    SCANNING,

    /** The person taps instead of scanning. */
    TAPPING,
}

/** Which kind of alarm rings, which the app words its title from. */
enum class WakeTitleKind { SLEEP_ALARM }

/**
 * [fallbackOpensAtEpochSeconds] is when the person may tap instead of scanning, [fallbackOpen] says it may now;
 * [requiredTaps] and [fallbackDelayMinutes] are the rules' numbers, so that the app's copy takes them from here.
 */
data class WakeGuardState(
    val phase: WakeGuardPhase = WakeGuardPhase.IDLE,
    val tapsLeft: Int = WakeMissionRules.REQUIRED_TAPS,
    val requiredTaps: Int = WakeMissionRules.REQUIRED_TAPS,
    val fallbackDelayMinutes: Int = WakeMissionRules.TAP_FALLBACK_DELAY.inWholeMinutes.toInt(),
    val fallbackOpensAtEpochSeconds: Long? = null,
    val fallbackOpen: Boolean = false,
    val codeCount: Int = 0,
    val titleKind: WakeTitleKind = WakeTitleKind.SLEEP_ALARM,
)

sealed interface WakeGuardAction {
    /** The camera read [code]. */
    data class CodeScanned(val code: String) : WakeGuardAction

    /** One tap of the tap fallback. */
    data object Tap : WakeGuardAction

    /** The person chose the tap fallback; it opens ten minutes after the ring. */
    data object OpenTapFallback : WakeGuardAction

    data object BackToScanning : WakeGuardAction
}

sealed interface WakeGuardEffect {
    /** The code read is none of the mission's. */
    data object CodeRejected : WakeGuardEffect

    /** The mission ended: a code or the last tap stopped it. */
    data object Finished : WakeGuardEffect
}

/**
 * The guard of one window: it shows while a wake mission rings and ends the mission when one of its codes is scanned
 * or, once the fallback has opened ten minutes after the ring, the required taps are made. It waits with a single
 * delay to the next ring or to the opening of the fallback, and starts again whenever the missions change. The
 * state holds no text.
 */
class WakeGuardViewModel internal constructor(
    private val wake: WakeMissions,
    private val now: () -> Instant = { Clock.System.now() },
) : ScreenViewModel<WakeGuardState, WakeGuardAction, WakeGuardEffect>(WakeGuardState()) {
    private var ringing: WakeMission? = null
    private var finishing = false

    init {
        viewModelScope.launch { wake.missions.collectLatest { watch(it) } }
    }

    override fun onAction(action: WakeGuardAction) {
        if (isClosed) return
        when (action) {
            is WakeGuardAction.CodeScanned -> scanned(action.code)
            WakeGuardAction.Tap -> tap()
            WakeGuardAction.OpenTapFallback ->
                if (state.value.fallbackOpen) moveTo(WakeGuardPhase.SCANNING, WakeGuardPhase.TAPPING)
            WakeGuardAction.BackToScanning -> moveTo(WakeGuardPhase.TAPPING, WakeGuardPhase.SCANNING)
        }
    }

    /** Follows [missions] in time: shows the one that rings, and waits for the next ring or the fallback. */
    private suspend fun watch(missions: List<WakeMission>) {
        while (true) {
            val at = now()
            val mission = WakeMissionRules.ringing(missions, at)
            if (mission == null) {
                ringing = null
                finishing = false
                update { WakeGuardState() }
                val next = WakeMissionRules.nextRing(missions, at) ?: return
                delay(next - at)
                continue
            }
            show(mission, at)
            val opensAt = WakeMissionRules.tapFallbackOpensAt(mission)
            if (opensAt <= at) {
                update { it.copy(fallbackOpen = true) }
                return
            }
            delay(opensAt - at)
        }
    }

    private fun show(mission: WakeMission, at: Instant) {
        if (ringing?.key != mission.key || state.value.phase == WakeGuardPhase.IDLE) {
            finishing = false
            update {
                WakeGuardState(
                    phase = WakeGuardPhase.SCANNING,
                    fallbackOpensAtEpochSeconds = WakeMissionRules.tapFallbackOpensAt(mission).epochSeconds,
                    fallbackOpen = WakeMissionRules.tapFallbackOpensAt(mission) <= at,
                    codeCount = mission.codes.size,
                )
            }
        }
        ringing = mission
    }

    private fun scanned(code: String) {
        val mission = ringing ?: return
        if (finishing) return
        if (WakeCodes.accepts(mission.codes, code)) finish(mission) else emit(WakeGuardEffect.CodeRejected)
    }

    private fun tap() {
        val mission = ringing ?: return
        if (state.value.phase != WakeGuardPhase.TAPPING || finishing) return
        val left = state.value.tapsLeft - 1
        update { it.copy(tapsLeft = left) }
        if (left <= 0) finish(mission)
    }

    private fun moveTo(from: WakeGuardPhase, to: WakeGuardPhase) {
        if (state.value.phase == from) update { it.copy(phase = to) }
    }

    private fun finish(mission: WakeMission) {
        finishing = true
        viewModelScope.launch {
            wake.finish(mission.key)
            emit(WakeGuardEffect.Finished)
        }
    }
}
