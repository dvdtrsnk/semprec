package cz.semprec.app.presentation

import cz.semprec.app.core.DeviceAlarmFailure
import cz.semprec.app.core.DeviceAlarmPhase
import cz.semprec.app.core.DeviceAlarmScheduling
import cz.semprec.app.core.InMemorySleepAlarmLedger
import cz.semprec.app.core.InMemoryWakeStorage
import cz.semprec.app.core.WakeMission
import cz.semprec.app.core.WakeSettings
import cz.semprec.app.core.WakeStorage
import cz.semprec.app.domain.CalendarDay
import cz.semprec.app.domain.LoadSleepAlarmNights
import cz.semprec.app.domain.SleepNight
import cz.semprec.app.domain.WakeMissionRules
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runTest
import kotlinx.datetime.Instant
import kotlinx.datetime.TimeZone
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

private val WAKE_ZONE = TimeZone.of("Europe/Prague")
private val WAKE_DAY = CalendarDay(2026, 11, 25)
private val FIRST_RING_AT = Instant.parse("2026-11-26T05:45:00Z")
private const val FIRST_KEY = "sleep:2026-11-26T05:45:00Z"

private fun nightOn(evening: CalendarDay) =
    SleepNight(evening, "p1", "Weekdays", sleepClock("23:00"), sleepClock("06:45"), true, false, 465)

private val WATCH_COUNT = WakeMissionRules.watchOffsets.size

/** A storage that counts what it was asked to write. */
private class CountingStorage : WakeStorage {
    private val inner = InMemoryWakeStorage()
    var settingsSaves = 0
    var missionSaves = 0

    override fun loadSettings() = inner.loadSettings()

    override fun saveSettings(settings: WakeSettings) {
        settingsSaves += 1
        inner.saveSettings(settings)
    }

    override fun loadMissions() = inner.loadMissions()

    override fun saveMissions(missions: List<WakeMission>) {
        missionSaves += 1
        inner.saveMissions(missions)
    }
}

@OptIn(ExperimentalCoroutinesApi::class)
class WakeMissionSyncTest : MainDispatcherTest() {
    private val device = ScriptedAlarms()
    private val ledger = InMemorySleepAlarmLedger()
    private val storage = CountingStorage()
    private val wake = WakeMissions(storage, device)
    private var now = Instant.parse("2026-11-25T08:30:00Z")

    private fun sync(vararg nights: SleepNight, enabled: Boolean = true) = SleepAlarmSync(
        LoadSleepAlarmNights(
            FakeSleepRepository(
                sleepContent(sleepOverview(settings = sleepSettings().copy(enabled = enabled))),
                nightsAnswer = cz.semprec.app.domain.RepositoryResult.Content(nights.toList()),
            ),
        ),
        device,
        ledger,
        wake,
        now = { now },
        zone = { WAKE_ZONE },
    )

    private fun requireCode(vararg codes: String) =
        wake.changeSettings { WakeSettings(requiresCode = true, codes = codes.toList()) }

    @Test fun `with a code every ring is a mission whose watch alarms are armed when it is close`() =
        runTest(dispatcher) {
            requireCode("123", "456")

            val result = sync(nightOn(WAKE_DAY), nightOn(WAKE_DAY.plusDays(1))).sync()

            assertEquals(SleepAlarmSyncResult.SYNCED, result)
            assertTrue(ledger.load().isEmpty(), "a mission is not a plain alarm")
            assertEquals(1 + WATCH_COUNT + 1, device.scheduledAt.size)
            assertTrue(device.opensWakeGuard.all { it }, "every alert of a mission opens the guard")
            val missions = wake.missions.value
            assertEquals(listOf(FIRST_KEY, "sleep:2026-11-27T05:45:00Z"), missions.map { it.key })
            assertEquals(listOf("123", "456"), missions[0].codes)
            assertEquals(WATCH_COUNT, missions[0].watchIds.size)
            assertTrue(missions[0].armed)
            assertFalse(missions[1].armed, "the second ring is 45 hours away, outside the horizon")
            assertEquals(
                WakeMissionRules.watchOffsets.map { FIRST_RING_AT.epochSeconds + it * 60L },
                device.scheduledAt.drop(2).take(WATCH_COUNT),
            )
        }

    @Test fun `without a code the rings are plain alarms that do not open the guard`() = runTest(dispatcher) {
        wake.changeSettings { WakeSettings(requiresCode = true, codes = listOf("  ", "")) }

        sync(nightOn(WAKE_DAY)).sync()

        assertEquals(mapOf(FIRST_KEY to "d1"), ledger.load())
        assertEquals(listOf(false), device.opensWakeGuard)
        assertTrue(wake.missions.value.isEmpty())
    }

    @Test fun `a refusal while arming keeps the watch alarms scheduled so far and is not tried again`() =
        runTest(dispatcher) {
            requireCode("123")
            device.scheduleAnswers = ArrayDeque(
                listOf(
                    DeviceAlarmScheduling.Scheduled("m1"),
                    DeviceAlarmScheduling.Scheduled("w1"),
                    DeviceAlarmScheduling.Scheduled("w2"),
                    DeviceAlarmScheduling.Refused(DeviceAlarmFailure.LIMIT_REACHED),
                ),
            )

            val result = sync(nightOn(WAKE_DAY)).sync()
            val scheduled = device.scheduledAt.size
            val again = sync(nightOn(WAKE_DAY)).sync()

            assertEquals(SleepAlarmSyncResult.LIMIT_REACHED, result)
            assertEquals(listOf("w1", "w2"), wake.missions.value.single().watchIds)
            assertTrue(wake.missions.value.single().armed)
            assertEquals(SleepAlarmSyncResult.SYNCED, again)
            assertEquals(scheduled, device.scheduledAt.size, "the next run arms nothing twice")
        }

    @Test fun `an unexplained failure of a watch alarm ends the arming of that mission only`() = runTest(dispatcher) {
        requireCode("123")
        device.scheduleAnswers = ArrayDeque(
            listOf(DeviceAlarmScheduling.Scheduled("m1"), DeviceAlarmScheduling.Failed),
        )

        val result = sync(nightOn(WAKE_DAY)).sync()

        assertEquals(SleepAlarmSyncResult.DEVICE_FAILED, result)
        assertTrue(wake.missions.value.single().watchIds.isEmpty())
        assertEquals(2, device.scheduledAt.size)
    }

    @Test fun `a mission is kept while its codes are the same in any order and replaced when they change`() =
        runTest(dispatcher) {
            requireCode("123", "456")
            sync(nightOn(WAKE_DAY)).sync()
            val held = device.scheduledAt.size

            requireCode("456", "123")
            sync(nightOn(WAKE_DAY)).sync()
            assertEquals(held, device.scheduledAt.size, "the same codes in another order change nothing")
            assertTrue(device.cancelled.isEmpty())

            requireCode("789")
            sync(nightOn(WAKE_DAY)).sync()
            assertEquals(1 + WATCH_COUNT, device.cancelled.size, "the alarm and its watch alarms are removed")
            assertEquals(listOf("789"), wake.missions.value.single().codes)
            assertEquals(held + 1 + WATCH_COUNT, device.scheduledAt.size)
        }

    @Test fun `turning the code off replaces the missions that wait with plain alarms`() = runTest(dispatcher) {
        requireCode("123")
        sync(nightOn(WAKE_DAY)).sync()

        wake.changeSettings { it.copy(requiresCode = false) }
        sync(nightOn(WAKE_DAY)).sync()

        assertTrue(wake.missions.value.isEmpty())
        assertEquals(1 + WATCH_COUNT, device.cancelled.size)
        assertEquals(setOf(FIRST_KEY), ledger.load().keys)
        assertEquals(false, device.opensWakeGuard.last())
    }

    @Test fun `turning the code on replaces a plain alarm with a mission`() = runTest(dispatcher) {
        sync(nightOn(WAKE_DAY)).sync()

        requireCode("123")
        sync(nightOn(WAKE_DAY)).sync()

        assertEquals(listOf("d1"), device.cancelled)
        assertTrue(ledger.load().isEmpty())
        assertEquals(FIRST_KEY, wake.missions.value.single().key)
    }

    @Test fun `a mission whose ring has come stays whatever the plan says, and so does an alarm that rings`() =
        runTest(dispatcher) {
            requireCode("123")
            sync(nightOn(WAKE_DAY)).sync()
            val mission = wake.missions.value.single()
            device.phases[mission.watchIds.first()] = DeviceAlarmPhase.ALERTING
            now = FIRST_RING_AT + kotlin.time.Duration.parse("5m")

            val result = sync(enabled = false).sync()

            assertEquals(SleepAlarmSyncResult.SYNCED, result)
            assertEquals(listOf(mission), wake.missions.value)
            assertTrue(mission.watchIds.first() !in device.cancelled)
        }

    @Test fun `signing out removes the missions that wait`() = runTest(dispatcher) {
        requireCode("123")
        sync(nightOn(WAKE_DAY)).sync()

        val result = sync(nightOn(WAKE_DAY)).signedOut()

        assertEquals(SleepAlarmSyncResult.SYNCED, result)
        assertTrue(wake.missions.value.isEmpty())
        assertTrue(device.phases.isEmpty())
    }

    @Test fun `a mission whose alarm the device lost is scheduled again`() = runTest(dispatcher) {
        requireCode("123")
        sync(nightOn(WAKE_DAY)).sync()
        device.phases.remove(wake.missions.value.single().alarmId)

        sync(nightOn(WAKE_DAY)).sync()

        assertEquals("d${1 + WATCH_COUNT + 1}", wake.missions.value.single().alarmId)
    }

    @Test fun `finishing a mission forgets it and removes its alarm and every watch alarm`() = runTest(dispatcher) {
        requireCode("123")
        sync(nightOn(WAKE_DAY)).sync()
        val mission = wake.missions.value.single()
        device.cancelled.clear()

        val removed = wake.finish(mission.key)

        assertTrue(removed)
        assertTrue(wake.missions.value.isEmpty())
        assertEquals(listOf(mission.alarmId) + mission.watchIds, device.cancelled)
        assertTrue(device.phases.isEmpty())
    }

    @Test fun `a mission that ends although the device kept an alarm is gone and reports it`() = runTest(dispatcher) {
        requireCode("123")
        sync(nightOn(WAKE_DAY)).sync()
        val mission = wake.missions.value.single()
        device.failToCancel = setOf(mission.watchIds[3])
        device.cancelled.clear()

        val removed = wake.finish(mission.key)

        assertFalse(removed)
        assertTrue(wake.missions.value.isEmpty())
        assertEquals(1 + WATCH_COUNT, device.cancelled.size, "one failure does not keep the others ringing")
    }

    @Test fun `finishing a mission that is not held changes nothing`() = runTest(dispatcher) {
        assertTrue(wake.finish("sleep:none"))

        assertTrue(device.cancelled.isEmpty())
        assertEquals(0, storage.missionSaves)
    }

    @Test fun `only what changes is written`() = runTest(dispatcher) {
        requireCode("123")
        requireCode("123")
        assertEquals(1, storage.settingsSaves)

        sync(nightOn(WAKE_DAY)).sync()
        val saves = storage.missionSaves
        sync(nightOn(WAKE_DAY)).sync()

        assertEquals(saves, storage.missionSaves, "a run that changes nothing writes nothing")
    }
}
