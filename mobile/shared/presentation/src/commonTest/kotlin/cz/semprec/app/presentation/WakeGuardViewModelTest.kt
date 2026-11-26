package cz.semprec.app.presentation

import androidx.lifecycle.ViewModelStore
import cz.semprec.app.core.InMemoryWakeStorage
import cz.semprec.app.core.WakeMission
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.datetime.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.hours
import kotlin.time.Duration.Companion.minutes
import kotlin.time.Duration.Companion.seconds

private val START = Instant.parse("2026-11-26T05:00:00Z")

private fun mission(at: Instant, key: String = "m-$at", codes: List<String> = listOf("123", "456")) =
    WakeMission(key, at.epochSeconds, "alarm-$key", codes, watchIds = listOf("watch-$key"), armed = true)

@OptIn(ExperimentalCoroutinesApi::class)
class WakeGuardViewModelTest : MainDispatcherTest() {
    private val alarms = ScriptedAlarms()
    private val wake = WakeMissions(InMemoryWakeStorage(), alarms)

    /** A guard whose clock is the test's virtual time from [START]. */
    private fun TestScope.guard(): WakeGuardViewModel =
        WakeGuardViewModel(wake) { START + testScheduler.currentTime.milliseconds }

    private val Long.milliseconds get() = kotlin.time.Duration.parse("${this}ms")

    private fun hold(vararg missions: WakeMission) = wake.replaceMissions(missions.toList())

    @Test fun `no mission leaves the window alone`() = runTest(dispatcher) {
        val guard = guard()
        runCurrent()

        assertEquals(WakeGuardState(), guard.state.value)
        guard.close()
    }

    @Test fun `a mission that waits starts ringing at its ring with one delay and no polling`() = runTest(dispatcher) {
        hold(mission(START + 2.hours))
        val guard = guard()
        runCurrent()
        assertEquals(WakeGuardPhase.IDLE, guard.state.value.phase)

        advanceTimeBy(2.hours - 1.seconds)
        runCurrent()
        assertEquals(WakeGuardPhase.IDLE, guard.state.value.phase)

        advanceTimeBy(1.seconds)
        runCurrent()
        val state = guard.state.value
        assertEquals(WakeGuardPhase.SCANNING, state.phase)
        assertEquals(2, state.codeCount)
        assertEquals(200, state.tapsLeft)
        assertEquals(200, state.requiredTaps)
        assertEquals(10, state.fallbackDelayMinutes)
        assertFalse(state.fallbackOpen)
        assertEquals((START + 2.hours + 10.minutes).epochSeconds, state.fallbackOpensAtEpochSeconds)
        guard.close()
    }

    @Test fun `a mission that rang before the window opened rings at once and its fallback is already open`() =
        runTest(dispatcher) {
            hold(mission(START - 30.minutes))
            val guard = guard()
            runCurrent()

            assertEquals(WakeGuardPhase.SCANNING, guard.state.value.phase)
            assertTrue(guard.state.value.fallbackOpen)
            guard.close()
        }

    @Test fun `the fallback opens ten minutes after the ring and the person may then tap`() = runTest(dispatcher) {
        hold(mission(START))
        val guard = guard()
        runCurrent()
        assertFalse(guard.state.value.fallbackOpen)
        guard.onAction(WakeGuardAction.OpenTapFallback)
        assertEquals(WakeGuardPhase.SCANNING, guard.state.value.phase, "the fallback has not opened")

        advanceTimeBy(10.minutes)
        runCurrent()
        assertTrue(guard.state.value.fallbackOpen)
        guard.onAction(WakeGuardAction.OpenTapFallback)
        assertEquals(WakeGuardPhase.TAPPING, guard.state.value.phase)
        guard.onAction(WakeGuardAction.BackToScanning)
        assertEquals(WakeGuardPhase.SCANNING, guard.state.value.phase)
        guard.close()
    }

    @Test fun `a scanned code of the mission ends it, removes its alarms and says so`() = runTest(dispatcher) {
        val ringing = mission(START)
        hold(ringing)
        val guard = guard()
        runCurrent()

        guard.onAction(WakeGuardAction.CodeScanned("  456\n"))
        runCurrent()

        assertEquals(WakeGuardEffect.Finished, guard.effects.first())
        assertTrue(wake.missions.value.isEmpty())
        assertEquals(listOf("alarm-${ringing.key}", "watch-${ringing.key}"), alarms.cancelled)
        assertEquals(WakeGuardPhase.IDLE, guard.state.value.phase)
        guard.close()
    }

    @Test fun `a code that is not the mission's is rejected and the mission keeps ringing`() = runTest(dispatcher) {
        hold(mission(START))
        val guard = guard()
        runCurrent()

        for (code in listOf("999", "", "   ")) guard.onAction(WakeGuardAction.CodeScanned(code))
        runCurrent()

        assertEquals(
            List(3) { WakeGuardEffect.CodeRejected },
            listOf(guard.effects.first(), guard.effects.first(), guard.effects.first()),
        )
        assertEquals(1, wake.missions.value.size)
        assertEquals(WakeGuardPhase.SCANNING, guard.state.value.phase)
        guard.close()
    }

    @Test fun `a code read while nothing rings is ignored`() = runTest(dispatcher) {
        hold(mission(START + 1.hours))
        val guard = guard()
        runCurrent()

        guard.onAction(WakeGuardAction.CodeScanned("123"))
        runCurrent()

        assertEquals(1, wake.missions.value.size)
        assertTrue(alarms.cancelled.isEmpty())
        guard.close()
    }

    @Test fun `the required taps end the mission once the fallback is open and not before`() = runTest(dispatcher) {
        hold(mission(START))
        val guard = guard()
        runCurrent()
        guard.onAction(WakeGuardAction.Tap)
        assertEquals(200, guard.state.value.tapsLeft, "tapping needs the fallback screen")

        advanceTimeBy(10.minutes)
        runCurrent()
        guard.onAction(WakeGuardAction.OpenTapFallback)
        repeat(199) { guard.onAction(WakeGuardAction.Tap) }
        assertEquals(1, guard.state.value.tapsLeft)
        runCurrent()
        assertEquals(1, wake.missions.value.size)

        guard.onAction(WakeGuardAction.Tap)
        runCurrent()

        assertEquals(WakeGuardEffect.Finished, guard.effects.first())
        assertTrue(wake.missions.value.isEmpty())
        guard.close()
    }

    @Test fun `the taps made stay when the person goes back to scanning`() = runTest(dispatcher) {
        hold(mission(START - 1.hours))
        val guard = guard()
        runCurrent()
        guard.onAction(WakeGuardAction.OpenTapFallback)
        repeat(5) { guard.onAction(WakeGuardAction.Tap) }

        guard.onAction(WakeGuardAction.BackToScanning)
        guard.onAction(WakeGuardAction.OpenTapFallback)

        assertEquals(195, guard.state.value.tapsLeft)
        guard.close()
    }

    @Test fun `a second scan while the mission is being ended does nothing more`() = runTest(dispatcher) {
        hold(mission(START))
        val guard = guard()
        runCurrent()

        guard.onAction(WakeGuardAction.CodeScanned("123"))
        guard.onAction(WakeGuardAction.CodeScanned("123"))
        runCurrent()

        assertEquals(WakeGuardEffect.Finished, guard.effects.first())
        assertEquals(2, alarms.cancelled.size, "the alarm and its watch alarm were removed once")
        guard.close()
    }

    @Test fun `the next mission rings after the first ended and starts with all its taps`() = runTest(dispatcher) {
        hold(mission(START, "a"), mission(START + 1.minutes, "b", listOf("777")))
        val guard = guard()
        runCurrent()
        guard.onAction(WakeGuardAction.CodeScanned("123"))
        runCurrent()
        assertEquals(WakeGuardPhase.IDLE, guard.state.value.phase)

        advanceTimeBy(1.minutes)
        runCurrent()

        assertEquals(WakeGuardPhase.SCANNING, guard.state.value.phase)
        assertEquals(1, guard.state.value.codeCount)
        assertEquals(200, guard.state.value.tapsLeft)
        guard.close()
    }

    @Test fun `a mission the sync adds while the window is open is watched`() = runTest(dispatcher) {
        val guard = guard()
        runCurrent()

        hold(mission(START + 5.minutes))
        runCurrent()
        advanceTimeBy(5.minutes)
        runCurrent()

        assertEquals(WakeGuardPhase.SCANNING, guard.state.value.phase)
        guard.close()
    }

    @Test fun `a mission that is removed while it rings clears the guard`() = runTest(dispatcher) {
        hold(mission(START))
        val guard = guard()
        runCurrent()

        hold()
        runCurrent()

        assertEquals(WakeGuardPhase.IDLE, guard.state.value.phase)
        guard.close()
    }

    @Test fun `an action after close changes nothing and closing ends the waiting`() = runTest(dispatcher) {
        hold(mission(START + 1.hours))
        val guard = guard()
        runCurrent()

        guard.close()
        hold(mission(START))
        guard.onAction(WakeGuardAction.CodeScanned("123"))
        advanceTimeBy(2.hours)
        runCurrent()

        assertTrue(guard.isClosed)
        assertEquals(WakeGuardPhase.IDLE, guard.state.value.phase)
        assertEquals(1, wake.missions.value.size)
        assertNull(runCatching { guard.effects.first() }.getOrNull())
    }

    @Test fun `clearing the store ends the guard like close`() = runTest(dispatcher) {
        val store = ViewModelStore()
        hold(mission(START))
        val clock = { START + testScheduler.currentTime.milliseconds }
        val guard = store.provide { WakeGuardViewModel(wake, clock) }
        runCurrent()

        store.clear()
        guard.onAction(WakeGuardAction.CodeScanned("123"))
        runCurrent()

        assertTrue(guard.isClosed)
        assertEquals(1, wake.missions.value.size)
    }

    @Test fun `a window that closes before the removal started leaves the mission ringing`() = runTest(dispatcher) {
        hold(mission(START))
        val guard = guard()
        runCurrent()

        guard.onAction(WakeGuardAction.CodeScanned("123"))
        guard.close()
        runCurrent()

        assertEquals(1, wake.missions.value.size, "another window's guard ends it with the next scan")
        assertTrue(alarms.cancelled.isEmpty())
    }
}
