package cz.alldots.app.data

import cz.alldots.app.domain.CalendarDay
import cz.alldots.app.domain.ClockTime
import cz.alldots.app.domain.JournalBirthday
import cz.alldots.app.domain.JournalEvent
import cz.alldots.app.domain.JournalInboxEntry
import cz.alldots.app.domain.JournalPeriod
import cz.alldots.app.domain.JournalPeriodPage
import cz.alldots.app.domain.JournalQuarterPage
import cz.alldots.app.domain.JournalWeekPage
import kotlinx.serialization.Serializable

private val WEEK_NUMBER = Regex("-W(\\d{2})$")
private val QUARTER_NUMBER = Regex("-Q([1-4])$")

@Serializable
internal data class JournalRangeDto(val from: String, val to: String)

@Serializable
internal data class JournalItemDto(val id: String)

@Serializable
internal data class JournalWeekDto(
    val period: String,
    val range: JournalRangeDto,
    val itemId: String? = null,
    val markdown: String? = null,
) {
    fun toDomain(): JournalWeekPage? {
        val number = WEEK_NUMBER.find(period)?.groupValues?.get(1)?.toIntOrNull()
        val from = CalendarDay.parse(range.from)
        val to = CalendarDay.parse(range.to)
        return if (number != null && from != null && to != null) {
            JournalWeekPage(period, number, from, to, itemId, markdown)
        } else {
            null
        }
    }
}

@Serializable
internal data class JournalQuarterDto(
    val period: String,
    val range: JournalRangeDto,
    val itemId: String? = null,
    val markdown: String? = null,
) {
    fun toDomain(): JournalQuarterPage? {
        val number = QUARTER_NUMBER.find(period)?.groupValues?.get(1)?.toIntOrNull()
        val from = CalendarDay.parse(range.from)
        val to = CalendarDay.parse(range.to)
        return if (number != null && from != null && to != null) {
            JournalQuarterPage(period, number, from, to, itemId, markdown)
        } else {
            null
        }
    }
}

@Serializable
internal data class JournalProjectDto(val name: String, val color: String? = null)

@Serializable
internal data class JournalTranscriptDto(val id: String)

@Serializable
internal data class JournalEventDto(
    val id: String,
    val title: String,
    val timeFrom: String? = null,
    val timeTo: String? = null,
    val allDay: Boolean = false,
    val place: String? = null,
    val project: JournalProjectDto? = null,
    val transcript: JournalTranscriptDto? = null,
) {
    fun toDomain(): JournalEvent = JournalEvent(
        id = id,
        title = title,
        timeFrom = timeFrom?.let(ClockTime::parse),
        timeTo = timeTo?.let(ClockTime::parse),
        allDay = allDay,
        place = place?.takeIf { it.isNotBlank() },
        projectName = project?.name,
        projectColor = project?.color,
        hasTranscript = transcript != null,
    )
}

@Serializable
internal data class JournalBirthdayDto(val id: String, val personName: String) {
    fun toDomain(): JournalBirthday = JournalBirthday(id, personName)
}

@Serializable
internal data class JournalInboxTypeDto(val emoji: String? = null)

@Serializable
internal data class JournalInboxDto(
    val id: String,
    val time: String? = null,
    val text: String? = null,
    val type: JournalInboxTypeDto? = null,
    val status: String? = null,
    val processing: String? = null,
    val attachments: List<InboxAttachmentDto> = emptyList(),
) {
    fun toDomain(): JournalInboxEntry = JournalInboxEntry(
        id = id,
        time = time,
        text = text?.takeIf { it.isNotBlank() },
        typeEmoji = type?.emoji,
        status = status,
        processing = processing,
        attachments = if (status == WAITING_INBOX_STATUS) {
            attachments.map { it.toWaitingAttachment(id) }
        } else {
            attachments.mapNotNull { it.toServerAttachment() }
        },
    )
}

/** `GET /api/journal/periods/{type}/{period}` (backend `journalRouteHandlers.ts`); fields a period lacks are absent. */
@Serializable
internal data class JournalPeriodResponse(
    val period: String,
    val range: JournalRangeDto,
    val today: String,
    val item: JournalItemDto? = null,
    val markdown: String? = null,
    val week: JournalWeekDto? = null,
    val weeks: List<JournalWeekDto> = emptyList(),
    val quarters: List<JournalQuarterDto> = emptyList(),
    val inbox: List<JournalInboxDto> = emptyList(),
    val events: List<JournalEventDto> = emptyList(),
    val birthdays: List<JournalBirthdayDto> = emptyList(),
) {
    /** The domain page, or `null` when a date, a week or a quarter of the answer cannot be read. */
    fun toDomain(requested: JournalPeriod): JournalPeriodPage? {
        val dates = dates()
        val given = listOfNotNull(week) + weeks
        val weekPages = given.mapNotNull { it.toDomain() }.takeIf { it.size == given.size }
        val quarterPages = quarters.mapNotNull { it.toDomain() }.takeIf { it.size == quarters.size }
        return if (dates != null && weekPages != null && quarterPages != null) {
            JournalPeriodPage(
                period = JournalPeriod(requested.type, period),
                from = dates.first,
                to = dates.second,
                today = dates.third,
                itemId = item?.id,
                markdown = markdown,
                weeks = weekPages,
                quarters = quarterPages,
                inbox = inbox.map { it.toDomain() },
                events = events.map { it.toDomain() },
                birthdays = birthdays.map { it.toDomain() },
            )
        } else {
            null
        }
    }

    private fun dates(): Triple<CalendarDay, CalendarDay, CalendarDay>? {
        val from = CalendarDay.parse(range.from)
        val to = CalendarDay.parse(range.to)
        val todayDay = CalendarDay.parse(today)
        return if (from != null && to != null && todayDay != null) Triple(from, to, todayDay) else null
    }
}

@Serializable
internal data class JournalEnsureResponse(val itemId: String)
