package cz.semprec.app.domain

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

private fun times(bed: String, wake: String) = SleepTimes(time(bed).minutes, time(wake).minutes)

private class Move(val name: String, val from: SleepTimes, val to: Int, val expected: SleepTimes)

class SleepDialTest {
    private val weekdays = samplePlan("a", setOf(1, 2, 3, 4, 5))
    private val weekend = samplePlan("b", setOf(6, 7), position = 1, bed = "00:00", wake = "08:30", alarm = false)

    @Test fun `a time snaps to the nearest five minutes and wraps around the day`() {
        listOf(
            0 to 0, 2 to 0, 3 to 5, 1437 to 1435, 1438 to 0, 1440 to 0, 1441 to 0, 1500 to 60, -2 to 0, -3 to 1435,
            -30 to 1410, 2 * 1440 + 62 to 60,
        ).forEach { (minutes, snapped) ->
            assertEquals(snapped, SleepDial.snap(minutes), "$minutes minutes")
            assertEquals(0, SleepDial.snap(minutes) % SleepDial.STEP_MINUTES)
        }
    }

    @Test fun `moving the bedtime keeps the wake time while the length stays in range`() {
        listOf(
            Move("earlier", times("23:00", "07:00"), time("22:30").minutes, times("22:30", "07:00")),
            Move("later over midnight", times("23:00", "07:00"), time("02:00").minutes, times("02:00", "07:00")),
            Move("snapped", times("23:00", "07:00"), time("22:32").minutes, times("22:30", "07:00")),
            Move("snapped up", times("23:00", "07:00"), time("22:33").minutes, times("22:35", "07:00")),
            Move("minutes past a day", times("23:00", "07:00"), 25 * 60, times("01:00", "07:00")),
            Move("negative minutes", times("23:00", "07:00"), -30, times("23:30", "07:00")),
        ).forEach { case ->
            assertEquals(case.expected, SleepDial.moveBed(case.from, case.to), case.name)
        }
    }

    @Test fun `moving the bedtime past the longest or shortest night pushes the wake time`() {
        listOf(
            Move("too long", times("23:00", "07:00"), time("17:00").minutes, times("17:00", "05:00")),
            Move("into minus shifts the whole snake", times("06:00", "07:00"), time("06:30").minutes, times("06:30", "07:30")),
            Move("far past the wake time", times("06:00", "07:00"), time("10:00").minutes, times("10:00", "11:00")),
            Move("noon needs a night through midnight", times("11:30", "12:30"), time("12:00").minutes, times("12:00", "00:00")),
            Move("the evening before midnight", times("22:00", "02:00"), time("23:30").minutes, times("23:30", "02:00")),
        ).forEach { case ->
            assertEquals(case.expected, SleepDial.moveBed(case.from, case.to), case.name)
        }
    }

    @Test fun `moving the wake time keeps the bedtime while the length stays in range`() {
        listOf(
            Move("later", times("23:00", "07:00"), time("08:00").minutes, times("23:00", "08:00")),
            Move("earlier", times("23:00", "07:00"), time("05:55").minutes, times("23:00", "05:55")),
            Move("snapped", times("23:00", "07:00"), time("08:02").minutes, times("23:00", "08:00")),
            Move("to the shortest night", times("23:00", "07:00"), time("00:00").minutes, times("23:00", "00:00")),
        ).forEach { case ->
            assertEquals(case.expected, SleepDial.moveWake(case.from, case.to), case.name)
        }
    }

    @Test fun `moving the wake time past the longest or shortest night pushes the bedtime`() {
        listOf(
            Move("too long", times("23:00", "07:00"), time("12:00").minutes, times("00:00", "12:00")),
            Move("into minus shifts the whole snake", times("06:00", "07:00"), time("06:30").minutes, times("05:30", "06:30")),
            Move("a night that cannot end before midnight", times("23:00", "00:30"), time("23:30").minutes, times("23:00", "00:00")),
            Move("further round the clock", times("23:00", "07:00"), time("23:30").minutes, times("23:00", "00:00")),
        ).forEach { case ->
            assertEquals(case.expected, SleepDial.moveWake(case.from, case.to), case.name)
        }
    }

    @Test fun `moving the whole night keeps its length`() {
        listOf(
            Move("earlier", times("23:00", "07:00"), time("22:00").minutes, times("22:00", "06:00")),
            Move("over midnight", times("23:00", "07:00"), time("01:00").minutes, times("01:00", "09:00")),
            Move("snapped", times("23:00", "07:00"), time("22:33").minutes, times("22:35", "06:35")),
            Move("a short night stretches to reach midnight", times("06:00", "07:00"), time("20:00").minutes, times("20:00", "00:00")),
        ).forEach { case ->
            assertEquals(case.expected, SleepDial.moveWhole(case.from, case.to), case.name)
        }
    }

    @Test fun `times that break the length rules are fitted keeping the bedtime`() {
        assertEquals(times("08:00", "20:00"), SleepDial.fit(times("08:00", "07:00")))
        assertEquals(times("06:00", "07:00"), SleepDial.fit(times("06:00", "06:00")))
        assertEquals(times("23:00", "06:47"), SleepDial.fit(times("23:00", "06:47")))
        assertEquals(times("00:00", "08:30"), SleepDial.draftOf(weekend).times)
    }

    @Test fun `whatever moves the night keeps it as long as the rules allow and agrees with the server's count`() {
        val starts = (0 until ClockTime.DAY_MINUTES step 15).flatMap { bed ->
            (SleepRules.SHORTEST_NIGHT_MINUTES..SleepRules.LONGEST_NIGHT_MINUTES step 60).map { length ->
                SleepDial.fit(SleepTimes(bed, (bed + length) % ClockTime.DAY_MINUTES))
            }
        }
        for (start in starts) {
            for (target in 0 until ClockTime.DAY_MINUTES step SleepDial.STEP_MINUTES) {
                listOf(
                    "bed" to SleepDial.moveBed(start, target),
                    "wake" to SleepDial.moveWake(start, target),
                    "whole" to SleepDial.moveWhole(start, target),
                ).forEach { (handle, moved) ->
                    val message = "$handle of $start to $target gave $moved"
                    assertTrue(SleepRules.isNightLength(moved.durationMinutes), message)
                    assertTrue(moved.bedMinutes in 0 until ClockTime.DAY_MINUTES, message)
                    assertTrue(moved.wakeMinutes in 0 until ClockTime.DAY_MINUTES, message)
                    assertTrue(moved.toClockTimes() != null, message)
                }
            }
        }
    }

    @Test fun `a new plan takes the free days at the times of the first plan with the alarm off`() {
        val draft = SleepDial.newPlanDraft(listOf(weekdays))
        assertEquals(setOf(6, 7), draft.wakeDays)
        assertEquals(times("23:00", "06:45"), draft.times)
        assertFalse(draft.alarm)
        assertTrue(draft.isComplete)
    }

    @Test fun `a new plan without plans starts from the base night on every day`() {
        val draft = SleepDial.newPlanDraft(emptyList())
        assertEquals(SleepRules.WEEK.toSet(), draft.wakeDays)
        assertEquals(times("23:00", "07:00"), draft.times)
    }

    @Test fun `a new plan has no day when every day belongs to a plan and is not complete`() {
        val draft = SleepDial.newPlanDraft(listOf(weekdays, weekend))
        assertTrue(draft.wakeDays.isEmpty())
        assertFalse(draft.isComplete)
        assertTrue(draft.hasNightLength)
        assertEquals(draft.copy(wakeDays = setOf(1)).isComplete, true)
    }

    @Test fun `a night starts from the night, else the first plan, else the base night`() {
        val night = SleepNight(CalendarDay(2026, 10, 16), "a", "Plan a", time("22:00"), time("06:00"), false, true, 480)
        assertEquals(SleepScheduleDraft(emptySet(), times("22:00", "06:00"), false), SleepDial.nightDraft(night, listOf(weekdays)))
        assertEquals(SleepScheduleDraft(emptySet(), times("23:00", "06:45"), true), SleepDial.nightDraft(null, listOf(weekdays)))
        assertEquals(SleepScheduleDraft(emptySet(), times("23:00", "07:00"), false), SleepDial.nightDraft(null, emptyList()))
    }

    @Test fun `switching a day adds or removes it and refuses what is no weekday`() {
        val draft = SleepDial.draftOf(weekdays)
        assertEquals(setOf(1, 2, 3, 4), draft.withDayToggled(5)?.wakeDays)
        assertEquals(setOf(1, 2, 3, 4, 5, 6), draft.withDayToggled(6)?.wakeDays)
        assertNull(draft.withDayToggled(0))
        assertNull(draft.withDayToggled(8))
    }
}
