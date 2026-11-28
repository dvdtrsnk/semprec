package cz.alldots.app.presentation

import cz.alldots.app.core.PushSubscriptionStorage
import cz.alldots.app.domain.AccountNotificationRepository
import cz.alldots.app.domain.LoadAppBadge
import cz.alldots.app.domain.LoadDeviceReminders
import cz.alldots.app.domain.PushRepository
import cz.alldots.app.domain.RegisterPushSubscription
import kotlin.experimental.ExperimentalObjCRefinement
import kotlin.native.HiddenFromObjC

/**
 * Creates [DeviceNotifications], whose constructor is internal, for the SDK in the umbrella module. Hidden from
 * Objective-C and Swift so that the domain ports it takes stay out of the exported native API.
 */
@OptIn(ExperimentalObjCRefinement::class)
@HiddenFromObjC
class DeviceNotificationsFactory(
    private val push: PushRepository,
    private val preferences: AccountNotificationRepository,
    private val subscriptions: PushSubscriptionStorage,
) {
    fun deviceNotifications(): DeviceNotifications = DeviceNotifications(
        RegisterPushSubscription(push, subscriptions),
        LoadDeviceReminders(push, preferences),
        LoadAppBadge(push, preferences),
    )
}
