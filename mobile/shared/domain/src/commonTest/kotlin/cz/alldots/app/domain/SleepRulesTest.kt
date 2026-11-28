package cz.alldots.app.domain

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class SleepRulesTest {
    private val weekdays = samplePlan("a", setOf(1, 2, 3, 4, 5), position = 0)
    private val weekend = samplePlan("b", setOf(6, 7), position = 1, bed = "00:00", wake = "08:30", alarm = false)

    @Test fun `a night from the evening runs through midnight`() {
        assertEquals(465, SleepRules.durationMinutes(time("23:00"), time("06:45")))
    }

    @Test fun `a bedtime after midnight is counted to the same morning`() {
        assertEquals(510, SleepRules.durationMinutes(time("00:00"), time("08:30")))
        assertEquals(0, SleepRules.durationMinutes(time("08:00"), time("07:00")))
    }

    @Test fun `the goal difference is signed`() {
        assertEquals(-15, SleepRules.goalDifference(465, 480))
        assertEquals(30, SleepRules.goalDifference(510, 480))
        assertEquals(0, SleepRules.goalDifference(480, 480))
    }

    @Test fun `the reminder time wraps around midnight`() {
        assertEquals("22:30", SleepRules.reminderTime(time("23:00"), 30).toString())
        assertEquals("23:30", SleepRules.reminderTime(time("00:15"), 45).toString())
    }

    @Test fun `free days are the weekdays no plan holds`() {
        assertEquals(emptySet(), SleepRules.freeDays(listOf(weekdays, weekend)))
        assertEquals(setOf(6, 7), SleepRules.freeDays(listOf(weekdays)))
        assertEquals(SleepRules.WEEK.toSet(), SleepRules.freeDays(emptyList()))
    }

    @Test fun `the last plan cannot be deleted`() {
        assertFalse(SleepRules.canDeletePlan(listOf(weekdays)))
        assertTrue(SleepRules.canDeletePlan(listOf(weekdays, weekend)))
    }

    @Test fun `the days of other plans are those no edited plan holds`() {
        assertEquals(setOf(6, 7), SleepDrafts.daysOfOtherPlans(listOf(weekdays, weekend), "a"))
        assertEquals(setOf(1, 2, 3, 4, 5), SleepDrafts.daysOfOtherPlans(listOf(weekdays, weekend), "b"))
        assertEquals(setOf(1, 2, 3, 4, 5, 6, 7), SleepDrafts.daysOfOtherPlans(listOf(weekdays, weekend), null))
    }

    @Test fun `the length of a night has one definition for minutes and for clock times`() {
        for (bed in 0 until ClockTime.DAY_MINUTES step 35) {
            for (wake in 0 until ClockTime.DAY_MINUTES step 35) {
                assertEquals(
                    SleepRules.durationMinutes(ClockTime(bed), ClockTime(wake)),
                    SleepRules.durationMinutes(bed, wake),
                )
            }
        }
    }

    @Test fun `a night is from one hour to twelve hours long`() {
        listOf(0 to false, 59 to false, 60 to true, 465 to true, 720 to true, 721 to false).forEach { (minutes, ok) ->
            assertEquals(ok, SleepDial.isNightLength(minutes), "$minutes minutes")
        }
    }

    @Test fun `a night starts the evening before from a bedtime at noon on`() {
        assertFalse(SleepRules.startsTheEveningBefore(time("11:59")))
        assertTrue(SleepRules.startsTheEveningBefore(time("12:00")))
        assertTrue(SleepRules.startsTheEveningBefore(time("23:00")))
    }

    @Test fun `a night meets the goal at the goal and above`() {
        assertFalse(SleepRules.meetsGoal(465, 480))
        assertTrue(SleepRules.meetsGoal(480, 480))
        assertTrue(SleepRules.meetsGoal(510, 480))
    }

    @Test fun `plans are ordered by position and then id`() {
        val first = samplePlan("z", setOf(1), position = 0)
        val second = samplePlan("a", setOf(2), position = 1)
        val third = samplePlan("b", setOf(3), position = 1)
        assertEquals(listOf(first, second, third), SleepRules.ordered(listOf(third, first, second)))
    }

    @Test fun `end of day is not a sleep time`() {
        assertFalse(SleepRules.isSleepTime(time("24:00")))
        assertTrue(SleepRules.isSleepTime(time("23:59")))
    }
}
