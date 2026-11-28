package cz.alldots.app.domain

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ClockTimeTest {
    @Test fun `a time round trips with two digit parts`() {
        assertEquals("06:45", ClockTime.parse("6:45").toString())
        assertEquals("23:59", ClockTime.parse("23:59").toString())
        assertEquals(405, ClockTime.parse("06:45")?.minutes)
    }

    @Test fun `the midnight that closes a day is an end of day`() {
        val end = ClockTime.parse("24:00")
        assertEquals(1440, end?.minutes)
        assertTrue(end?.isEndOfDay == true)
        assertFalse(ClockTime(0).isEndOfDay)
    }

    @Test fun `malformed times are refused`() {
        assertNull(ClockTime.parse("24:01"))
        assertNull(ClockTime.parse("12:60"))
        assertNull(ClockTime.parse("1200"))
        assertNull(ClockTime.parse("12:5"))
        assertNull(ClockTime.parse("ab:cd"))
        assertNull(ClockTime.parse(""))
    }

    @Test fun `times are ordered by minutes`() {
        assertTrue(ClockTime(60) < ClockTime(61))
        assertEquals(9, ClockTime(555).hour)
        assertEquals(15, ClockTime(555).minute)
    }

    @Test fun `minutes after midnight make a time only inside the day`() {
        assertEquals("00:00", ClockTime.ofMinutes(0).toString())
        assertEquals("23:59", ClockTime.ofMinutes(1439).toString())
        assertEquals(true, ClockTime.ofMinutes(1440)?.isEndOfDay)
        assertNull(ClockTime.ofMinutes(-1))
        assertNull(ClockTime.ofMinutes(1441))
    }
}
