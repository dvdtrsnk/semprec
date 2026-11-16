package cz.semprec.app.data

import cz.semprec.app.core.AccountRestoreStatus
import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.AccountRestoreResult
import cz.semprec.app.domain.AccountTrashDatabase
import cz.semprec.app.domain.AccountTrashItem
import cz.semprec.app.domain.AccountTrashPage
import cz.semprec.app.domain.AccountTrashRepository
import cz.semprec.app.domain.CollectionReads
import cz.semprec.app.domain.CollectionSchema
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.map
import cz.semprec.app.domain.then
import io.ktor.http.HttpMethod
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * The trash: `GET /api/trash/items` and `/databases`, and `POST /api/trash/restore`. An item has no title of its own
 * on the wire: it is the value of the title property its database declares, so the schema names it.
 */
class HttpAccountTrashRepository(
    private val api: AuthenticatedApi,
    private val reads: CollectionReads,
) : AccountTrashRepository {

    override suspend fun items(cursor: String?): RepositoryResult<AccountTrashPage> {
        val query = listOfNotNull("limit" to PAGE_SIZE, cursor?.let { "cursor" to it })
        return api.send(HttpMethod.Get, "/api/trash/items", query).decode<AccountTrashItemsDto>().then { dto ->
            reads.schema().map { schema ->
                AccountTrashPage(dto.items.map { it.toItem(schema) }, dto.totalCount, dto.nextCursor)
            }
        }
    }

    override suspend fun databases(): RepositoryResult<List<AccountTrashDatabase>> =
        api.send(HttpMethod.Get, "/api/trash/databases").decode<AccountTrashDatabasesDto>().map { dto ->
            dto.databases.map {
                AccountTrashDatabase(it.id, it.name.orEmpty(), it.liveItemCount, it.archivedAt, it.daysLeft)
            }
        }

    override suspend fun restore(
        itemIds: List<String>,
        databaseIds: List<String>,
    ): RepositoryResult<List<AccountRestoreResult>> {
        if (itemIds.isEmpty() && databaseIds.isEmpty()) return RepositoryResult.Failure(FailureKind.REJECTED)
        val body = buildJsonObject {
            if (itemIds.isNotEmpty()) put("itemIds", JsonArray(itemIds.map(::JsonPrimitive)))
            if (databaseIds.isNotEmpty()) put("databaseIds", JsonArray(databaseIds.map(::JsonPrimitive)))
        }
        return api.send(HttpMethod.Post, "/api/trash/restore", body = body.toString())
            .decode<AccountRestoreDto>()
            .map { dto -> dto.results.map { AccountRestoreResult(it.id, it.status.toStatus()) } }
    }

    private companion object {
        const val PAGE_SIZE = "50"
    }
}

private fun String.toStatus(): AccountRestoreStatus = when (this) {
    "restored" -> AccountRestoreStatus.RESTORED
    "database_archived" -> AccountRestoreStatus.DATABASE_ARCHIVED
    "conflict" -> AccountRestoreStatus.CONFLICT
    else -> AccountRestoreStatus.NOT_FOUND
}

private fun AccountTrashRowDto.toItem(schema: CollectionSchema): AccountTrashItem {
    val database = schema.databaseById(databaseId)
    val titleKey = database?.title?.key
    val title = page?.title ?: titleKey?.let { item.properties.text(it) }.orEmpty()
    return AccountTrashItem(
        id = item.id,
        title = title,
        databaseKey = databaseKey,
        databaseName = databaseName ?: database?.name.orEmpty(),
        deletedAt = deletedAt,
        daysLeft = daysLeft,
    )
}
