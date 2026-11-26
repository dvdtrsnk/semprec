package cz.semprec.app.sdk

import cz.semprec.app.core.DeviceAlarms
import cz.semprec.app.core.InMemoryPushSubscriptionStorage
import cz.semprec.app.core.InMemorySessionStorage
import cz.semprec.app.core.InMemorySleepAlarmLedger
import cz.semprec.app.core.InMemoryWakeStorage
import cz.semprec.app.core.PushSubscriptionStorage
import cz.semprec.app.core.SessionStorage
import cz.semprec.app.core.SleepAlarmLedger
import cz.semprec.app.core.UnavailableDeviceAlarms
import cz.semprec.app.core.WakeStorage
import cz.semprec.app.data.ApiClient
import cz.semprec.app.data.AuthenticatedApi
import cz.semprec.app.data.HttpAccountNotificationRepository
import cz.semprec.app.data.HttpPushRepository
import cz.semprec.app.data.HttpSleepRepository
import cz.semprec.app.presentation.DebugAlarms
import cz.semprec.app.presentation.DebugAlarmsFactory
import cz.semprec.app.presentation.DeviceNotifications
import cz.semprec.app.presentation.DeviceNotificationsFactory
import cz.semprec.app.presentation.SleepAlarmSync
import cz.semprec.app.presentation.SleepAlarmSyncFactory
import cz.semprec.app.presentation.WakeMissions

/**
 * The notifications of the whole process rather than of one window: the APNs token, the reminders the device
 * schedules, the icon's number and the system alarms of the sleep plan, which [alarms] rings and [sleepAlarmLedger]
 * and [wakeStorage] keep track of. The app creates one per process. Its calls go out with the session in
 * [sessionStorage], the same store every window's [HomeSDK] signs in to. A rejected session is left for the windows
 * to notice; this SDK signs no one out. [subscriptions] is shared with the windows' [HomeSDK], whose sign-out revokes
 * the subscription it holds.
 */
class DevicePushSDK(
    sessionStorage: SessionStorage = InMemorySessionStorage(),
    subscriptions: PushSubscriptionStorage = InMemoryPushSubscriptionStorage(),
    alarms: DeviceAlarms = UnavailableDeviceAlarms(),
    sleepAlarmLedger: SleepAlarmLedger = InMemorySleepAlarmLedger(),
    wakeStorage: WakeStorage = InMemoryWakeStorage(),
) {
    private val api = AuthenticatedApi(ApiClient(), sessionStorage, onSessionRejected = {})

    val notifications: DeviceNotifications = DeviceNotificationsFactory(
        HttpPushRepository(api),
        HttpAccountNotificationRepository(api),
        subscriptions,
    ).deviceNotifications()

    /** The wake settings and missions of this device, which every window's [HomeSDK] is given to guard them. */
    val wake: WakeMissions = WakeMissions(wakeStorage, alarms)

    val sleepAlarms: SleepAlarmSync = SleepAlarmSyncFactory(HttpSleepRepository(api), alarms, sleepAlarmLedger, wake)
        .sleepAlarmSync()

    /** The alarms of the debug tool, which ring through the same [alarms], ledger and missions as the sleep alarms. */
    val debugAlarms: DebugAlarms = DebugAlarmsFactory(alarms, sleepAlarmLedger, wake).debugAlarms()
}
