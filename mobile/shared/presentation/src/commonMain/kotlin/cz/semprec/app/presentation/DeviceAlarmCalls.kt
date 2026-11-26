package cz.semprec.app.presentation

import cz.semprec.app.core.DeviceAlarmAuthorization
import cz.semprec.app.core.DeviceAlarmScheduling
import cz.semprec.app.core.DeviceAlarms
import cz.semprec.app.core.HeldDeviceAlarm
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlin.coroutines.resume

/*
 * The calls of the device's alarms as suspending functions, for the two services that use them: the sleep alarm sync
 * and the debug alarm tool. Each device call and each of its answers is on the main thread, which `onDevice` is.
 *
 * A call the device has taken cannot be recalled when its caller is cancelled: the continuation drops the late answer,
 * so an alarm rung meanwhile is one that neither the ledger nor the missions know. That is intended, and no handler
 * on cancellation would change it: the next sleep alarm sync removes the alarms it does not know, unless one rings.
 */

/** Rings one alarm at [ringAtEpochSeconds] and answers what the device said. */
internal suspend fun DeviceAlarms.ring(ringAtEpochSeconds: Long, opensWakeGuard: Boolean): DeviceAlarmScheduling =
    suspendCancellableCoroutine { answer -> schedule(ringAtEpochSeconds, opensWakeGuard) { answer.resume(it) } }

/** The alarms the device holds, or `null` when it could not read them. */
internal suspend fun DeviceAlarms.heldAlarms(): List<HeldDeviceAlarm>? =
    suspendCancellableCoroutine { answer -> held { answer.resume(it) } }

/** What the person decided about allowing alarms, asked for when never asked. */
internal suspend fun DeviceAlarms.askForAuthorization(): DeviceAlarmAuthorization =
    suspendCancellableCoroutine { answer -> requestAuthorization { answer.resume(it) } }

/** Runs [call] on the main thread, which every call of the device and every answer of it is on. */
internal suspend fun <T> onDevice(call: suspend () -> T): T = withContext(Dispatchers.Main) { call() }
