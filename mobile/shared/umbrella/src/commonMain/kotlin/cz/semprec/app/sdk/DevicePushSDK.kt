package cz.semprec.app.sdk

import cz.semprec.app.core.DeviceAlarms
import cz.semprec.app.core.InMemoryPushSubscriptionStorage
import cz.semprec.app.core.InMemorySessionStorage
import cz.semprec.app.core.InMemorySleepAlarmLedger
import cz.semprec.app.core.PushSubscriptionStorage
import cz.semprec.app.core.SessionStorage
import cz.semprec.app.core.SleepAlarmLedger
import cz.semprec.app.core.UnavailableDeviceAlarms
import cz.semprec.app.data.ApiClient
import cz.semprec.app.data.AuthenticatedApi
import cz.semprec.app.data.HttpAccountNotificationRepository
import cz.semprec.app.data.HttpPushRepository
import cz.semprec.app.data.HttpSleepRepository
import cz.semprec.app.presentation.DeviceNotifications
import cz.semprec.app.presentation.DeviceNotificationsFactory
import cz.semprec.app.presentation.SleepAlarmSync
import cz.semprec.app.presentation.SleepAlarmSyncFactory

/**
 * The notifications of the whole process rather than of one window: the APNs token, the reminders the device
 * schedules, the icon's number and the system alarms of the sleep plan, which [alarms] rings and [sleepAlarmLedger]
 * keeps track of. The app creates one per process. Its calls go out with the session in
 * [sessionStorage], the same store every window's [HomeSDK] signs in to. A rejected session is left for the windows
 * to notice; this SDK signs no one out. [subscriptions] is shared with the windows' [HomeSDK], whose sign-out revokes
 * the subscription it holds.
 */
class DevicePushSDK(
    sessionStorage: SessionStorage = InMemorySessionStorage(),
    subscriptions: PushSubscriptionStorage = InMemoryPushSubscriptionStorage(),
    alarms: DeviceAlarms = UnavailableDeviceAlarms(),
    sleepAlarmLedger: SleepAlarmLedger = InMemorySleepAlarmLedger(),
) {
    private val api = AuthenticatedApi(ApiClient(), sessionStorage, onSessionRejected = {})

    val notifications: DeviceNotifications = DeviceNotificationsFactory(
        HttpPushRepository(api),
        HttpAccountNotificationRepository(api),
        subscriptions,
    ).deviceNotifications()

    val sleepAlarms: SleepAlarmSync = SleepAlarmSyncFactory(HttpSleepRepository(api), alarms, sleepAlarmLedger)
        .sleepAlarmSync()
}
