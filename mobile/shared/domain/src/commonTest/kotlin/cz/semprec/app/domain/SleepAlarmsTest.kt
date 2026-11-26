package cz.semprec.app.domain

import cz.semprec.app.core.DeviceAlarmPhase
import cz.semprec.app.core.FailureKind
import cz.semprec.app.core.HeldDeviceAlarm
import kotlinx.coroutines.test.runTest
import kotlinx.datetime.Instant
import kotlinx.datetime.TimeZone
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

private val PRAGUE = TimeZone.of("Europe/Prague")
private val NEW_YORK = TimeZone.of("America/New_York")

/** Half past nine in the morning in Prague (CET, one hour ahead of UTC). */
private val NOW = Instant.parse("2026-11-25T08:30:00Z")
private val TODAY = CalendarDay(2026, 11, 25)

private fun night(evening: CalendarDay, wake: String, alarm: Boolean = true) =
    SleepNight(evening, "p1", "Weekdays", time("23:00"), time(wake), alarm, changed = false, durationMinutes = 465)

private fun on(vararg nights: SleepNight) = SleepAlarmNights(enabled = true, nights = nights.toList())

private fun held(ledger: Map<String, String> = emptyMap(), vararg device: Pair<String, DeviceAlarmPhase>) =
    HeldSleepAlarms(ledger, device.map { (id, phase) -> HeldDeviceAlarm(id, phase) })

private fun plan(
    nights: SleepAlarmNights,
    held: HeldSleepAlarms = held(),
    now: Instant = NOW,
    zone: TimeZone = PRAGUE,
) = PlanSleepAlarms(nights, held, now, zone)

private fun key(instant: String) = "sleep:$instant"

class PlanSleepAlarmsTest {
    @Test fun `every night with its alarm on rings on the day after its evening at its wake time`() {
        val plan = plan(
            on(
                night(TODAY, "06:45"),
                night(TODAY.plusDays(1), "07:00", alarm = false),
                night(TODAY.plusDays(2), "08:30"),
            ),
        )

        assertEquals(
            listOf(
                SleepAlarmRequest(key("2026-11-26T05:45:00Z"), Instant.parse("2026-11-26T05:45:00Z")),
                SleepAlarmRequest(key("2026-11-28T07:30:00Z"), Instant.parse("2026-11-28T07:30:00Z")),
            ),
            plan.schedule,
        )
        assertTrue(plan.cancel.isEmpty())
    }

    @Test fun `the rings come soonest first whatever the order of the nights`() {
        val plan = plan(on(night(TODAY.plusDays(2), "08:30"), night(TODAY, "06:45")))

        assertEquals(
            listOf(key("2026-11-26T05:45:00Z"), key("2026-11-28T07:30:00Z")),
            plan.schedule.map { it.key },
        )
    }

    @Test fun `a ring that has passed or is this very moment is dropped`() {
        val cases = listOf(
            night(TODAY.plusDays(-1), "06:45") to false,
            night(TODAY.plusDays(-1), "09:30") to false,
            night(TODAY.plusDays(-1), "09:31") to true,
            night(TODAY.plusDays(-1), "10:15") to true,
        )
        for ((night, rings) in cases) {
            val scheduled = plan(on(night)).schedule
            assertEquals(rings, scheduled.isNotEmpty(), "the night ${night.night} waking at ${night.wake}")
        }
    }

    @Test fun `a night that ends at midnight of the next day is no alarm`() {
        assertTrue(plan(on(night(TODAY, "24:00"))).schedule.isEmpty())
    }

    @Test fun `two nights that ring at the same moment ring once`() {
        val plan = plan(on(night(TODAY, "06:45"), night(TODAY, "06:45")))

        assertEquals(listOf(key("2026-11-26T05:45:00Z")), plan.schedule.map { it.key })
    }

    @Test fun `the wake time is read on the wall clock of the zone also on the day the clocks change`() {
        val cases = listOf(
            Triple(PRAGUE, CalendarDay(2026, 3, 28) to "07:00", "2026-03-29T05:00:00Z"),
            Triple(PRAGUE, CalendarDay(2026, 3, 27) to "07:00", "2026-03-28T06:00:00Z"),
            Triple(PRAGUE, CalendarDay(2026, 10, 24) to "07:00", "2026-10-25T06:00:00Z"),
            Triple(PRAGUE, CalendarDay(2026, 10, 25) to "07:00", "2026-10-26T06:00:00Z"),
            Triple(NEW_YORK, CalendarDay(2026, 3, 7) to "07:00", "2026-03-08T11:00:00Z"),
            Triple(NEW_YORK, CalendarDay(2026, 10, 31) to "07:00", "2026-11-01T12:00:00Z"),
            Triple(TimeZone.UTC, CalendarDay(2026, 3, 28) to "07:00", "2026-03-29T07:00:00Z"),
        )
        for ((zone, evening, ringsAt) in cases) {
            val scheduled = plan(
                on(night(evening.first, evening.second)),
                now = Instant.parse("2026-01-01T00:00:00Z"),
                zone = zone,
            ).schedule
            assertEquals(listOf(Instant.parse(ringsAt)), scheduled.map { it.ringAt }, "${zone.id} ${evening.first}")
        }
    }

    @Test fun `a wake time the clocks skip rings an hour later on the wall clock`() {
        val scheduled = plan(
            on(night(CalendarDay(2026, 3, 28), "02:30")),
            now = Instant.parse("2026-01-01T00:00:00Z"),
        ).schedule

        assertEquals(listOf(Instant.parse("2026-03-29T01:30:00Z")), scheduled.map { it.ringAt })
    }

    @Test fun `a wake time the clocks repeat rings the first time`() {
        val scheduled = plan(
            on(night(CalendarDay(2026, 10, 24), "02:30")),
            now = Instant.parse("2026-01-01T00:00:00Z"),
        ).schedule

        assertEquals(listOf(Instant.parse("2026-10-25T00:30:00Z")), scheduled.map { it.ringAt })
    }

    @Test fun `an alarm the device holds for a ring that is still planned stays and is not scheduled again`() {
        val plan = plan(
            on(night(TODAY, "06:45")),
            held(mapOf(key("2026-11-26T05:45:00Z") to "a1"), "a1" to DeviceAlarmPhase.SCHEDULED),
        )

        assertTrue(plan.schedule.isEmpty())
        assertTrue(plan.cancel.isEmpty())
        assertEquals(mapOf(key("2026-11-26T05:45:00Z") to "a1"), plan.keep)
    }

    @Test fun `a ring whose alarm the device no longer holds is scheduled again and its entry forgotten`() {
        val plan = plan(on(night(TODAY, "06:45")), held(mapOf(key("2026-11-26T05:45:00Z") to "gone")))

        assertEquals(listOf(key("2026-11-26T05:45:00Z")), plan.schedule.map { it.key })
        assertTrue(plan.cancel.isEmpty())
        assertTrue(plan.keep.isEmpty())
    }

    @Test fun `a ring that left the plan is cancelled and one that moved is replaced`() {
        val old = key("2026-11-26T05:45:00Z")
        val plan = plan(
            on(night(TODAY, "07:15")),
            held(mapOf(old to "a1"), "a1" to DeviceAlarmPhase.SCHEDULED),
        )

        assertEquals(listOf("a1"), plan.cancel)
        assertEquals(listOf(key("2026-11-26T06:15:00Z")), plan.schedule.map { it.key })
        assertTrue(plan.keep.isEmpty())
    }

    @Test fun `an alarm that is ringing now is never cancelled whatever the plan says`() {
        val ringing = key("2026-11-25T05:45:00Z")
        val cases = listOf(
            plan(on(), held(mapOf(ringing to "a1"), "a1" to DeviceAlarmPhase.ALERTING)),
            plan(on(night(TODAY, "06:45")), held(mapOf(ringing to "a1"), "a1" to DeviceAlarmPhase.ALERTING)),
            plan(SleepAlarmNights(false, emptyList()), held(mapOf(ringing to "a1"), "a1" to DeviceAlarmPhase.ALERTING)),
            plan(on(), held(emptyMap(), "stray" to DeviceAlarmPhase.ALERTING)),
        )
        for (plan in cases) assertTrue(plan.cancel.isEmpty(), "$plan")
    }

    @Test fun `an alarm of the app the ledger does not know is cancelled unless it rings`() {
        val plan = plan(
            on(),
            held(
                mapOf(key("2026-11-26T05:45:00Z") to "known"),
                "known" to DeviceAlarmPhase.SCHEDULED,
                "stray" to DeviceAlarmPhase.SCHEDULED,
                "ringing" to DeviceAlarmPhase.ALERTING,
            ),
        )

        assertEquals(listOf("known", "stray"), plan.cancel)
    }

    @Test fun `the plan off cancels every alarm and schedules none`() {
        val plan = plan(
            SleepAlarmNights(enabled = false, nights = listOf(night(TODAY, "06:45"))),
            held(
                mapOf(key("2026-11-26T05:45:00Z") to "a1", key("2026-11-27T05:45:00Z") to "a2"),
                "a1" to DeviceAlarmPhase.SCHEDULED,
                "a2" to DeviceAlarmPhase.SCHEDULED,
            ),
        )

        assertEquals(listOf("a1", "a2"), plan.cancel)
        assertTrue(plan.schedule.isEmpty())
        assertTrue(plan.keep.isEmpty())
    }

    @Test fun `the day is read in the zone of the device`() {
        val cases = listOf(
            Triple("2026-11-25T23:30:00Z", PRAGUE, CalendarDay(2026, 11, 26)),
            Triple("2026-11-25T23:30:00Z", NEW_YORK, CalendarDay(2026, 11, 25)),
            Triple("2026-11-26T04:59:00Z", NEW_YORK, CalendarDay(2026, 11, 25)),
            Triple("2026-11-26T05:00:00Z", NEW_YORK, CalendarDay(2026, 11, 26)),
        )
        for ((instant, zone, day) in cases) {
            assertEquals(day, PlanSleepAlarms.today(Instant.parse(instant), zone), "$instant in ${zone.id}")
        }
    }
}

class LoadSleepAlarmNightsTest {
    private fun repository(enabled: Boolean = true) = RecordingSleepRepository(
        RepositoryResult.Content(SleepOverview(sampleSettings().copy(enabled = enabled), emptyList(), null)),
    )

    @Test fun `the nights read run from the evening before today through the fifth evening after it`() = runTest {
        val repository = repository()
        val read = listOf(night(TODAY, "06:45"))
        repository.nightsResult = RepositoryResult.Content(read)

        val nights = LoadSleepAlarmNights(repository)(TODAY)

        assertEquals(RepositoryResult.Content(SleepAlarmNights(true, read)), nights)
        assertEquals(listOf("overview:null", "nights:2026-11-24..2026-11-30"), repository.calls)
    }

    @Test fun `the last evening read rings on the sixth day after today`() = runTest {
        val repository = repository()
        repository.nightsResult = RepositoryResult.Content(emptyList())

        LoadSleepAlarmNights(repository)(CalendarDay(2026, 12, 28))

        assertEquals(
            "nights:2026-12-27..2027-01-02",
            repository.calls.last(),
        )
        assertEquals(7, LoadSleepAlarmNights.HORIZON_DAYS)
    }

    @Test fun `the plan off answers no night and reads none`() = runTest {
        val repository = repository(enabled = false)

        assertEquals(
            RepositoryResult.Content(SleepAlarmNights(false, emptyList())),
            LoadSleepAlarmNights(repository)(TODAY),
        )
        assertTrue(repository.calls.none { it.startsWith("nights") })
    }

    @Test fun `a failed read of the settings or of the nights is that failure`() = runTest {
        val noSettings = RecordingSleepRepository()
        assertEquals(RepositoryResult.Failure(FailureKind.UNAVAILABLE), LoadSleepAlarmNights(noSettings)(TODAY))

        val noNights = repository()
        noNights.nightsResult = RepositoryResult.Failure(FailureKind.REJECTED)
        assertEquals(RepositoryResult.Failure(FailureKind.REJECTED), LoadSleepAlarmNights(noNights)(TODAY))
    }
}
