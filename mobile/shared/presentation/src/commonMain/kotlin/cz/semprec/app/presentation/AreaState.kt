package cz.semprec.app.presentation

import cz.semprec.app.core.FailureKind
import cz.semprec.app.core.ItemKind

enum class AreaPhase { LOADING, CONTENT, ERROR }

/** A task or an event coming up in the area; [date] is `yyyy-MM-dd` and the times are `HH:mm`. */
data class AreaUpcomingItem(
    val kind: ItemKind,
    val id: String,
    val title: String,
    val date: String?,
    val timeFrom: String?,
    val timeTo: String?,
    val projectTitle: String?,
    val projectColor: String?,
)

/** A collection connected to the area; [icon] and [color] are the database's own. */
data class AreaRelatedItem(
    val databaseId: String,
    val databaseKey: String?,
    val name: String,
    val icon: String?,
    val color: String?,
    val count: Int,
    val filterJson: String?,
)

/**
 * One area. [icon] and [color] are the stored values the app maps to a symbol and a tile color. A failed load leaves
 * the screen an error; a failed write of [active] is [writeFailure] and the switch keeps what the server holds.
 */
data class AreaState(
    val phase: AreaPhase = AreaPhase.LOADING,
    val failure: FailureKind? = null,
    val name: String = "",
    val color: String? = null,
    val icon: String? = null,
    val active: Boolean = true,
    val activeSaving: Boolean = false,
    val tasksToday: Int = 0,
    val tasksOpen: Int = 0,
    val eventsSoon: Int = 0,
    val upcoming: List<AreaUpcomingItem> = emptyList(),
    val related: List<AreaRelatedItem> = emptyList(),
    val writeFailure: Failed? = null,
)

sealed interface AreaAction {
    data object Retry : AreaAction

    /** Reloads in place; the content stays on screen. */
    data object Refresh : AreaAction

    /** Opens the tasks of the area: only those due today, or every open one. */
    data class OpenTasks(val todayOnly: Boolean) : AreaAction

    /** Opens the Podrobnosti of a task or an event of [upcoming]; an unknown id is ignored. */
    data class OpenUpcoming(val id: String) : AreaAction

    /** Opens the collection [databaseId] of the related rows; an unknown id is ignored. */
    data class OpenRelated(val databaseId: String) : AreaAction

    data object OpenNotes : AreaAction

    data class SetActive(val on: Boolean) : AreaAction

    data object DismissFailure : AreaAction
}

/** Where the area asks the app to go. */
sealed interface AreaEffect {
    data class OpenTasks(val todayOnly: Boolean) : AreaEffect
    data class OpenDetails(val kind: ItemKind, val id: String) : AreaEffect
    data class OpenCollection(val target: CollectionTarget) : AreaEffect

    /** The mail threads of the area. */
    data object OpenMail : AreaEffect

    data object OpenNotes : AreaEffect
}
