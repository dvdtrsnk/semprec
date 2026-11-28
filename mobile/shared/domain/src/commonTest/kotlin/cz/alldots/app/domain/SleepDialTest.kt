package cz.alldots.app.domain

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

private fun times(bed: String, wake: String) = SleepTimes(time(bed).minutes, time(wake).minutes)

private class Move(val name: String, from: Pair<String, String>, val to: Int, expected: Pair<String, String>) {
    constructor(name: String, from: Pair<String, String>, to: String, expected: Pair<String, String>) :
        this(name, from, time(to).minutes, expected)

    val start = times(from.first, from.second)
    val expected = times(expected.first, expected.second)
}

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
            Move("earlier", "23:00" to "07:00", "22:30", "22:30" to "07:00"),
            Move("later over midnight", "23:00" to "07:00", "02:00", "02:00" to "07:00"),
            Move("snapped", "23:00" to "07:00", "22:32", "22:30" to "07:00"),
            Move("snapped up", "23:00" to "07:00", "22:33", "22:35" to "07:00"),
            Move("minutes past a day", "23:00" to "07:00", 25 * 60, "01:00" to "07:00"),
            Move("negative minutes", "23:00" to "07:00", -30, "23:30" to "07:00"),
        ).forEach { case ->
            assertEquals(case.expected, SleepDial.moveBed(case.start, case.to), case.name)
        }
    }

    @Test fun `moving the bedtime past the longest or shortest night pushes the wake time`() {
        listOf(
            Move("too long", "23:00" to "07:00", "17:00", "17:00" to "05:00"),
            Move("into minus shifts the whole snake", "06:00" to "07:00", "06:30", "06:30" to "07:30"),
            Move("far past the wake time", "06:00" to "07:00", "10:00", "10:00" to "11:00"),
            Move("noon needs a night through midnight", "11:30" to "12:30", "12:00", "12:00" to "00:00"),
            Move("the evening before midnight", "22:00" to "02:00", "23:30", "23:30" to "02:00"),
        ).forEach { case ->
            assertEquals(case.expected, SleepDial.moveBed(case.start, case.to), case.name)
        }
    }

    @Test fun `moving the wake time keeps the bedtime while the length stays in range`() {
        listOf(
            Move("later", "23:00" to "07:00", "08:00", "23:00" to "08:00"),
            Move("earlier", "23:00" to "07:00", "05:55", "23:00" to "05:55"),
            Move("snapped", "23:00" to "07:00", "08:02", "23:00" to "08:00"),
            Move("to the shortest night", "23:00" to "07:00", "00:00", "23:00" to "00:00"),
        ).forEach { case ->
            assertEquals(case.expected, SleepDial.moveWake(case.start, case.to), case.name)
        }
    }

    @Test fun `moving the wake time past the longest or shortest night pushes the bedtime`() {
        listOf(
            Move("too long", "23:00" to "07:00", "12:00", "00:00" to "12:00"),
            Move("into minus shifts the whole snake", "06:00" to "07:00", "06:30", "05:30" to "06:30"),
            Move("a night that cannot end before midnight", "23:00" to "00:30", "23:30", "23:00" to "00:00"),
            Move("further round the clock", "23:00" to "07:00", "23:30", "23:00" to "00:00"),
        ).forEach { case ->
            assertEquals(case.expected, SleepDial.moveWake(case.start, case.to), case.name)
        }
    }

    @Test fun `moving the whole night keeps its length`() {
        listOf(
            Move("earlier", "23:00" to "07:00", "22:00", "22:00" to "06:00"),
            Move("over midnight", "23:00" to "07:00", "01:00", "01:00" to "09:00"),
            Move("snapped", "23:00" to "07:00", "22:33", "22:35" to "06:35"),
            Move("a short night stretches to reach midnight", "06:00" to "07:00", "20:00", "20:00" to "00:00"),
        ).forEach { case ->
            assertEquals(case.expected, SleepDial.moveWhole(case.start, case.to), case.name)
        }
    }

    @Test fun `times that break the length rules are fitted keeping the bedtime`() {
        assertEquals(times("08:00", "20:00"), SleepDial.fit(times("08:00", "07:00")))
        assertEquals(times("06:00", "07:00"), SleepDial.fit(times("06:00", "06:00")))
        assertEquals(times("23:00", "06:47"), SleepDial.fit(times("23:00", "06:47")))
        assertEquals(times("00:00", "08:30"), SleepDrafts.ofPlan(weekend).times)
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
                    assertTrue(SleepDial.isNightLength(moved.durationMinutes), message)
                    assertTrue(moved.bedMinutes in 0 until ClockTime.DAY_MINUTES, message)
                    assertTrue(moved.wakeMinutes in 0 until ClockTime.DAY_MINUTES, message)
                    assertTrue(moved.toClockTimes() != null, message)
                }
            }
        }
    }

    @Test fun `a new plan takes the free days at the times of the first plan with the alarm off`() {
        val draft = SleepDrafts.newPlan(listOf(weekdays))
        assertEquals(setOf(6, 7), draft.wakeDays)
        assertEquals(times("23:00", "06:45"), draft.times)
        assertFalse(draft.alarm)
        assertTrue(draft.isComplete)
    }

    @Test fun `a new plan without plans starts from the base night on every day`() {
        val draft = SleepDrafts.newPlan(emptyList())
        assertEquals(SleepRules.WEEK.toSet(), draft.wakeDays)
        assertEquals(times("23:00", "07:00"), draft.times)
    }

    @Test fun `a new plan has no day when every day belongs to a plan and is not complete`() {
        val draft = SleepDrafts.newPlan(listOf(weekdays, weekend))
        assertTrue(draft.wakeDays.isEmpty())
        assertFalse(draft.isComplete)
        assertTrue(draft.hasNightLength)
        assertEquals(draft.copy(wakeDays = setOf(1)).isComplete, true)
    }

    @Test fun `a night starts from the night or else the first plan or else the base night`() {
        val night = SleepNight(CalendarDay(2026, 10, 16), "a", "Plan a", time("22:00"), time("06:00"), false, true, 480)
        val fromNight = SleepScheduleDraft(emptySet(), times("22:00", "06:00"), false)
        assertEquals(fromNight, SleepDrafts.ofNight(night, listOf(weekdays)))
        val fromPlan = SleepScheduleDraft(emptySet(), times("23:00", "06:45"), true)
        assertEquals(fromPlan, SleepDrafts.ofNight(null, listOf(weekdays)))
        val base = SleepScheduleDraft(emptySet(), times("23:00", "07:00"), false)
        assertEquals(base, SleepDrafts.ofNight(null, emptyList()))
    }

    @Test fun `switching a day adds or removes it and refuses what is no weekday`() {
        val draft = SleepDrafts.ofPlan(weekdays)
        assertEquals(setOf(1, 2, 3, 4), draft.withDayToggled(5)?.wakeDays)
        assertEquals(setOf(1, 2, 3, 4, 5, 6), draft.withDayToggled(6)?.wakeDays)
        assertNull(draft.withDayToggled(0))
        assertNull(draft.withDayToggled(8))
    }
}
