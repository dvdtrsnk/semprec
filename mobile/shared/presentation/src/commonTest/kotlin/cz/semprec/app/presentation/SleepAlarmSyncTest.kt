package cz.semprec.app.presentation

import cz.semprec.app.core.DeviceAlarmAuthorization
import cz.semprec.app.core.DeviceAlarmFailure
import cz.semprec.app.core.DeviceAlarmPhase
import cz.semprec.app.core.DeviceAlarmScheduling
import cz.semprec.app.core.DeviceAlarms
import cz.semprec.app.core.FailureKind
import cz.semprec.app.core.HeldDeviceAlarm
import cz.semprec.app.core.InMemorySleepAlarmLedger
import cz.semprec.app.domain.CalendarDay
import cz.semprec.app.domain.LoadSleepAlarmNights
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.SleepNight
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.datetime.Instant
import kotlinx.datetime.TimeZone
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

private val SYNC_ZONE = TimeZone.of("Europe/Prague")

/** Half past nine in the morning in Prague (CET). */
private val SYNC_NOW = Instant.parse("2026-11-25T08:30:00Z")
private val SYNC_TODAY = CalendarDay(2026, 11, 25)

private fun night(evening: CalendarDay, wake: String = "06:45", alarm: Boolean = true) =
    SleepNight(evening, "p1", "Weekdays", sleepClock("23:00"), sleepClock(wake), alarm, false, 465)

private const val FIRST_RING = "sleep:2026-11-26T05:45:00Z"
private const val SECOND_RING = "sleep:2026-11-27T05:45:00Z"

/** A device that holds the alarms it was given, and answers when the test lets it. */
private class ScriptedAlarms(
    var authorization: DeviceAlarmAuthorization = DeviceAlarmAuthorization.AUTHORIZED,
) : DeviceAlarms {
    val phases = linkedMapOf<String, DeviceAlarmPhase>()
    val scheduledAt = mutableListOf<Long>()
    val cancelled = mutableListOf<String>()
    var heldReads = 0
    var failToCancel: Set<String> = emptySet()
    var unreadable = false
    var held: CompletableDeferred<Unit>? = null
    var scheduleAnswers = ArrayDeque<DeviceAlarmScheduling>()
    var scheduleGate: CompletableDeferred<Unit>? = null
    private var next = 1

    override fun authorization() = authorization

    override fun schedule(ringAtEpochSeconds: Long, callback: (DeviceAlarmScheduling) -> Unit) {
        scheduledAt += ringAtEpochSeconds
        val answer = scheduleAnswers.removeFirstOrNull() ?: DeviceAlarmScheduling.Scheduled("d${next++}")
        if (answer is DeviceAlarmScheduling.Scheduled) phases[answer.id] = DeviceAlarmPhase.SCHEDULED
        val gate = scheduleGate
        if (gate == null) callback(answer) else gate.invokeOnCompletion { callback(answer) }
    }

    override fun cancel(id: String): Boolean {
        cancelled += id
        if (id in failToCancel) return false
        phases.remove(id)
        return true
    }

    override fun held(callback: (List<HeldDeviceAlarm>?) -> Unit) {
        heldReads += 1
        val answer = if (unreadable) null else phases.map { (id, phase) -> HeldDeviceAlarm(id, phase) }
        val gate = held
        if (gate == null) callback(answer) else gate.invokeOnCompletion { callback(answer) }
    }
}

@OptIn(ExperimentalCoroutinesApi::class)
class SleepAlarmSyncTest : MainDispatcherTest() {
    private val device = ScriptedAlarms()
    private val ledger = InMemorySleepAlarmLedger()
    private var now = SYNC_NOW

    private fun sync(repository: FakeSleepRepository) = SleepAlarmSync(
        LoadSleepAlarmNights(repository),
        device,
        ledger,
        now = { now },
        zone = { SYNC_ZONE },
    )

    private fun repository(vararg nights: SleepNight, enabled: Boolean = true) = FakeSleepRepository(
        sleepContent(sleepOverview(settings = sleepSettings().copy(enabled = enabled))),
        nightsAnswer = RepositoryResult.Content(nights.toList()),
    )

    @Test fun `the rings of the plan are scheduled and the ledger says which alarm is which`() = runTest(dispatcher) {
        val repository = repository(night(SYNC_TODAY), night(SYNC_TODAY.plusDays(1)), night(SYNC_TODAY.plusDays(2), alarm = false))

        val result = sync(repository).sync()

        assertEquals(SleepAlarmSyncResult.SYNCED, result)
        assertEquals(
            listOf("2026-11-26T05:45:00Z", "2026-11-27T05:45:00Z").map { Instant.parse(it).epochSeconds },
            device.scheduledAt,
        )
        assertEquals(mapOf(FIRST_RING to "d1", SECOND_RING to "d2"), ledger.load())
        assertEquals(listOf(SYNC_TODAY.plusDays(-1) to SYNC_TODAY.plusDays(5)), repository.nightRanges)
    }

    @Test fun `a second run changes only what the plan changed`() = runTest(dispatcher) {
        val sync = sync(repository(night(SYNC_TODAY), night(SYNC_TODAY.plusDays(1))))
        sync.sync()
        val changed = repository(night(SYNC_TODAY), night(SYNC_TODAY.plusDays(2)))

        val result = sync(changed).sync()

        assertEquals(SleepAlarmSyncResult.SYNCED, result)
        assertEquals(listOf("d2"), device.cancelled)
        assertEquals(3, device.scheduledAt.size, "two rings at first and the one that replaced the second")
        assertEquals(mapOf(FIRST_RING to "d1", "sleep:2026-11-28T05:45:00Z" to "d3"), ledger.load())
    }

    @Test fun `the plan off removes the alarms but not one that rings now`() = runTest(dispatcher) {
        sync(repository(night(SYNC_TODAY), night(SYNC_TODAY.plusDays(1)))).sync()
        device.phases["d2"] = DeviceAlarmPhase.ALERTING

        val result = sync(repository(night(SYNC_TODAY), enabled = false)).sync()

        assertEquals(SleepAlarmSyncResult.SYNCED, result)
        assertEquals(listOf("d1"), device.cancelled)
        assertEquals(listOf("d2"), device.phases.keys.toList())
        assertTrue(ledger.load().isEmpty())
    }

    @Test fun `signing out removes every alarm that is not ringing and reads nothing`() = runTest(dispatcher) {
        val repository = repository(night(SYNC_TODAY), night(SYNC_TODAY.plusDays(1)))
        sync(repository).sync()
        device.phases["d1"] = DeviceAlarmPhase.ALERTING

        val result = sync(repository).signedOut()

        assertEquals(SleepAlarmSyncResult.SYNCED, result)
        assertEquals(listOf("d2"), device.cancelled)
        assertEquals(1, repository.overviewCalls, "only the first run read the plan")
        assertTrue(ledger.load().isEmpty())
    }

    @Test fun `a plan that cannot be read leaves the device and the ledger as they are`() = runTest(dispatcher) {
        sync(repository(night(SYNC_TODAY))).sync()
        val before = ledger.load()
        val failures = listOf(
            FakeSleepRepository(sleepUnavailable()),
            FakeSleepRepository(sleepContent(), nightsAnswer = RepositoryResult.Failure(FailureKind.REJECTED)),
            FakeSleepRepository(sleepContent(), crash = true),
        )
        for (repository in failures) {
            assertEquals(SleepAlarmSyncResult.READ_FAILED, sync(repository).sync())
        }

        assertTrue(device.cancelled.isEmpty())
        assertEquals(1, device.scheduledAt.size)
        assertEquals(before, ledger.load())
    }

    @Test fun `a device without alarms is not asked and the plan is not read`() = runTest(dispatcher) {
        device.authorization = DeviceAlarmAuthorization.UNSUPPORTED
        val repository = repository(night(SYNC_TODAY))

        assertEquals(SleepAlarmSyncResult.UNSUPPORTED, sync(repository).sync())
        assertEquals(SleepAlarmSyncResult.UNSUPPORTED, sync(repository).signedOut())

        assertEquals(0, repository.overviewCalls)
        assertEquals(0, device.heldReads)
        assertTrue(device.scheduledAt.isEmpty())
    }

    @Test fun `a refusal of the device is the typed result and ends the run`() = runTest(dispatcher) {
        val cases = mapOf(
            DeviceAlarmFailure.NOT_AUTHORIZED to SleepAlarmSyncResult.NOT_AUTHORIZED,
            DeviceAlarmFailure.LIMIT_REACHED to SleepAlarmSyncResult.LIMIT_REACHED,
            DeviceAlarmFailure.UNSUPPORTED to SleepAlarmSyncResult.UNSUPPORTED,
        )
        for ((failure, expected) in cases) {
            device.scheduleAnswers = ArrayDeque(listOf(DeviceAlarmScheduling.Refused(failure)))
            device.scheduledAt.clear()

            val result = sync(repository(night(SYNC_TODAY), night(SYNC_TODAY.plusDays(1)))).sync()

            assertEquals(expected, result, "$failure")
            assertEquals(1, device.scheduledAt.size, "$failure: the next ring is not tried")
            assertTrue(ledger.load().isEmpty())
        }
    }

    @Test fun `an unexplained failure of one alarm does not keep the others from ringing`() = runTest(dispatcher) {
        device.scheduleAnswers = ArrayDeque(listOf(DeviceAlarmScheduling.Failed))

        val result = sync(repository(night(SYNC_TODAY), night(SYNC_TODAY.plusDays(1)))).sync()

        assertEquals(SleepAlarmSyncResult.DEVICE_FAILED, result)
        assertEquals(2, device.scheduledAt.size)
        assertEquals(mapOf(SECOND_RING to "d1"), ledger.load())
    }

    @Test fun `an alarm list the device cannot read changes nothing`() = runTest(dispatcher) {
        device.unreadable = true

        val result = sync(repository(night(SYNC_TODAY))).sync()

        assertEquals(SleepAlarmSyncResult.DEVICE_FAILED, result)
        assertTrue(device.scheduledAt.isEmpty())
        assertTrue(device.cancelled.isEmpty())
    }

    @Test fun `an alarm that could not be removed is removed by the next run`() = runTest(dispatcher) {
        sync(repository(night(SYNC_TODAY))).sync()
        device.failToCancel = setOf("d1")
        val gone = repository(enabled = false)

        assertEquals(SleepAlarmSyncResult.DEVICE_FAILED, sync(gone).sync())
        assertTrue(ledger.load().isEmpty())
        device.failToCancel = emptySet()
        assertEquals(SleepAlarmSyncResult.SYNCED, sync(gone).sync())

        assertEquals(listOf("d1", "d1"), device.cancelled)
        assertTrue(device.phases.isEmpty())
    }

    @Test fun `a run asked for while one runs waits for it and then reads again`() = runTest(dispatcher) {
        val sync = sync(repository(night(SYNC_TODAY)))
        val gate = CompletableDeferred<Unit>()
        device.held = gate

        val first = async { sync.sync() }
        val second = async { sync.sync() }
        runCurrent()
        assertEquals(1, device.heldReads, "the second run has not started")

        device.held = null
        gate.complete(Unit)
        runCurrent()

        assertEquals(SleepAlarmSyncResult.SYNCED, first.await())
        assertEquals(SleepAlarmSyncResult.SYNCED, second.await())
        assertEquals(2, device.heldReads)
        assertEquals(1, device.scheduledAt.size, "the second run found the alarm the first one rang")
    }

    @Test fun `cancelling a run rethrows, keeps what was done in the ledger and frees the next run`() =
        runTest(dispatcher) {
            val sync = sync(repository(night(SYNC_TODAY), night(SYNC_TODAY.plusDays(1))))
            val gate = CompletableDeferred<Unit>()
            device.scheduleGate = gate
            val running = async { sync.sync() }
            runCurrent()
            assertEquals(1, device.scheduledAt.size)

            running.cancelAndJoin()
            assertFailsWith<CancellationException> { running.await() }
            device.scheduleGate = null
            gate.complete(Unit)
            runCurrent()

            val next = sync.sync()
            assertEquals(SleepAlarmSyncResult.SYNCED, next)
            assertEquals(listOf("d1"), device.cancelled, "the alarm the ledger did not know is replaced")
            assertEquals(mapOf(FIRST_RING to "d2", SECOND_RING to "d3"), ledger.load())
        }

    @Test fun `a plan that answers after its run was cancelled touches nothing on the device`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        val repository = repository(night(SYNC_TODAY)).also { it.gate = gate }
        val running = async { sync(repository).sync() }
        runCurrent()

        running.cancel()
        gate.complete(Unit)
        runCurrent()

        assertFailsWith<CancellationException> { running.await() }
        assertEquals(0, device.heldReads)
        assertTrue(ledger.load().isEmpty())
    }

    @Test fun `the ring of a day the clocks change is read on the wall clock of the zone`() = runTest(dispatcher) {
        now = Instant.parse("2026-03-27T10:00:00Z")

        sync(repository(night(CalendarDay(2026, 3, 28), "07:00"))).sync()

        assertEquals(listOf(Instant.parse("2026-03-29T05:00:00Z").epochSeconds), device.scheduledAt)
        assertEquals(setOf("sleep:2026-03-29T05:00:00Z"), ledger.load().keys)
    }
}
