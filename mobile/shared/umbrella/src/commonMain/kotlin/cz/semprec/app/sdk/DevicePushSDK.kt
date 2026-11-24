package cz.semprec.app.sdk

import cz.semprec.app.core.InMemoryPushSubscriptionStorage
import cz.semprec.app.core.InMemorySessionStorage
import cz.semprec.app.core.PushSubscriptionStorage
import cz.semprec.app.core.SessionStorage
import cz.semprec.app.data.ApiClient
import cz.semprec.app.data.AuthenticatedApi
import cz.semprec.app.data.HttpAccountNotificationRepository
import cz.semprec.app.data.HttpPushRepository
import cz.semprec.app.data.HttpSleepRepository
import cz.semprec.app.presentation.DeviceNotifications
import cz.semprec.app.presentation.DeviceNotificationsFactory
import cz.semprec.app.presentation.DeviceSleepAlarms
import cz.semprec.app.presentation.DeviceSleepAlarmsFactory

/**
 * The notifications of the whole process rather than of one window: the APNs token, the reminders the device
 * schedules, the icon's number and the sleep plan's alarms the device rings. The app creates one per process. Its calls go out with the session in
 * [sessionStorage], the same store every window's [HomeSDK] signs in to. A rejected session is left for the windows
 * to notice; this SDK signs no one out. [subscriptions] is shared with the windows' [HomeSDK], whose sign-out revokes
 * the subscription it holds.
 */
class DevicePushSDK(
    sessionStorage: SessionStorage = InMemorySessionStorage(),
    subscriptions: PushSubscriptionStorage = InMemoryPushSubscriptionStorage(),
) {
    private val api = AuthenticatedApi(ApiClient(), sessionStorage, onSessionRejected = {})

    val notifications: DeviceNotifications = DeviceNotificationsFactory(
        HttpPushRepository(api),
        HttpAccountNotificationRepository(api),
        subscriptions,
    ).deviceNotifications()

    /** The sleep plan's alarms the device rings itself, read with the same session. */
    val sleepAlarms: DeviceSleepAlarms = DeviceSleepAlarmsFactory(HttpSleepRepository(api)).deviceSleepAlarms()
}
