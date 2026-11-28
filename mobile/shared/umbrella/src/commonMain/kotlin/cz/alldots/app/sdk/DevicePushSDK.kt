package cz.alldots.app.sdk

import cz.alldots.app.core.DeviceAlarms
import cz.alldots.app.core.InMemoryPushSubscriptionStorage
import cz.alldots.app.core.InMemorySessionStorage
import cz.alldots.app.core.InMemorySleepAlarmLedger
import cz.alldots.app.core.InMemoryWakeStorage
import cz.alldots.app.core.PushSubscriptionStorage
import cz.alldots.app.core.SessionStorage
import cz.alldots.app.core.SleepAlarmLedger
import cz.alldots.app.core.UnavailableDeviceAlarms
import cz.alldots.app.core.WakeStorage
import cz.alldots.app.data.ApiClient
import cz.alldots.app.data.AuthenticatedApi
import cz.alldots.app.data.HttpAccountNotificationRepository
import cz.alldots.app.data.HttpPushRepository
import cz.alldots.app.data.HttpSleepRepository
import cz.alldots.app.presentation.DebugAlarms
import cz.alldots.app.presentation.DebugAlarmsFactory
import cz.alldots.app.presentation.DeviceNotifications
import cz.alldots.app.presentation.DeviceNotificationsFactory
import cz.alldots.app.presentation.SleepAlarmSync
import cz.alldots.app.presentation.SleepAlarmSyncFactory
import cz.alldots.app.presentation.WakeMissions

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
