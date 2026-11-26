package cz.semprec.app.domain

import kotlinx.datetime.Instant
import kotlinx.datetime.TimeZone
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

private val DEBUG_ZONE = TimeZone.of("Europe/Prague")

/** Two in the afternoon in Prague (CEST), two days before the clocks go back. */
private val DEBUG_NOW = Instant.parse("2026-10-23T12:00:00Z")

private fun instants(vararg values: String) = values.map(Instant::parse)

class DebugAlarmRulesTest {
    @Test fun `a delay rings once that many seconds from now`() {
        val cases = mapOf(10 to "2026-10-23T12:00:10Z", 60 to "2026-10-23T12:01:00Z", 300 to "2026-10-23T12:05:00Z")
        for ((seconds, ring) in cases) {
            assertEquals(instants(ring), DebugAlarmRules.rings(DebugSchedule.In(seconds), DEBUG_NOW, DEBUG_ZONE))
        }
    }

    @Test fun `a delay of nothing or less has no ring left`() {
        for (seconds in listOf(0, -5)) {
            assertEquals(emptyList(), DebugAlarmRules.rings(DebugSchedule.In(seconds), DEBUG_NOW, DEBUG_ZONE))
        }
    }

    @Test fun `a moment rings once when it is ahead and never when it has passed or is now`() {
        val ahead = Instant.parse("2026-10-23T12:00:01Z")
        assertEquals(listOf(ahead), DebugAlarmRules.rings(DebugSchedule.Once(ahead), DEBUG_NOW, DEBUG_ZONE))
        for (moment in listOf(DEBUG_NOW, Instant.parse("2026-10-23T11:59:59Z"))) {
            assertEquals(emptyList(), DebugAlarmRules.rings(DebugSchedule.Once(moment), DEBUG_NOW, DEBUG_ZONE))
        }
    }

    @Test fun `a daily alarm rings on each of the next days at the wall clock time over the change of the clocks`() {
        // 07:30 in Prague: 05:30 UTC while the clocks are on summer time, 06:30 UTC after they go back on 25 October.
        val picked = Instant.parse("2026-10-23T05:30:00Z")

        val rings = DebugAlarmRules.rings(DebugSchedule.Daily(picked), DEBUG_NOW, DEBUG_ZONE)

        assertEquals(
            instants(
                "2026-10-24T05:30:00Z",
                "2026-10-25T06:30:00Z",
                "2026-10-26T06:30:00Z",
                "2026-10-27T06:30:00Z",
                "2026-10-28T06:30:00Z",
                "2026-10-29T06:30:00Z",
            ),
            rings,
            "today's 07:30 has passed, and the days after it follow to the sixth",
        )
    }

    @Test fun `a daily alarm that is still ahead today rings today first and then on the next days`() {
        val picked = Instant.parse("2026-10-20T16:00:00Z")

        val rings = DebugAlarmRules.rings(DebugSchedule.Daily(picked), DEBUG_NOW, DEBUG_ZONE)

        assertEquals(DebugAlarmRules.DAILY_DAYS, rings.size)
        assertEquals(Instant.parse("2026-10-23T16:00:00Z"), rings.first())
        assertEquals(Instant.parse("2026-10-29T17:00:00Z"), rings.last())
    }

    @Test fun `a key says whether it is a debug alarm's and when it rings`() {
        val key = DebugAlarmRules.key(Instant.parse("2026-10-23T12:00:10Z"), "d1")

        assertTrue(DebugAlarmRules.isDebugKey(key))
        assertEquals(Instant.parse("2026-10-23T12:00:10Z"), DebugAlarmRules.ringAt(key))
        assertFalse(DebugAlarmRules.isDebugKey("sleep:2026-10-23T12:00:10Z"))
        assertNull(DebugAlarmRules.ringAt("sleep:2026-10-23T12:00:10Z"))
        assertNull(DebugAlarmRules.ringAt("debug:soon:d1"))
    }

    @Test fun `no key of the sleep plan is a key of a debug alarm and the other way round`() {
        assertFalse(PlanSleepAlarms.isSleepKey(DebugAlarmRules.key(DEBUG_NOW, "d1")))
    }
}
