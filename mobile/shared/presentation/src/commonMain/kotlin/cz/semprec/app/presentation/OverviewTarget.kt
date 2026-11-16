package cz.semprec.app.presentation

/**
 * Where a row of the overview leads. The screen raises one as the effect of [OverviewAction.Open]; the app decides
 * which screen shows it.
 */
sealed interface OverviewTarget {
    data object Inbox : OverviewTarget
    data object Mail : OverviewTarget
    data object Recordings : OverviewTarget
    data object Tasks : OverviewTarget
    data object Finance : OverviewTarget
    data object Profile : OverviewTarget

    /** The journal of today; [itemId] is the entry of today, `null` while there is none yet. */
    data class Journal(val itemId: String?) : OverviewTarget

    data class Area(val id: String) : OverviewTarget
    data class Project(val id: String) : OverviewTarget
    data class Collection(val ownerModuleId: String, val databaseId: String) : OverviewTarget
}
