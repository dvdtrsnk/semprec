package cz.semprec.app.presentation

import cz.semprec.app.core.FailureKind

enum class TrashPhase { LOADING, CONTENT, ERROR }

/** What the trash lists: the deleted items, or the deleted databases. */
enum class TrashTab { ITEMS, DATABASES }

/** A deleted item; [daysLeft] is the number of days until it is deleted for good. */
data class TrashItemRow(
    val id: String,
    val title: String,
    val databaseKey: String?,
    val databaseName: String,
    val deletedAt: String,
    val daysLeft: Int,
)

/** A deleted database with the items it holds; [daysLeft] is `null` while it has no deadline. */
data class TrashDatabaseRow(
    val id: String,
    val name: String,
    val itemCount: Int,
    val archivedAt: String,
    val daysLeft: Int?,
)

/**
 * The trash. Only the list of the open [tab] is read; [selected] holds ids of that list while [selecting]. [working]
 * is true while a restore runs; [writeFailure] is the last restore that failed.
 */
data class TrashState(
    val phase: TrashPhase = TrashPhase.LOADING,
    val failure: FailureKind? = null,
    val tab: TrashTab = TrashTab.ITEMS,
    val items: List<TrashItemRow> = emptyList(),
    val databases: List<TrashDatabaseRow> = emptyList(),
    val totalItems: Int = 0,
    val hasMore: Boolean = false,
    val loadingMore: Boolean = false,
    val selecting: Boolean = false,
    val selected: List<String> = emptyList(),
    val working: Boolean = false,
    val writeFailure: Failed? = null,
)

sealed interface TrashAction {
    data object Retry : TrashAction

    data class SelectTab(val tab: TrashTab) : TrashAction

    data object LoadMore : TrashAction

    /** Starts or ends choosing several rows; ending it forgets the choice. */
    data object ToggleSelecting : TrashAction

    data class Toggle(val id: String) : TrashAction

    data object SelectAll : TrashAction

    /** Restores one row of the open list. */
    data class Restore(val id: String) : TrashAction

    data object RestoreSelected : TrashAction

    data object DismissFailure : TrashAction
}

/** What a restore reports: how many were restored, how many the server refused, and what the first one came back as. */
sealed interface TrashEffect {
    data class Restored(val restored: Int, val refused: Int, val databaseName: String?) : TrashEffect
}
