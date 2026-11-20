package cz.semprec.app.core

/**
 * The APNs environment a device token belongs to; [wireName] is what `POST /api/push-subscriptions` accepts. A
 * development build gets its tokens from the sandbox, a distributed build from production.
 */
enum class ApnsEnvironment(val wireName: String) { SANDBOX("sandbox"), PRODUCTION("production") }

/**
 * Where the id of this device's push subscription survives a restart, so that signing out can revoke it. [save]
 * with `null` forgets it.
 */
interface PushSubscriptionStorage {
    fun load(): String?
    fun save(subscriptionId: String?)
}

/** A [PushSubscriptionStorage] that forgets the id with the process; the default where no store is wired. */
class InMemoryPushSubscriptionStorage : PushSubscriptionStorage {
    private var current: String? = null

    override fun load(): String? = current

    override fun save(subscriptionId: String?) {
        current = subscriptionId
    }
}
