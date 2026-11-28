package cz.alldots.app.domain

import cz.alldots.app.core.AccountRestoreStatus

/**
 * An item the person deleted that can still be restored. [databaseKey] and [databaseName] say what it was;
 * [daysLeft] is the number of calendar days until it is deleted for good.
 */
data class AccountTrashItem(
    val id: String,
    val title: String,
    val databaseKey: String?,
    val databaseName: String,
    val deletedAt: String,
    val daysLeft: Int,
)

/** A deleted database that can be restored with all its items; [daysLeft] is `null` while it has no deadline. */
data class AccountTrashDatabase(
    val id: String,
    val name: String,
    val itemCount: Int,
    val archivedAt: String,
    val daysLeft: Int?,
)

/** A page of the trash: [totalCount] is every item, [nextCursor] is `null` on the last page. */
data class AccountTrashPage(val items: List<AccountTrashItem>, val totalCount: Int, val nextCursor: String?)

data class AccountRestoreResult(val id: String, val status: AccountRestoreStatus)

interface AccountTrashRepository {
    suspend fun items(cursor: String?): RepositoryResult<AccountTrashPage>

    suspend fun databases(): RepositoryResult<List<AccountTrashDatabase>>

    /** Restores the items and the databases with the given ids in one request. */
    suspend fun restore(itemIds: List<String>, databaseIds: List<String>): RepositoryResult<List<AccountRestoreResult>>
}
