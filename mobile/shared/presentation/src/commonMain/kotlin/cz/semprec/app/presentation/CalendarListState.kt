package cz.semprec.app.presentation

import cz.semprec.app.core.FailureKind

enum class CalendarListPhase { LOADING, CONTENT, ERROR }

/** Where a calendar comes from, which decides what can be done with it. */
enum class CalendarGroup { OWN, SYSTEM, SUBSCRIPTION, ACCOUNT }

/** A colour a calendar can take; [key] names it for the copy, [hex] is `#RRGGBB`. */
data class CalendarSwatch(val key: String, val hex: String)

/**
 * A calendar of the list. [systemKey] is `tasks`, `birthdays`, `sleep` or `holidaysCz` for a calendar Semprec fills.
 * A calendar of the [CalendarGroup.ACCOUNT] group belongs to the section [accountId] (empty when the server did not
 * say which account; `null` for every other group) and carries the provider's [remoteName] and [remoteColor]; [usesRemoteColor] says its colour is the provider's. A
 * [readOnly] calendar takes no new events.
 */
data class CalendarRow(
    val id: String,
    val name: String,
    val color: String,
    val hidden: Boolean,
    val notify: Boolean,
    val group: CalendarGroup,
    val systemKey: String?,
    val isDefault: Boolean,
    val canRename: Boolean,
    val canDelete: Boolean,
    val accountId: String?,
    val readOnly: Boolean,
    val remoteName: String?,
    val remoteColor: String?,
    val usesRemoteColor: Boolean,
)

/**
 * An internet account whose calendars the list shows, in the order of the sections. [name] and [provider] (`gmail`,
 * `outlook`, `icloud`, `imap`) are `null` when the accounts could not be read or the account is not among them;
 * [status] is then `null` too.
 */
data class CalendarAccountSection(
    val id: String,
    val name: String?,
    val provider: String?,
    val status: InternetServiceStatus?,
)

/** What deleting a calendar would cancel; shown before the delete is confirmed. */
data class CalendarImpact(
    val calendarId: String,
    val eventCount: Int,
    val recipientCount: Int,
    val cancellationCount: Int,
)

/**
 * The calendars sheet. [accounts] are the internet accounts of the [CalendarGroup.ACCOUNT] calendars, one section
 * each. [detailId] is the calendar whose settings are open, or `null` for the list. [impact] is the delete waiting for
 * a confirmation once its consequences are known.
 */
data class CalendarListState(
    val phase: CalendarListPhase,
    val failure: FailureKind?,
    val calendars: List<CalendarRow>,
    val accounts: List<CalendarAccountSection>,
    val swatches: List<CalendarSwatch>,
    val detailId: String?,
    val impact: CalendarImpact?,
    val busy: Boolean,
    val problem: Boolean,
    val problemFailure: FailureKind?,
)

sealed interface CalendarListAction {
    data object Retry : CalendarListAction

    /** Pulled to refresh: reads the list again and asks the server to sync the internet accounts' calendars. */
    data object Refresh : CalendarListAction

    /** Hides every calendar, or shows every calendar. */
    data class SetAllHidden(val hidden: Boolean) : CalendarListAction

    data class OpenDetail(val calendarId: String) : CalendarListAction

    data object CloseDetail : CalendarListAction

    /** A change to one calendar, written at once. */
    sealed interface Change : CalendarListAction {
        val calendarId: String

        data class ToggleHidden(override val calendarId: String) : Change

        data class Rename(override val calendarId: String, val name: String) : Change

        data class SetColor(override val calendarId: String, val color: String) : Change

        data class SetNotify(override val calendarId: String, val notify: Boolean) : Change

        /** An account calendar shows the provider's colour again instead of the one set here. */
        data class UseRemoteColor(override val calendarId: String) : Change
    }

    /** Adds a calendar with [name] and the first colour that no calendar has yet, and opens its settings. */
    data class Add(val name: String) : CalendarListAction

    data class RequestDelete(val calendarId: String) : CalendarListAction

    data object ConfirmDelete : CalendarListAction

    data object CancelDelete : CalendarListAction

    data object OpenSleep : CalendarListAction

    data object DismissProblem : CalendarListAction
}

sealed interface CalendarListEffect {
    /** The sleep settings, which the Sleep calendar's info button opens. */
    data object OpenSleep : CalendarListEffect
}
