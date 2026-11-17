package cz.semprec.app.domain

/** The counts and ids of the overview that the server assembles in one read. */
data class OverviewSummary(
    val inboxPending: Int,
    val mailUnread: Int,
    val tasksToday: Int,
    val problemCount: Int,
    val journalTodayItemId: String?,
)

/** An area with the number of its active projects; [position] orders areas, [active] hides an archived one. */
data class OverviewArea(
    val id: String,
    val name: String,
    val color: String?,
    val icon: String?,
    val position: Double?,
    val active: Boolean,
    val activeProjectCount: Int,
)

/** A project of the overview; [status] is the stored key (`inProgress`, `longTerm`, `done`, `archived`). */
data class OverviewProject(
    val id: String,
    val name: String,
    val color: String?,
    val areaName: String?,
    val status: String?,
    val pinned: Boolean,
    val pinnedOrder: Double?,
)

/** A collection (a database the person browses) with its item count and how the server wants it listed. */
data class OverviewCollection(
    val databaseId: String,
    val ownerModuleId: String,
    val name: String,
    val icon: String?,
    val color: String?,
    val itemCount: Int,
    val order: Int?,
    val clientVisible: Boolean,
    val hidden: Boolean,
)

/** Everything the overview shows. */
data class Overview(
    val summary: OverviewSummary,
    val areas: List<OverviewArea>,
    val projects: List<OverviewProject>,
    val collections: List<OverviewCollection>,
)

/** Reads the overview from the server. */
interface OverviewRepository {
    suspend fun load(): RepositoryResult<Overview>
}
