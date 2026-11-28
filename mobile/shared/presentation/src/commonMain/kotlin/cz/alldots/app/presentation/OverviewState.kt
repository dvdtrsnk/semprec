package cz.alldots.app.presentation

import cz.alldots.app.core.FailureKind

enum class OverviewPhase { LOADING, CONTENT, ERROR }

/** A pinned project row; [status] is the stored key (`inProgress`, `longTerm`, `done`, `archived`). */
data class OverviewProjectItem(
    val id: String,
    val name: String,
    val color: String?,
    val status: String?,
)

/** A collection row; [ownerModuleId] says which collection it is, [icon] and [color] come from the database. */
data class OverviewCollectionItem(
    val databaseId: String,
    val ownerModuleId: String,
    val name: String,
    val icon: String?,
    val color: String?,
)

/**
 * The overview. [accountEmail] and [accountName] are who is signed in (the profile button shows the initials
 * of the name, or of the e-mail when the account has no name); [problemCount] is the
 * number of problems with Semp (the profile button shows a dot when there are any). [refreshing] is `true` while a
 * pull to refresh reloads the content that is shown; a refresh that fails leaves that content as it was.
 */
data class OverviewState(
    val phase: OverviewPhase = OverviewPhase.LOADING,
    val failure: FailureKind? = null,
    val refreshing: Boolean = false,
    val accountEmail: String? = null,
    val accountName: String? = null,
    val inboxPending: Int = 0,
    val mailUnread: Int = 0,
    val problemCount: Int = 0,
    val projects: List<OverviewProjectItem> = emptyList(),
    val collections: List<OverviewCollectionItem> = emptyList(),
)
