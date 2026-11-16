package cz.semprec.app.data

import cz.semprec.app.domain.CalendarEntryKind
import cz.semprec.app.domain.CalendarInfo
import cz.semprec.app.domain.CalendarInvitation
import cz.semprec.app.domain.CalendarKind
import cz.semprec.app.domain.InvitationKind
import cz.semprec.app.domain.InvitationStatus
import cz.semprec.app.domain.Schedule
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull

/** A calendar from its stored item; a calendar without a name or colour is not one the app can show. */
internal fun CalendarStoredItem.toCalendar(): CalendarInfo? {
    val name = properties.text("name")
    val color = properties.text("color")
    if (name == null || color == null) return null
    val system = properties.text("systemKey")
    val kind = when (properties.text("kind")) {
        "system" -> CalendarKind.SYSTEM
        "subscription" -> CalendarKind.SUBSCRIPTION
        else -> if (system != null) CalendarKind.SYSTEM else CalendarKind.OWN
    }
    return CalendarInfo(
        id = id,
        name = name,
        color = color,
        notify = properties.flag("notify"),
        hidden = properties.flag("hidden"),
        isDefault = properties.flag("isDefault"),
        kind = kind,
        systemKey = system,
        updatedAt = updatedAt,
    )
}

/** An invitation from its stored item; one without a title or a known status is skipped. */
internal fun CalendarStoredItem.toInvitation(): CalendarInvitation? {
    val title = properties.text("title")
    val status = properties.text("status")?.toInvitationStatus()
    if (title == null || status == null) return null
    val kind = if (properties.text("kind") == "sharedCalendarNotice") {
        InvitationKind.SHARED_CALENDAR_NOTICE
    } else {
        InvitationKind.INVITE
    }
    return CalendarInvitation(
        id = id,
        kind = kind,
        status = status,
        title = title,
        startsAt = properties.text("startsAt"),
        endsAt = properties.text("endsAt"),
        timeZone = properties.text("timeZone"),
        allDay = properties.flag("allDay"),
        place = properties.text("place"),
        organizerName = properties.text("organizerName"),
        organizerEmail = properties.text("organizerEmail"),
    )
}

private fun String.toInvitationStatus(): InvitationStatus? = when (this) {
    "pending" -> InvitationStatus.PENDING
    "accepted" -> InvitationStatus.ACCEPTED
    "tentative" -> InvitationStatus.TENTATIVE
    "declined" -> InvitationStatus.DECLINED
    "acknowledged" -> InvitationStatus.ACKNOWLEDGED
    "cancelled" -> InvitationStatus.CANCELLED
    else -> null
}

private fun JsonObject.text(key: String): String? =
    (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull?.takeIf { it.isNotEmpty() }

private fun JsonObject.flag(key: String): Boolean = (this[key] as? JsonPrimitive)?.booleanOrNull ?: false

/**
 * The values a patch writes for a schedule: `null` clears a time or the last day. A task has no last day, so it
 * never gets that key.
 */
internal fun Schedule.toProperties(kind: CalendarEntryKind): JsonObject = buildJsonObject {
    put("date", JsonPrimitive(date.toString()))
    if (kind == CalendarEntryKind.EVENT) put("endDate", endDate?.let { JsonPrimitive(it.toString()) } ?: JsonNull)
    put("timeFrom", timeFrom?.let { JsonPrimitive(it.toString()) } ?: JsonNull)
    put("timeTo", timeTo?.let { JsonPrimitive(it.toString()) } ?: JsonNull)
}
