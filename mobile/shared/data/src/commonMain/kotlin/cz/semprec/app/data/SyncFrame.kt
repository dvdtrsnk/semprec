package cz.semprec.app.data

import cz.semprec.app.domain.SyncTopic
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject

/**
 * The frames of `WS /api/sync` that a screen of the app follows. The server's catalog has more (documents, Semp
 * threads, agent runs, badge counts); those are dropped here, as is anything outside the catalog.
 */
internal sealed interface SyncFrame {
    /** An `invalidate` frame of scope `item` or `relation`: an item of [databaseId], or one of its links, changed. */
    data class DatabaseChanged(val databaseId: String) : SyncFrame

    /** A `notification` frame: a notification of [kind] was created or read for this person. */
    data class Notified(val kind: String) : SyncFrame
}

/** The databases, by canonical key, whose changes each topic follows. */
private val TOPICS_BY_DATABASE_KEY: Map<String, Set<SyncTopic>> = mapOf(
    "calendars" to setOf(SyncTopic.CALENDAR),
    "events" to setOf(SyncTopic.CALENDAR),
    "tasks" to setOf(SyncTopic.CALENDAR),
    "invitations" to setOf(SyncTopic.INVITATIONS),
    "mailboxes" to setOf(SyncTopic.MAIL_ACCOUNTS),
    "folders" to setOf(SyncTopic.MAIL_ACCOUNTS),
    "emails" to setOf(SyncTopic.MAIL_ACCOUNTS),
)

/** The notification kinds of the server whose arrival each topic follows. */
private val TOPICS_BY_NOTIFICATION_KIND: Map<String, Set<SyncTopic>> = mapOf(
    "calendar_invitation" to setOf(SyncTopic.INVITATIONS),
    "calendar_event_added" to setOf(SyncTopic.CALENDAR),
    "calendar_event_changed" to setOf(SyncTopic.CALENDAR),
    "calendar_event_cancelled" to setOf(SyncTopic.CALENDAR),
    "calendar_change_overwritten" to setOf(SyncTopic.CALENDAR),
    "mail_sync_error" to setOf(SyncTopic.MAIL_ACCOUNTS),
    "mail_sync_stalled" to setOf(SyncTopic.MAIL_ACCOUNTS),
)

private val ITEM_OPS = setOf("create", "update", "delete")
private val RELATION_OPS = setOf("put", "delete", "metadata")

/**
 * The topics this frame raises. [databaseKeys] maps database ids to canonical keys; without it (the schema could not
 * be read) a database change raises every topic, so no screen misses one.
 */
internal fun SyncFrame.topics(databaseKeys: Map<String, String>?): Set<SyncTopic> = when (this) {
    is SyncFrame.DatabaseChanged ->
        if (databaseKeys == null) {
            SyncTopic.entries.toSet()
        } else {
            databaseKeys[databaseId]?.let { TOPICS_BY_DATABASE_KEY[it] }.orEmpty()
        }
    is SyncFrame.Notified -> TOPICS_BY_NOTIFICATION_KIND[kind].orEmpty()
}

/**
 * Parses one text frame of the server with the field checks of the web client's `parseServerFrame` for the frames
 * kept here. Returns `null` for anything else, which the caller drops without breaking the connection.
 */
internal fun parseSyncFrame(raw: String): SyncFrame? {
    val root = try {
        ApiJson.parseToJsonElement(raw) as? JsonObject
    } catch (_: SerializationException) {
        null
    }
    return root?.let(::frameOf)
}

private fun frameOf(root: JsonObject): SyncFrame? =
    when (root.text("type")) {
        "invalidate" -> when (root.text("scope")) {
            "item" -> itemFrame(root)
            "relation" -> relationFrame(root)
            else -> null
        }
        "notification" -> (root["notification"] as? JsonObject)?.let(::notificationFrame)
        else -> null
    }

private fun itemFrame(frame: JsonObject): SyncFrame? {
    val databaseId = frame.text("databaseId") ?: return null
    val valid = frame.text("itemId") != null && frame.text("updatedAt") != null && frame.text("op") in ITEM_OPS
    return if (valid) SyncFrame.DatabaseChanged(databaseId) else null
}

private fun relationFrame(frame: JsonObject): SyncFrame? {
    val databaseId = frame.text("databaseId") ?: return null
    val propertyKey = frame["propertyKey"]
    val valid = frame.text("itemId") != null &&
        (propertyKey is JsonNull || frame.text("propertyKey") != null) &&
        frame.text("op") in RELATION_OPS
    return if (valid) SyncFrame.DatabaseChanged(databaseId) else null
}

private fun notificationFrame(notification: JsonObject): SyncFrame? {
    val kind = notification.text("kind") ?: return null
    val valid = notification.text("id") != null && notification.text("userId") != null
    return if (valid) SyncFrame.Notified(kind) else null
}
