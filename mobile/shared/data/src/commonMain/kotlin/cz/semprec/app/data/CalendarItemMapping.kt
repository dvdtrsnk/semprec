package cz.semprec.app.data

import cz.semprec.app.domain.CalendarEntryKind
import cz.semprec.app.domain.CalendarInfo
import cz.semprec.app.domain.CalendarInvitation
import cz.semprec.app.domain.CalendarKind
import cz.semprec.app.domain.CalendarSchedule
import cz.semprec.app.domain.InvitationKind
import cz.semprec.app.domain.InvitationStatus
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull

/**
 * A calendar from its stored item. A calendar of an internet account may leave its name and colour empty, which means
 * the provider's; any other calendar without a name or colour is not one the app can show, nor is an account calendar
 * without any name. The account is the first target of the expanded `account` relation.
 */
internal fun CalendarStoredItem.toCalendar(): CalendarInfo? {
    val system = properties.calendarText("systemKey")
    val kind = when (properties.calendarText("kind")) {
        "system" -> CalendarKind.SYSTEM
        "subscription" -> CalendarKind.SUBSCRIPTION
        "account" -> CalendarKind.ACCOUNT
        else -> if (system != null) CalendarKind.SYSTEM else CalendarKind.OWN
    }
    val remoteName = properties.calendarText("remoteName")
    val remoteColor = properties.calendarText("remoteColor")
    val ownColor = properties.calendarText("color")
    val isAccount = kind == CalendarKind.ACCOUNT
    val name = properties.calendarText("name") ?: remoteName.takeIf { isAccount }
    val color = ownColor ?: (remoteColor ?: ACCOUNT_FALLBACK_COLOR).takeIf { isAccount }
    if (name == null || color == null) return null
    return CalendarInfo(
        id = id,
        name = name,
        color = color,
        notify = properties.calendarFlag("notify"),
        hidden = properties.calendarFlag("hidden"),
        isDefault = properties.calendarFlag("isDefault"),
        kind = kind,
        systemKey = system,
        version = version,
        accountId = relations[ACCOUNT_RELATION]?.firstOrNull()?.id.takeIf { isAccount },
        readOnly = isAccount && properties.calendarFlag("readOnly"),
        remoteName = remoteName.takeIf { isAccount },
        remoteColor = remoteColor.takeIf { isAccount },
        usesRemoteColor = isAccount && ownColor == null,
    )
}

/** The relation of the Calendars database that names the internet account a synced calendar belongs to. */
internal const val ACCOUNT_RELATION = "account"

/** The colour of an account calendar for which neither the person nor the provider chose one. */
private const val ACCOUNT_FALLBACK_COLOR = "#8E8E93"

/** An invitation from its stored item; one without a title or a known status is skipped. */
internal fun CalendarStoredItem.toInvitation(): CalendarInvitation? {
    val title = properties.calendarText("title")
    val status = properties.calendarText("status")?.toInvitationStatus()
    if (title == null || status == null) return null
    val kind = if (properties.calendarText("kind") == "sharedCalendarNotice") {
        InvitationKind.SHARED_CALENDAR_NOTICE
    } else {
        InvitationKind.INVITE
    }
    return CalendarInvitation(
        id = id,
        kind = kind,
        status = status,
        title = title,
        startsAt = properties.calendarText("startsAt"),
        endsAt = properties.calendarText("endsAt"),
        timeZone = properties.calendarText("timeZone"),
        allDay = properties.calendarFlag("allDay"),
        place = properties.calendarText("place"),
        organizerName = properties.calendarText("organizerName"),
        organizerEmail = properties.calendarText("organizerEmail"),
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

private fun JsonObject.calendarText(key: String): String? =
    (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull?.takeIf { it.isNotEmpty() }

private fun JsonObject.calendarFlag(key: String): Boolean = (this[key] as? JsonPrimitive)?.booleanOrNull ?: false

/**
 * The values a patch writes for a schedule: `null` clears a time or the last day. A task has no last day, so it
 * never gets that key.
 */
internal fun CalendarSchedule.toProperties(kind: CalendarEntryKind): JsonObject = buildJsonObject {
    put("date", JsonPrimitive(date.toString()))
    if (kind == CalendarEntryKind.EVENT) put("endDate", endDate?.let { JsonPrimitive(it.toString()) } ?: JsonNull)
    put("timeFrom", timeFrom?.let { JsonPrimitive(it.toString()) } ?: JsonNull)
    put("timeTo", timeTo?.let { JsonPrimitive(it.toString()) } ?: JsonNull)
}
