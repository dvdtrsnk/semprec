package cz.semprec.app.core

/** The kinds of result global search groups its answer by, in the order the backend lists them. */
enum class SearchGroupType { TASK, EVENT, PROJECT, CONTACT, JOURNAL, FILE, MAIL, CHAT }

/** The kinds of piece a search result's subtitle is made of; the app composes the text of each natively. */
enum class SearchSubtitleKind {
    DATE,
    TIME,
    TIME_RANGE,
    PLACE,
    RECURRENCE,
    PROJECT,
    PEOPLE,
    PHONE,
    RELATIONSHIP,
    STATUS,
    SENDER,
    MOVED_FROM,
    MISSED_IN_EVENT,
}
