package cz.semprec.app.data

import cz.semprec.app.core.FailureKind
import cz.semprec.app.core.StoredSession
import cz.semprec.app.domain.BlobContent
import cz.semprec.app.domain.CollectionDatabase
import cz.semprec.app.domain.CollectionItem
import cz.semprec.app.domain.CollectionPage
import cz.semprec.app.domain.CollectionQuery
import cz.semprec.app.domain.CollectionReads
import cz.semprec.app.domain.CollectionSchema
import cz.semprec.app.domain.DeleteImpact
import cz.semprec.app.domain.FacetResult
import cz.semprec.app.domain.PageContent
import cz.semprec.app.domain.RelatedCollection
import cz.semprec.app.domain.RepositoryResult
import io.ktor.http.HttpMethod
import io.ktor.http.encodeURLPathPart
import kotlinx.serialization.json.JsonObject

/**
 * The reads of the generic item API over the signed-in person's [api]. The schema is kept after the first read, for
 * that session only: another person, or another server, reads it again.
 */
class HttpCollectionReads(private val api: AuthenticatedApi) : CollectionReads {
    private var cached: Pair<StoredSession, CollectionSchema>? = null

    override suspend fun schema(): RepositoryResult<CollectionSchema> {
        val kept = cached
        val fresh = kept != null && kept.first == api.session()
        return if (fresh) RepositoryResult.Content(kept.second) else refreshSchema()
    }

    override suspend fun refreshSchema(): RepositoryResult<CollectionSchema> {
        val session = api.session()
        return when (val result = api.send(HttpMethod.Get, "/api/schema").decode<SchemaDto>()) {
            is RepositoryResult.Failure -> result
            is RepositoryResult.Content -> {
                val schema = result.value.toDomain()
                if (session != null) cached = session to schema
                RepositoryResult.Content(schema)
            }
        }
    }

    override suspend fun query(
        database: CollectionDatabase,
        query: CollectionQuery,
    ): RepositoryResult<CollectionPage> {
        val body = CollectionFilters.queryBody(database, query)
        val path = "/api/databases/${database.id.encodeURLPathPart()}/query"
        return when (val result = api.send(HttpMethod.Post, path, body = body.toString()).decode<ItemPageDto>()) {
            is RepositoryResult.Failure -> result
            is RepositoryResult.Content -> RepositoryResult.Content(result.value.toDomain(database))
        }
    }

    override suspend fun facets(
        database: CollectionDatabase,
        query: CollectionQuery,
        propertyKeys: List<String>,
    ): RepositoryResult<List<FacetResult>> {
        val body: JsonObject = CollectionFilters.facetsBody(database, query, propertyKeys)
        val path = "/api/databases/${database.id.encodeURLPathPart()}/facets"
        return when (val result = api.send(HttpMethod.Post, path, body = body.toString()).decode<FacetsDto>()) {
            is RepositoryResult.Failure -> result
            is RepositoryResult.Content -> RepositoryResult.Content(result.value.toDomain())
        }
    }

    override suspend fun item(itemId: String, expand: List<String>): RepositoryResult<CollectionItem> {
        val schema = when (val loaded = schema()) {
            is RepositoryResult.Failure -> return loaded
            is RepositoryResult.Content -> loaded.value
        }
        val query = buildList {
            add("include" to "links,derived,relations")
            expand.forEach { add("relations.$it" to "") }
        }
        val response = api.send(HttpMethod.Get, "/api/items/${itemId.encodeURLPathPart()}", query = query)
        return when (val result = response.decode<ItemDto>()) {
            is RepositoryResult.Failure -> result
            is RepositoryResult.Content -> result.value.decodeIn(schema)
        }
    }

    override suspend fun related(itemId: String): RepositoryResult<List<RelatedCollection>> {
        val path = "/api/items/${itemId.encodeURLPathPart()}/related"
        return when (val result = api.send(HttpMethod.Get, path).decode<List<RelatedDto>>()) {
            is RepositoryResult.Failure -> result
            is RepositoryResult.Content -> RepositoryResult.Content(result.value.map(RelatedDto::toDomain))
        }
    }

    override suspend fun deleteImpact(itemId: String): RepositoryResult<DeleteImpact> {
        val path = "/api/items/${itemId.encodeURLPathPart()}/delete-impact"
        return when (val result = api.send(HttpMethod.Get, path).decode<DeleteImpactDto>()) {
            is RepositoryResult.Failure -> result
            is RepositoryResult.Content -> RepositoryResult.Content(result.value.toDomain())
        }
    }

    override suspend fun page(itemId: String): RepositoryResult<PageContent> {
        val path = "/api/items/${itemId.encodeURLPathPart()}/page.md"
        return when (val response = api.send(HttpMethod.Get, path)) {
            is ApiResponse.Failure -> RepositoryResult.Failure(response.kind)
            is ApiResponse.Success -> response.etag?.trim('"')
                ?.let { RepositoryResult.Content(PageContent(response.body, it)) }
                ?: RepositoryResult.Failure(FailureKind.INVALID_DATA)
        }
    }

    override suspend fun blob(blobId: String): RepositoryResult<BlobContent> =
        when (val response = api.download("/api/blobs/${blobId.encodeURLPathPart()}")) {
            is ApiBytesResponse.Failure -> RepositoryResult.Failure(response.kind)
            is ApiBytesResponse.Success -> RepositoryResult.Content(BlobContent(response.mimeType, response.bytes))
        }
}

/** Decodes an item by the database it belongs to; an item of a database the schema lacks is unreadable. */
internal fun ItemDto.decodeIn(schema: CollectionSchema): RepositoryResult<CollectionItem> =
    schema.databaseById(databaseId)?.let { RepositoryResult.Content(toDomain(it)) }
        ?: RepositoryResult.Failure(FailureKind.INVALID_DATA)
