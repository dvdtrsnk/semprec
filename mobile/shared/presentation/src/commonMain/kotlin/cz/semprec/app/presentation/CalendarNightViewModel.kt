package cz.semprec.app.presentation

import cz.semprec.app.domain.CalendarChanges
import cz.semprec.app.domain.ClockTime
import cz.semprec.app.domain.EditCalendarEntry
import cz.semprec.app.domain.EditSleepNight
import cz.semprec.app.domain.LoadCalendarWindow
import cz.semprec.app.domain.ScheduleEditing
import cz.semprec.app.domain.SleepNightChange
import cz.semprec.app.domain.SleepRules

/**
 * The nights of sleep on the timeline: a night moved or one of its ends dragged keeps a preview in the state, and the
 * lift writes its times for that night alone through [editSleep]. Without [editSleep] a night is only shown.
 */
abstract class CalendarNightViewModel internal constructor(
    initialDay: String,
    loadWindow: LoadCalendarWindow,
    changes: CalendarChanges,
    edit: EditCalendarEntry,
    private val editSleep: EditSleepNight?,
) : CalendarGestureViewModel(initialDay, loadWindow, changes, edit) {

    /**
     * A night is moved or one of its ends dragged: the times it would have are kept as a preview, snapped to the step
     * of the calendar. A night is never shorter than an hour nor longer than [MAX_NIGHT_MINUTES].
     */
    internal fun sleepDrag(action: CalendarAction.Gesture.SleepDrag) {
        val night = entryOf(SLEEP_ID_PREFIX + action.night)?.sleep
        val committing = state.value.sleepDrag?.committing == true
        if (night == null || editSleep == null || committing) return
        val bed = night.bedTime.minutes
        val wake = night.wakeTime.minutes
        val (newBed, newWake) = when (action.edge) {
            null -> snapped(bed + action.deltaMinutes) to snapped(wake + action.deltaMinutes)
            CalendarEdge.START -> snapped(bed + action.deltaMinutes) to wake
            CalendarEdge.END -> bed to snapped(wake + action.deltaMinutes)
        }
        val duration = SleepRules.durationMinutes(ClockTime(newBed), ClockTime(newWake))
        if (duration < MIN_NIGHT_MINUTES || duration > MAX_NIGHT_MINUTES) return
        update {
            it.copy(
                sleepDrag = CalendarSleepDrag(action.night, newBed, newWake, committing = false),
                selectedItemId = null,
            )
        }
    }

    /** The finger lifted from a night: its new times are written for this night alone, or the preview dropped. */
    internal fun endSleepDrag(commit: Boolean) {
        val drag = state.value.sleepDrag ?: return
        if (drag.committing) return
        val night = entryOf(SLEEP_ID_PREFIX + drag.night)?.sleep
        val editor = editSleep
        val moved = night?.takeIf { it.bedTime.minutes != drag.bedMinutes || it.wakeTime.minutes != drag.wakeMinutes }
        if (!commit || moved == null || editor == null) {
            update { it.copy(sleepDrag = null) }
        } else {
            update { it.copy(sleepDrag = drag.copy(committing = true)) }
            val change = SleepNightChange(bed = ClockTime(drag.bedMinutes), wake = ClockTime(drag.wakeMinutes))
            write { editor(moved.night, change) }
        }
    }

    private fun snapped(minutes: Int): Int =
        (ScheduleEditing.snap(minutes.mod(ClockTime.DAY_MINUTES)) % ClockTime.DAY_MINUTES)
}

/** The id the server gives the night that starts on an evening, `sleep:<night>`. */
private const val SLEEP_ID_PREFIX = "sleep:"

/** The shortest night a drag leaves. */
private const val MIN_NIGHT_MINUTES = 60

/** The longest night a drag leaves. */
private const val MAX_NIGHT_MINUTES = 16 * 60
