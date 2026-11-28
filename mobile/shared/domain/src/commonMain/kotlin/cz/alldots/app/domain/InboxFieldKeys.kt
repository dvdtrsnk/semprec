package cz.alldots.app.domain

/**
 * What the editor of a card reads. The effective proposal holds the values of the destination; the fields that are no
 * property of it (an all-day switch, the follow-up task, the page a text goes to) have their own
 * place, which this file knows, so that no screen has to.
 */
object InboxFieldKeys {
    const val ALL_DAY = "allDay"
    const val FOLLOWUP_TASK = "followupTask"
    const val FOLLOW_DATE = "followDate"
    const val PAGE = "page"
    const val DAY = "day"
    const val TIME_FROM = "timeFrom"
    const val DATE = "date"
    const val MARKDOWN = "markdown"
    const val NAME = "name"
    const val EVENT_ID = "eventId"
    const val PROJECT_ID = "projectId"
    const val NO_EVENT = "noEvent"
    const val LANGUAGE = "language"
    const val CREDENTIAL = "credential"
    const val FILE = "file"
    const val TASKS_DATABASE = "tasks"
}

/** The fields the app declares itself, for the cards whose choice the server does not describe as an editor schema. */
object InboxChoiceKeys {
    /** The person a speaker is. */
    const val WHO = "who"

    /** The event a recording belongs to. */
    const val MATCH = "match"

    /** The type a card that needs clarification becomes. */
    const val TYPE = "type"
}

/** The language option that means "let the server recognize it". */
const val AUTO_LANGUAGE = "auto"
