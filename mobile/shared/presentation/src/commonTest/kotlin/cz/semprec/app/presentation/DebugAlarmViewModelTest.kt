package cz.semprec.app.presentation

import cz.semprec.app.core.DeviceAlarmAuthorization
import cz.semprec.app.core.DeviceAlarmFailure
import cz.semprec.app.core.DeviceAlarmPhase
import cz.semprec.app.core.DeviceAlarmScheduling
import cz.semprec.app.core.InMemorySleepAlarmLedger
import cz.semprec.app.core.InMemoryWakeStorage
import cz.semprec.app.core.WakeMission
import cz.semprec.app.core.WakeSettings
import cz.semprec.app.domain.DebugAlarmRules
import cz.semprec.app.domain.LoadSleepAlarmNights
import cz.semprec.app.domain.WakeMissionRules
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.datetime.Instant
import kotlinx.datetime.TimeZone
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

private val DEBUG_PRAGUE = TimeZone.of("Europe/Prague")

/** Half past nine in the morning in Prague (CET). */
private val DEBUG_START = Instant.parse("2026-11-25T08:30:00Z")

@OptIn(ExperimentalCoroutinesApi::class)
class DebugAlarmViewModelTest : MainDispatcherTest() {
    private val device = ScriptedAlarms()
    private val ledger = InMemorySleepAlarmLedger()
    private val wake = WakeMissions(InMemoryWakeStorage(), device)
    private val now = DEBUG_START

    private fun alarms() = DebugAlarms(device, ledger, wake, now = { now }, zone = { DEBUG_PRAGUE })

    private fun viewModel() = DebugAlarmViewModel(alarms())

    private fun DebugAlarmViewModel.act(action: DebugAlarmAction) {
        onAction(action)
        dispatcher.scheduler.runCurrent()
    }

    private fun ringAt(seconds: Long) = (DEBUG_START.epochSeconds + seconds)

    @Test fun `the permission and the stored codes are the first state and the alarms the device holds follow`() =
        runTest(dispatcher) {
            device.authorization = DeviceAlarmAuthorization.NOT_DETERMINED
            wake.changeSettings { WakeSettings(requiresCode = false, codes = listOf("1", "2")) }
            device.phases["stray"] = DeviceAlarmPhase.ALERTING

            val vm = viewModel()
            assertEquals(DeviceAlarmAuthorization.NOT_DETERMINED, vm.state.value.authorization)
            assertEquals(2, vm.state.value.codeCount, "the switch of the wake settings is not asked")
            assertTrue(vm.state.value.alarms.isEmpty())
            runCurrent()

            assertEquals(
                listOf(DebugAlarmRow("stray", DebugAlarmKind.ALARM, DebugAlarmSource.UNKNOWN, null, DeviceAlarmPhase.ALERTING)),
                vm.state.value.alarms,
            )
            assertFalse(vm.state.value.busy)
            vm.close()
        }

    @Test fun `the permission is asked for and the answer is the state`() = runTest(dispatcher) {
        val cases = listOf(
            DeviceAlarmAuthorization.AUTHORIZED,
            DeviceAlarmAuthorization.DENIED,
            DeviceAlarmAuthorization.UNSUPPORTED,
        )
        for (decision in cases) {
            device.authorization = DeviceAlarmAuthorization.NOT_DETERMINED
            device.decisions.add(decision)
            val vm = viewModel()
            runCurrent()

            vm.act(DebugAlarmAction.RequestAuthorization)

            assertEquals(decision, vm.state.value.authorization)
            assertNull(vm.state.value.failure)
            vm.close()
        }
        assertEquals(cases.size, device.authorizationRequests)
    }

    @Test fun `a test alarm rings that many seconds from now as a plain alarm the ledger and the list know`() =
        runTest(dispatcher) {
            val delays = mapOf(
                DebugAlarmDelay.TEN_SECONDS to 10L,
                DebugAlarmDelay.ONE_MINUTE to 60L,
                DebugAlarmDelay.FIVE_MINUTES to 300L,
            )
            val vm = viewModel()
            runCurrent()

            for ((delay, seconds) in delays) vm.act(DebugAlarmAction.RingIn(delay, withCodes = false))

            assertEquals(delays.values.map(::ringAt), device.scheduledAt)
            assertEquals(listOf(false, false, false), device.opensWakeGuard)
            assertEquals(
                delays.values.mapIndexed { index, seconds ->
                    DebugAlarmRules.key(Instant.fromEpochSeconds(ringAt(seconds)), "d${index + 1}") to "d${index + 1}"
                }.toMap(),
                ledger.load(),
            )
            assertEquals(
                delays.values.mapIndexed { index, seconds ->
                    DebugAlarmRow(
                        "d${index + 1}",
                        DebugAlarmKind.ALARM,
                        DebugAlarmSource.DEBUG,
                        ringAt(seconds),
                        DeviceAlarmPhase.SCHEDULED,
                    )
                },
                vm.state.value.alarms,
            )
            assertNull(vm.state.value.failure)
            vm.close()
        }

    @Test fun `a mission rings with the stored codes, the guard watches it and its watch alarms are armed`() =
        runTest(dispatcher) {
            wake.changeSettings { WakeSettings(requiresCode = false, codes = listOf(" 123 ", "456", "123")) }
            val vm = viewModel()
            runCurrent()

            vm.act(DebugAlarmAction.RingIn(DebugAlarmDelay.ONE_MINUTE, withCodes = true))

            val mission = wake.missions.value.single()
            assertEquals(listOf("123", "456"), mission.codes)
            assertEquals(ringAt(60), mission.ringAtEpochSeconds)
            assertTrue(DebugAlarmRules.isDebugKey(mission.key))
            assertEquals(WakeMissionRules.watchOffsets.size, mission.watchIds.size)
            assertTrue(mission.armed)
            assertTrue(device.opensWakeGuard.all { it }, "the mission and its watch alarms open the guard")
            assertEquals(
                listOf(
                    DebugAlarmRow(
                        "d1",
                        DebugAlarmKind.MISSION,
                        DebugAlarmSource.DEBUG,
                        ringAt(60),
                        DeviceAlarmPhase.SCHEDULED,
                        codeCount = 2,
                        watchCount = WakeMissionRules.watchOffsets.size,
                    ),
                ),
                vm.state.value.alarms,
            )
            assertTrue(ledger.load().isEmpty())
            vm.close()
        }

    @Test fun `a mission without a stored code is the failure and rings nothing`() = runTest(dispatcher) {
        wake.changeSettings { WakeSettings(requiresCode = true, codes = listOf("  ")) }
        val vm = viewModel()
        runCurrent()

        vm.act(DebugAlarmAction.RingIn(DebugAlarmDelay.TEN_SECONDS, withCodes = true))

        assertEquals(DebugAlarmFailure.NO_CODES, vm.state.value.failure)
        assertTrue(device.scheduledAt.isEmpty())
        vm.act(DebugAlarmAction.DismissFailure)
        assertNull(vm.state.value.failure)
        vm.close()
    }

    @Test fun `an alarm at a moment rings once and one that has passed is the failure`() = runTest(dispatcher) {
        val vm = viewModel()
        runCurrent()

        vm.act(DebugAlarmAction.RingAt(ringAt(-1), DebugAlarmRepeat.ONCE, withCodes = false))
        assertEquals(DebugAlarmFailure.IN_THE_PAST, vm.state.value.failure)
        assertTrue(device.scheduledAt.isEmpty())

        vm.act(DebugAlarmAction.RingAt(ringAt(3_600), DebugAlarmRepeat.ONCE, withCodes = false))
        assertNull(vm.state.value.failure, "an action that did what was asked ends the failure")
        assertEquals(listOf(ringAt(3_600)), device.scheduledAt)
        vm.close()
    }

    @Test fun `a daily alarm rings on every one of the next days at the time of day picked`() = runTest(dispatcher) {
        // 07:00 in Prague has passed this morning: the days from tomorrow on ring, one alarm each.
        val picked = Instant.parse("2026-11-20T06:00:00Z").epochSeconds
        val vm = viewModel()
        runCurrent()

        vm.act(DebugAlarmAction.RingAt(picked, DebugAlarmRepeat.DAILY, withCodes = false))

        assertEquals(
            (1 until vm.state.value.dailyDays).map { Instant.parse("2026-11-25T06:00:00Z").epochSeconds + it * 86_400L },
            device.scheduledAt,
        )
        assertEquals(DebugAlarmRules.DAILY_DAYS, vm.state.value.dailyDays)
        assertEquals(device.scheduledAt, vm.state.value.alarms.map { it.ringAtEpochSeconds })
        vm.close()
    }

    @Test fun `what the device refuses is the failure and the alarms before it stay`() = runTest(dispatcher) {
        val cases = mapOf(
            DeviceAlarmScheduling.Refused(DeviceAlarmFailure.NOT_AUTHORIZED) to DebugAlarmFailure.NOT_AUTHORIZED,
            DeviceAlarmScheduling.Refused(DeviceAlarmFailure.LIMIT_REACHED) to DebugAlarmFailure.LIMIT_REACHED,
            DeviceAlarmScheduling.Refused(DeviceAlarmFailure.UNSUPPORTED) to DebugAlarmFailure.UNSUPPORTED,
            DeviceAlarmScheduling.Failed to DebugAlarmFailure.DEVICE_FAILED,
        )
        val picked = Instant.parse("2026-11-26T06:00:00Z").epochSeconds
        for ((answer, failure) in cases) {
            device.scheduleAnswers = ArrayDeque(listOf(DeviceAlarmScheduling.Scheduled("first"), answer))
            ledger.save(emptyMap())
            val vm = viewModel()
            runCurrent()

            vm.act(DebugAlarmAction.RingAt(picked, DebugAlarmRepeat.DAILY, withCodes = false))

            assertEquals(failure, vm.state.value.failure)
            assertEquals(listOf("first"), ledger.load().values.toList(), "the ring before the refusal stays")
            vm.close()
            device.phases.clear()
            device.scheduledAt.clear()
        }
    }

    @Test fun `a refusal while the watch alarms are armed is the failure and the mission stays`() =
        runTest(dispatcher) {
            wake.changeSettings { WakeSettings(requiresCode = true, codes = listOf("1")) }
            device.scheduleAnswers = ArrayDeque(
                listOf(
                    DeviceAlarmScheduling.Scheduled("m"),
                    DeviceAlarmScheduling.Scheduled("w1"),
                    DeviceAlarmScheduling.Refused(DeviceAlarmFailure.LIMIT_REACHED),
                ),
            )
            val vm = viewModel()
            runCurrent()

            vm.act(DebugAlarmAction.RingIn(DebugAlarmDelay.TEN_SECONDS, withCodes = true))

            assertEquals(DebugAlarmFailure.LIMIT_REACHED, vm.state.value.failure)
            assertEquals(listOf("w1"), wake.missions.value.single().watchIds)
            assertEquals(1, vm.state.value.alarms.single().watchCount)
            vm.close()
        }

    @Test fun `an alarm is removed from the device and the ledger and a gone one is no failure`() =
        runTest(dispatcher) {
            val vm = viewModel()
            runCurrent()
            vm.act(DebugAlarmAction.RingIn(DebugAlarmDelay.ONE_MINUTE, withCodes = false))
            vm.act(DebugAlarmAction.RingIn(DebugAlarmDelay.FIVE_MINUTES, withCodes = false))

            vm.act(DebugAlarmAction.Cancel("d1"))

            assertEquals(listOf("d1"), device.cancelled)
            assertEquals(listOf("d2"), ledger.load().values.toList())
            assertEquals(listOf("d2"), vm.state.value.alarms.map { it.id })
            assertNull(vm.state.value.failure)
            vm.close()
        }

    @Test fun `a mission is removed with its watch alarms and its guard is left to see it gone`() =
        runTest(dispatcher) {
            wake.changeSettings { WakeSettings(requiresCode = true, codes = listOf("1")) }
            val vm = viewModel()
            runCurrent()
            vm.act(DebugAlarmAction.RingIn(DebugAlarmDelay.ONE_MINUTE, withCodes = true))
            val mission = wake.missions.value.single()

            vm.act(DebugAlarmAction.Cancel(mission.alarmId))

            assertEquals((listOf(mission.alarmId) + mission.watchIds).toSet(), device.cancelled.toSet())
            assertTrue(wake.missions.value.isEmpty())
            assertTrue(vm.state.value.alarms.isEmpty())
            vm.close()
        }

    @Test fun `a watch alarm removes its whole mission`() = runTest(dispatcher) {
        wake.changeSettings { WakeSettings(requiresCode = true, codes = listOf("1")) }
        val vm = viewModel()
        runCurrent()
        vm.act(DebugAlarmAction.RingIn(DebugAlarmDelay.ONE_MINUTE, withCodes = true))

        vm.act(DebugAlarmAction.Cancel(wake.missions.value.single().watchIds.first()))

        assertTrue(wake.missions.value.isEmpty())
        vm.close()
    }

    @Test fun `an alarm the device would not remove is the failure for a plain alarm and for a mission`() =
        runTest(dispatcher) {
            wake.changeSettings { WakeSettings(requiresCode = true, codes = listOf("1")) }
            val vm = viewModel()
            runCurrent()
            vm.act(DebugAlarmAction.RingIn(DebugAlarmDelay.ONE_MINUTE, withCodes = false))
            vm.act(DebugAlarmAction.RingIn(DebugAlarmDelay.FIVE_MINUTES, withCodes = true))
            val mission = wake.missions.value.single()
            device.failToCancel = setOf("d1", mission.alarmId)

            vm.act(DebugAlarmAction.Cancel("d1"))
            assertEquals(DebugAlarmFailure.DEVICE_FAILED, vm.state.value.failure)
            vm.act(DebugAlarmAction.DismissFailure)

            vm.act(DebugAlarmAction.Cancel(mission.alarmId))
            assertEquals(DebugAlarmFailure.DEVICE_FAILED, vm.state.value.failure)
            vm.close()
        }

    @Test fun `every alarm and mission is removed at once`() = runTest(dispatcher) {
        wake.changeSettings { WakeSettings(requiresCode = true, codes = listOf("1")) }
        ledger.save(mapOf("sleep:2026-11-26T05:45:00Z" to "sleep"))
        device.phases["sleep"] = DeviceAlarmPhase.SCHEDULED
        device.phases["stray"] = DeviceAlarmPhase.ALERTING
        val vm = viewModel()
        runCurrent()
        vm.act(DebugAlarmAction.RingIn(DebugAlarmDelay.ONE_MINUTE, withCodes = true))

        vm.act(DebugAlarmAction.CancelAll)

        assertTrue(device.phases.isEmpty(), "the ringing one is stopped, the others removed")
        assertTrue(ledger.load().isEmpty())
        assertTrue(wake.missions.value.isEmpty())
        assertTrue(vm.state.value.alarms.isEmpty())
        assertNull(vm.state.value.failure)
        vm.close()
    }

    @Test fun `removing every alarm forgets the ones the device would not remove and says so`() =
        runTest(dispatcher) {
            device.phases["a"] = DeviceAlarmPhase.SCHEDULED
            device.phases["b"] = DeviceAlarmPhase.SCHEDULED
            ledger.save(mapOf("sleep:2026-11-26T05:45:00Z" to "a"))
            device.failToCancel = setOf("a")
            val vm = viewModel()
            runCurrent()

            vm.act(DebugAlarmAction.CancelAll)

            assertEquals(listOf("a", "b"), device.cancelled)
            assertEquals(DebugAlarmFailure.DEVICE_FAILED, vm.state.value.failure)
            assertTrue(ledger.load().isEmpty())
            vm.close()
        }

    @Test fun `an unreadable device keeps the list and is the failure for a refresh and for removing every alarm`() =
        runTest(dispatcher) {
            device.phases["a"] = DeviceAlarmPhase.SCHEDULED
            val vm = viewModel()
            runCurrent()
            device.unreadable = true

            vm.act(DebugAlarmAction.Refresh)
            assertEquals(DebugAlarmFailure.READ_FAILED, vm.state.value.failure)
            assertEquals(listOf("a"), vm.state.value.alarms.map { it.id })
            vm.act(DebugAlarmAction.DismissFailure)

            vm.act(DebugAlarmAction.CancelAll)
            assertEquals(DebugAlarmFailure.READ_FAILED, vm.state.value.failure)
            assertTrue(device.cancelled.isEmpty())
            vm.close()
        }

    @Test fun `the alarms are listed by their moment with the unknown ones last and watch alarms inside their mission`() =
        runTest(dispatcher) {
            val early = Instant.parse("2026-11-26T05:45:00Z")
            val late = Instant.parse("2026-11-27T05:45:00Z")
            ledger.save(mapOf("sleep:$late" to "sleep", DebugAlarmRules.key(early, "x") to "debug"))
            wake.replaceMissions(
                listOf(WakeMission("sleep:2026-11-28T05:45:00Z", late.epochSeconds + 86_400, "m", listOf("1"), listOf("w"))),
            )
            for (id in listOf("unknown", "w", "m", "sleep", "debug")) device.phases[id] = DeviceAlarmPhase.SCHEDULED

            val vm = viewModel()
            runCurrent()

            assertEquals(listOf("debug", "sleep", "m", "unknown"), vm.state.value.alarms.map { it.id })
            assertEquals(
                listOf(DebugAlarmSource.DEBUG, DebugAlarmSource.SLEEP_PLAN, DebugAlarmSource.SLEEP_PLAN, DebugAlarmSource.UNKNOWN),
                vm.state.value.alarms.map { it.source },
            )
            assertEquals(1, vm.state.value.alarms[2].watchCount)
            vm.close()
        }

    @Test fun `a mission whose alarm the device no longer holds is listed without a phase`() = runTest(dispatcher) {
        wake.replaceMissions(listOf(WakeMission("debug:1:m", 1, "m", listOf("1"), listOf("w"), armed = true)))

        val vm = viewModel()
        runCurrent()

        val row = vm.state.value.alarms.single()
        assertNull(row.phase)
        assertEquals(0, row.watchCount)
        assertEquals(1, row.codeCount)
        vm.close()
    }

    @Test fun `a mission the guard ended leaves the list and a change of the codes is shown`() = runTest(dispatcher) {
        wake.changeSettings { WakeSettings(requiresCode = true, codes = listOf("1")) }
        val vm = viewModel()
        runCurrent()
        vm.act(DebugAlarmAction.RingIn(DebugAlarmDelay.ONE_MINUTE, withCodes = true))
        assertEquals(1, vm.state.value.alarms.size)

        wake.changeSettings { it.copy(codes = listOf("1", "2", "3")) }
        runCurrent()
        assertEquals(3, vm.state.value.codeCount)

        wake.finish(wake.missions.value.single().key)
        runCurrent()
        assertTrue(vm.state.value.alarms.isEmpty())
        vm.close()
    }

    @Test fun `the sleep alarm sync leaves the alarms and missions of the tool alone`() = runTest(dispatcher) {
        wake.changeSettings { WakeSettings(requiresCode = true, codes = listOf("1")) }
        val vm = viewModel()
        runCurrent()
        vm.act(DebugAlarmAction.RingIn(DebugAlarmDelay.ONE_MINUTE, withCodes = false))
        vm.act(DebugAlarmAction.RingIn(DebugAlarmDelay.FIVE_MINUTES, withCodes = true))
        val before = device.phases.keys.toSet()
        val sync = SleepAlarmSync(
            LoadSleepAlarmNights(FakeSleepRepository(sleepContent())),
            device,
            ledger,
            wake,
            now = { now },
            zone = { DEBUG_PRAGUE },
        )

        assertEquals(SleepAlarmSyncResult.SYNCED, sync.signedOut())

        assertTrue(device.cancelled.isEmpty())
        assertEquals(before, device.phases.keys.toSet())
        assertEquals(1, wake.missions.value.size)
        assertEquals(1, ledger.load().size)
        vm.close()
    }

    @Test fun `actions run one after another in the order they came and the state says that one is running`() =
        runTest(dispatcher) {
            val vm = viewModel()
            runCurrent()
            val gate = CompletableDeferred<Unit>()
            device.scheduleGate = gate

            vm.onAction(DebugAlarmAction.RingIn(DebugAlarmDelay.TEN_SECONDS, withCodes = false))
            vm.onAction(DebugAlarmAction.RingIn(DebugAlarmDelay.FIVE_MINUTES, withCodes = false))
            vm.onAction(DebugAlarmAction.RingIn(DebugAlarmDelay.ONE_MINUTE, withCodes = false))
            runCurrent()

            assertTrue(vm.state.value.busy)
            assertEquals(listOf(ringAt(10)), device.scheduledAt, "the next waits for the answer of the one before")
            gate.complete(Unit)
            runCurrent()

            assertEquals(listOf(ringAt(10), ringAt(300), ringAt(60)), device.scheduledAt)
            assertFalse(vm.state.value.busy)
            vm.close()
        }

    @Test fun `an action after the screen closed does nothing and closing ends what runs`() = runTest(dispatcher) {
        val vm = viewModel()
        runCurrent()
        vm.close()

        vm.onAction(DebugAlarmAction.RingIn(DebugAlarmDelay.TEN_SECONDS, withCodes = false))
        vm.onAction(DebugAlarmAction.CancelAll)
        vm.onAction(DebugAlarmAction.RequestAuthorization)
        runCurrent()

        assertTrue(device.scheduledAt.isEmpty())
        assertTrue(device.cancelled.isEmpty())
        assertEquals(0, device.authorizationRequests)
        assertFalse(vm.state.value.busy)
    }

    @Test fun `closing while the device has not answered ends the action quietly`() = runTest(dispatcher) {
        val vm = viewModel()
        runCurrent()
        device.scheduleGate = CompletableDeferred()
        vm.onAction(DebugAlarmAction.RingIn(DebugAlarmDelay.TEN_SECONDS, withCodes = false))
        runCurrent()

        vm.close()
        runCurrent()

        assertNull(vm.state.value.failure)
        assertFalse(vm.state.value.busy)
    }
}
