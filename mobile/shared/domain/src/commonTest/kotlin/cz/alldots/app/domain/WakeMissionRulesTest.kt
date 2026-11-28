package cz.alldots.app.domain

import cz.alldots.app.core.DeviceAlarmPhase
import cz.alldots.app.core.HeldDeviceAlarm
import cz.alldots.app.core.WakeMission
import cz.alldots.app.core.WakeSettings
import kotlinx.datetime.Instant
import kotlinx.datetime.TimeZone
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.hours
import kotlin.time.Duration.Companion.minutes

private val WAKE_ZONE = TimeZone.of("Europe/Prague")
private val WAKE_NOW = Instant.parse("2026-11-25T08:30:00Z")
private val WAKE_TODAY = CalendarDay(2026, 11, 25)
private val FIRST_AT = Instant.parse("2026-11-26T05:45:00Z")

private fun wakeNight(evening: CalendarDay, wake: String = "06:45") =
    SleepNight(evening, "p1", "Weekdays", time("23:00"), time(wake), true, changed = false, durationMinutes = 465)

private fun mission(key: String, at: Instant, codes: List<String> = listOf("123"), armed: Boolean = false) =
    WakeMission(key, at.epochSeconds, "alarm-$key", codes, listOf("watch-$key"), armed)

private fun missionKey(at: String) = "sleep:$at"

private fun planMissions(
    missions: List<WakeMission>,
    device: List<Pair<String, DeviceAlarmPhase>>,
    nights: List<SleepNight> = listOf(wakeNight(WAKE_TODAY)),
    codes: List<String> = listOf("123"),
    now: Instant = WAKE_NOW,
) = PlanSleepAlarms(
    SleepAlarmNights(true, nights),
    HeldSleepAlarms(emptyMap(), device.map { (id, phase) -> HeldDeviceAlarm(id, phase) }, missions),
    now,
    WAKE_ZONE,
    codes,
)

class WakeCodesTest {
    @Test fun `codes lose their whitespace and blanks and repeats and keep their order`() {
        val cases = mapOf(
            listOf(" 123 ", "456", "123", "", "  ", "\n789\t") to listOf("123", "456", "789"),
            emptyList<String>() to emptyList(),
            listOf("a b", "a b ") to listOf("a b"),
        )
        for ((input, expected) in cases) assertEquals(expected, WakeCodes.normalize(input), "$input")
    }

    @Test fun `a scan is accepted when it is one of the codes without its surrounding whitespace`() {
        val codes = listOf("123", "4 5")
        val cases = mapOf(
            "123" to true,
            " 123\n" to true,
            "4 5" to true,
            "12" to false,
            "1234" to false,
            "" to false,
            "   " to false,
            "4  5" to false,
        )
        for ((scanned, expected) in cases) assertEquals(expected, WakeCodes.accepts(codes, scanned), "'$scanned'")
        assertFalse(WakeCodes.accepts(emptyList(), "123"))
    }

    @Test fun `only a switch that is on has active codes`() {
        assertEquals(listOf("1", "2"), WakeCodes.active(WakeSettings(true, listOf(" 1", "2", "1"))))
        assertTrue(WakeCodes.active(WakeSettings(false, listOf("1"))).isEmpty())
        assertTrue(WakeCodes.active(WakeSettings(true, listOf(" "))).isEmpty())
    }

    @Test fun `the same codes in another order are the same codes`() {
        assertTrue(WakeCodes.sameCodes(listOf("1", "2"), listOf("2", "1")))
        assertFalse(WakeCodes.sameCodes(listOf("1", "2"), listOf("1")))
        assertFalse(WakeCodes.sameCodes(listOf("1"), listOf("2")))
    }
}

class WakeMissionRulesTest {
    @Test fun `the rules keep the numbers of the design`() {
        assertEquals(200, WakeMissionRules.REQUIRED_TAPS)
        assertEquals(10.minutes, WakeMissionRules.TAP_FALLBACK_DELAY)
        assertEquals(36.hours, WakeMissionRules.ARM_HORIZON)
    }

    @Test fun `watch alarms ring every minute for half an hour and then every five minutes up to two hours`() {
        val offsets = WakeMissionRules.watchOffsets
        assertEquals((1..30).toList(), offsets.take(30))
        assertEquals((35..120 step 5).toList(), offsets.drop(30))
        assertEquals(48, offsets.size)
        assertEquals(FIRST_AT + 1.minutes, WakeMissionRules.watchRings(mission("k", FIRST_AT)).first())
        assertEquals(FIRST_AT + 120.minutes, WakeMissionRules.watchRings(mission("k", FIRST_AT)).last())
    }

    @Test fun `watch alarms are needed only for a ring that is ahead and within the horizon and not yet armed`() {
        val cases = listOf(
            Triple(FIRST_AT, false, true),
            Triple(WAKE_NOW + 36.hours, false, true),
            Triple(WAKE_NOW + 36.hours + 1.minutes, false, false),
            Triple(WAKE_NOW, false, false),
            Triple(WAKE_NOW - 1.minutes, false, false),
            Triple(FIRST_AT, true, false),
        )
        for ((at, armed, expected) in cases) {
            val needs = WakeMissionRules.needsWatches(mission("k", at, armed = armed), WAKE_NOW)
            assertEquals(expected, needs, "$at $armed")
        }
    }

    @Test fun `the mission that rings is the one whose ring came first and it rings until it ends`() {
        val older = mission("old", WAKE_NOW - 5.hours)
        val newer = mission("new", WAKE_NOW - 1.minutes)
        val waiting = mission("later", WAKE_NOW + 1.hours)

        assertEquals(older, WakeMissionRules.ringing(listOf(waiting, newer, older), WAKE_NOW))
        assertEquals(newer, WakeMissionRules.ringing(listOf(waiting, newer), WAKE_NOW))
        assertEquals(waiting, WakeMissionRules.ringing(listOf(waiting), WAKE_NOW + 1.hours), "at the ring itself")
        assertNull(WakeMissionRules.ringing(listOf(waiting), WAKE_NOW))
        assertNull(WakeMissionRules.ringing(emptyList(), WAKE_NOW))
    }

    @Test fun `the next ring is the soonest one ahead`() {
        val missions = listOf(
            mission("a", WAKE_NOW - 1.hours),
            mission("b", WAKE_NOW + 3.hours),
            mission("c", WAKE_NOW + 2.hours),
        )

        assertEquals(WAKE_NOW + 2.hours, WakeMissionRules.nextRing(missions, WAKE_NOW))
        assertNull(WakeMissionRules.nextRing(missions, WAKE_NOW + 3.hours))
        assertNull(WakeMissionRules.nextRing(emptyList(), WAKE_NOW))
    }

    @Test fun `the tap fallback opens ten minutes after the ring`() {
        assertEquals(FIRST_AT + 10.minutes, WakeMissionRules.tapFallbackOpensAt(mission("k", FIRST_AT)))
    }
}

class PlanWakeMissionsTest {
    @Test fun `with codes every ring is a mission request that carries the codes`() {
        val plan = planMissions(emptyList(), emptyList(), codes = listOf("123", "456"))

        assertEquals(
            listOf(SleepAlarmRequest(missionKey("2026-11-26T05:45:00Z"), FIRST_AT, listOf("123", "456"))),
            plan.schedule,
        )
        assertTrue(plan.cancel.isEmpty())
    }

    @Test fun `the ring of a day the clocks change is still the wall clock time`() {
        val plan = planMissions(
            emptyList(),
            emptyList(),
            nights = listOf(wakeNight(CalendarDay(2026, 3, 28), "07:00")),
            now = Instant.parse("2026-03-27T10:00:00Z"),
        )

        assertEquals(Instant.parse("2026-03-29T05:00:00Z"), plan.schedule.single().ringAt)
    }

    @Test fun `a mission that waits for the same codes in another order and holds its alarm stays`() {
        val held = mission(missionKey("2026-11-26T05:45:00Z"), FIRST_AT, listOf("1", "2"))

        val plan = planMissions(
            listOf(held),
            listOf(
                "alarm-${held.key}" to DeviceAlarmPhase.SCHEDULED,
                "watch-${held.key}" to DeviceAlarmPhase.SCHEDULED,
            ),
            codes = listOf("2", "1"),
        )

        assertEquals(listOf(held), plan.keepMissions)
        assertTrue(plan.schedule.isEmpty())
        assertTrue(plan.cancel.isEmpty())
    }

    @Test fun `a mission whose codes changed is replaced and its alarms removed and a ringing watch alarm excepted`() {
        val held = mission(missionKey("2026-11-26T05:45:00Z"), FIRST_AT, listOf("1"))

        val plan = planMissions(
            listOf(held),
            listOf("alarm-${held.key}" to DeviceAlarmPhase.SCHEDULED, "watch-${held.key}" to DeviceAlarmPhase.ALERTING),
            codes = listOf("2"),
        )

        assertTrue(plan.keepMissions.isEmpty())
        assertEquals(listOf("alarm-${held.key}"), plan.cancel)
        assertEquals(listOf("2"), plan.schedule.single().codes)
    }

    @Test fun `a mission that the plan no longer asks for or whose alarm is gone is replaced or removed`() {
        val gone = mission(missionKey("2026-11-26T05:45:00Z"), FIRST_AT)
        val onDevice = listOf("alarm-${gone.key}" to DeviceAlarmPhase.SCHEDULED)
        val removed = planMissions(listOf(gone), onDevice, nights = emptyList())
        assertEquals(listOf("alarm-${gone.key}"), removed.cancel)
        assertTrue(removed.keepMissions.isEmpty())

        val lost = planMissions(listOf(gone), emptyList())
        assertTrue(lost.cancel.isEmpty())
        assertEquals(1, lost.schedule.size, "the alarm the device lost is scheduled again")
    }

    @Test fun `a mission whose ring has come is kept whatever the plan and the codes say`() {
        val ringing = mission(missionKey("2026-11-25T05:45:00Z"), WAKE_NOW - 3.hours, listOf("1"))

        val plan = planMissions(listOf(ringing), emptyList(), nights = emptyList(), codes = emptyList())

        assertEquals(listOf(ringing), plan.keepMissions)
        assertTrue(plan.cancel.isEmpty())
    }

    @Test fun `plain alarms are replaced by missions and the other way round`() {
        val plain = HeldSleepAlarms(
            mapOf(missionKey("2026-11-26T05:45:00Z") to "d1"),
            listOf(HeldDeviceAlarm("d1", DeviceAlarmPhase.SCHEDULED)),
        )
        val toMission = PlanSleepAlarms(
            SleepAlarmNights(true, listOf(wakeNight(WAKE_TODAY))), plain, WAKE_NOW, WAKE_ZONE, listOf("1"),
        )
        assertEquals(listOf("d1"), toMission.cancel)
        assertTrue(toMission.keep.isEmpty())
        assertEquals(listOf("1"), toMission.schedule.single().codes)

        val toPlain = planMissions(
            listOf(mission(missionKey("2026-11-26T05:45:00Z"), FIRST_AT)),
            listOf("alarm-${missionKey("2026-11-26T05:45:00Z")}" to DeviceAlarmPhase.SCHEDULED),
            codes = emptyList(),
        )
        assertEquals(listOf("alarm-${missionKey("2026-11-26T05:45:00Z")}"), toPlain.cancel)
        assertTrue(toPlain.schedule.single().codes.isEmpty())
    }

    @Test fun `an alarm of the app that no mission and no ledger entry knows is removed unless it rings`() {
        val held = mission(missionKey("2026-11-26T05:45:00Z"), FIRST_AT)

        val plan = planMissions(
            listOf(held),
            listOf(
                "alarm-${held.key}" to DeviceAlarmPhase.SCHEDULED,
                "watch-${held.key}" to DeviceAlarmPhase.SCHEDULED,
                "stray" to DeviceAlarmPhase.SCHEDULED,
                "ringing-stray" to DeviceAlarmPhase.ALERTING,
            ),
        )

        assertEquals(listOf("stray"), plan.cancel)
    }
}
