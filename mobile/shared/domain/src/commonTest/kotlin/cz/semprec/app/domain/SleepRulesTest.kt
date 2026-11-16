package cz.semprec.app.domain

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
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

    @Test fun `a plan can be added only while a day is free`() {
        assertTrue(SleepRules.canAddPlan(listOf(weekdays)))
        assertFalse(SleepRules.canAddPlan(listOf(weekdays, weekend)))
    }

    @Test fun `the last plan cannot be deleted`() {
        assertFalse(SleepRules.canDeletePlan(listOf(weekdays)))
        assertTrue(SleepRules.canDeletePlan(listOf(weekdays, weekend)))
    }

    @Test fun `toggling a day adds or removes it`() {
        assertEquals(setOf(1, 2, 3, 4), SleepRules.toggledDays(weekdays, 5))
        assertEquals(setOf(1, 2, 3, 4, 5, 6), SleepRules.toggledDays(weekdays, 6))
    }

    @Test fun `a new plan takes the free days after the last position`() {
        val plan = assertNotNull(SleepRules.newPlan(listOf(weekdays), "Other days"))
        assertEquals(setOf(6, 7), plan.wakeDays)
        assertEquals(1, plan.position)
        assertEquals("23:00", plan.bed.toString())
        assertEquals("07:00", plan.wake.toString())
        assertTrue(plan.alarm)
        assertNull(SleepRules.newPlan(listOf(weekdays, weekend), "Other days"))
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
