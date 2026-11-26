package cz.semprec.app.domain

import cz.semprec.app.core.WakeMission
import cz.semprec.app.core.WakeSettings
import kotlinx.datetime.Instant
import kotlin.time.Duration
import kotlin.time.Duration.Companion.hours
import kotlin.time.Duration.Companion.minutes

/** The codes that stop a sleep alarm: which are kept and which one a scan counts as. */
object WakeCodes {
    /** The codes without surrounding whitespace, blanks and repeats, in their order. */
    fun normalize(codes: List<String>): List<String> =
        codes.map { it.trim() }.filter { it.isNotEmpty() }.distinct()

    /** Whether [scanned], without surrounding whitespace, is one of [codes]. */
    fun accepts(codes: List<String>, scanned: String): Boolean {
        val code = scanned.trim()
        return code.isNotEmpty() && code in codes
    }

    /** The codes that stop an alarm: none while the settings do not ask for a code. */
    fun active(settings: WakeSettings): List<String> =
        if (settings.requiresCode) normalize(settings.codes) else emptyList()

    /** Whether two lists name the same codes, whatever their order. */
    fun sameCodes(first: List<String>, second: List<String>): Boolean = first.toSet() == second.toSet()
}

/** When a wake mission rings, what keeps it ringing and when the person may tap instead of scanning. */
object WakeMissionRules {
    /**
     * The minutes after a ring at which a watch alarm rings: every minute for half an hour, then every five minutes
     * up to two hours. They are on the device's timers before the person sleeps, because once the alarm rings the
     * app may never run again until the person opens it.
     */
    val watchOffsets: List<Int> = (1..30).toList() + (35..120 step 5).toList()

    /** How far ahead a ring is guarded: its watch alarms are scheduled once it is this close. */
    val ARM_HORIZON: Duration = 36.hours

    /** How long a mission rings before the person may tap instead of scanning. */
    val TAP_FALLBACK_DELAY: Duration = 10.minutes

    /** How many taps stop the mission once the tap fallback is open. */
    const val REQUIRED_TAPS: Int = 200

    fun ringAt(mission: WakeMission): Instant = Instant.fromEpochSeconds(mission.ringAtEpochSeconds)

    /** The instants the watch alarms of [mission] ring at. */
    fun watchRings(mission: WakeMission): List<Instant> =
        watchOffsets.map { ringAt(mission) + it.minutes }

    /** Whether [mission] has no watch alarms yet and its ring is close enough to guard. */
    fun needsWatches(mission: WakeMission, now: Instant): Boolean {
        val ring = ringAt(mission)
        return !mission.armed && ring > now && ring - now <= ARM_HORIZON
    }

    /** The mission that rings at [now]: the one whose ring came first. It rings until a code or the taps stop it. */
    fun ringing(missions: List<WakeMission>, now: Instant): WakeMission? =
        missions.filter { ringAt(it) <= now }.minByOrNull { it.ringAtEpochSeconds }

    /** The first ring after [now], or `null` when none is waiting. */
    fun nextRing(missions: List<WakeMission>, now: Instant): Instant? =
        missions.map(::ringAt).filter { it > now }.minOrNull()

    /** When the person may tap instead of scanning [mission]. */
    fun tapFallbackOpensAt(mission: WakeMission): Instant = ringAt(mission) + TAP_FALLBACK_DELAY
}
